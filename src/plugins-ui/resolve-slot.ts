/**
 * Resolve a validated live-area slot to invocable form (S35). Moved from
 * core with the `ui` block.
 *
 * @module plugins-ui/resolve-slot
 */

import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

import type {
  LiveAreaHandler,
  LiveAreaHandlerContext,
  ManifestLiveAreaSlot,
  ResolvedLiveAreaSlot,
} from "@minimal-agent/core/plugin-api/types/plugin"

import { importPluginModule } from "./plugin-module.ts"

/** Resolve `rel` against the package dir; absolute paths pass through. */
function resolvePath(pkgDir: string, rel: string): string {
  return isAbsolute(rel) ? rel : resolve(pkgDir, rel)
}

/**
 * Resolve a single {@link ManifestLiveAreaSlot} to invocable form.
 *
 * Module handlers must `export default` a {@link LiveAreaHandler}. The
 * loader applies normalized defaults (position=`"footer"`,
 * refreshMs=60_000, timeoutMs=5000) before invocation so the scheduler
 * never has to second-guess them.
 *
 * Returns `null` (with a logged diagnostic) on missing module / bad
 * default export / missing executable. The plugin's tools and other
 * subscriptions are NOT affected — broken slot ≠ broken plugin.
 */
export async function resolveLiveAreaSlot(
  slot: ManifestLiveAreaSlot,
  pluginId: string,
  packageDir: string,
  logger: (msg: string) => void,
): Promise<ResolvedLiveAreaSlot | null> {
  const definition: ManifestLiveAreaSlot = {
    ...slot,
    position: slot.position ?? "footer",
    refreshMs: slot.refreshMs ?? 60_000,
    timeoutMs: slot.timeoutMs ?? 5000,
    // Pass through verbatim — empty string is a deliberate opt-out;
    // undefined means "no row reserved before first invoke".
    placeholder: slot.placeholder,
    // Normalize undefined/null → empty array so the scheduler can iterate
    // without a null check.
    refreshOn: slot.refreshOn ?? [],
  }

  if (slot.handler.type === "module") {
    const abs = resolvePath(packageDir, slot.handler.path)
    if (!existsSync(abs)) {
      logger(`${packageDir}: live-area slot handler module not found: ${abs}`)
      return null
    }
    let mod: { default?: LiveAreaHandler }
    try {
      mod = (await importPluginModule(abs, packageDir)) as { default?: LiveAreaHandler }
    } catch (e) {
      logger(
        `${packageDir}: failed to import live-area slot handler ${abs}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
      return null
    }
    const fn = mod.default
    if (typeof fn !== "function") {
      logger(`${packageDir}: live-area slot handler ${abs} has no default export function`)
      return null
    }
    return {
      definition,
      pluginId,
      packageDir,
      entryAbsolute: abs,
      invoke: async (ctx: LiveAreaHandlerContext) => {
        const out = await fn(ctx)
        if (out == null) return null
        if (typeof out !== "string") {
          throw new Error(
            `live-area slot "${slot.id}" returned non-string (${typeof out}). Expected string | null`,
          )
        }
        return out
      },
    }
  }

  // subprocess
  const cmd = slot.handler.command
  const exe = cmd[0]
  const exeAbs = isAbsolute(exe) ? exe : resolve(packageDir, exe)
  if (!existsSync(exeAbs)) {
    logger(`${packageDir}: live-area slot executable not found: ${exeAbs}`)
    return null
  }
  return {
    definition,
    pluginId,
    packageDir,
    entryAbsolute: exeAbs,
    invoke: async (ctx: LiveAreaHandlerContext) => {
      const proc = Bun.spawn([exeAbs, ...cmd.slice(1)], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        cwd: ctx.packageDir,
        env: ctx.env,
      })
      const envelope = JSON.stringify({ tick: ctx.tick, cwd: ctx.cwd, env: ctx.env })
      void proc.stdin.write(envelope + "\n")
      void proc.stdin.end()
      const out = await new Response(proc.stdout).text()
      await proc.exited
      const trimmed = out.replace(/\n+$/, "")
      return trimmed.length === 0 ? null : trimmed
    },
  }
}
