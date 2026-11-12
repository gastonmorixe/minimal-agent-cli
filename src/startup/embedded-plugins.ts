/**
 * Embedded plugins of a compiled binary, and the hidden `__run` dispatch.
 *
 * `src/index.ts` imports the table as `#embedded-plugins`. From source that
 * is the empty stub (`src/generated/embedded-plugins.empty.ts`), so nothing
 * here changes a dev run. A binary built by `scripts/compile.ts` gets the
 * generated table of every first-party plugin.
 *
 * `<binary> __run <plugin-id>/<script> [args]` runs one embedded entry
 * script (the `scripts` map of a manifest). Core `selfSpawn().script()`
 * builds that argv for the background runner, fetch and speak backends,
 * and the chrome-cdp daemon. Only a script id is accepted, never a path:
 * `findEmbeddedScript` validates the id against `SCRIPT_ID_RE` and the
 * registered table. The id stays a literal argv word (`argv[3]`), which
 * the chrome-cdp `pgrep -f` pattern relies on. Env and stdio pass through
 * untouched, and `BUN_BE_BUN` is never set here.
 *
 * @module startup/embedded-plugins
 */

import {
  type EmbeddedPluginTable,
  findEmbeddedScript,
  pruneEmbeddedCache,
  registerEmbeddedPlugins,
} from "@minimal-agent/core/host-kit/embedded-plugins"
import { RUN_SCRIPT_ARG } from "@minimal-agent/core/plugin-api/utils/self-spawn"

/** Exit code for a bad `__run` call (sysexits `EX_USAGE`). */
export const RUN_USAGE_EXIT = 64

/** Exit code when an embedded script has no `main` export (`EX_SOFTWARE`). */
export const RUN_SOFTWARE_EXIT = 70

/** True when the table carries at least one package. */
export function tableHasPackages(table: EmbeddedPluginTable): boolean {
  return Object.keys(table.packages).length > 0
}

/**
 * Register `table` with core when it has packages. Returns whether it did.
 * The extract cache root is read lazily from `MINIMAL_AGENT_HOME` / `HOME`,
 * so this is safe before the agent home is published: the publish writes
 * the same value core would resolve.
 *
 * @param table - The `#embedded-plugins` table.
 * @param prune - Also remove the extract dirs of other builds.
 */
export function registerEmbeddedTable(table: EmbeddedPluginTable, prune: boolean): boolean {
  if (!tableHasPackages(table)) return false
  registerEmbeddedPlugins(table)
  if (prune) {
    try {
      pruneEmbeddedCache()
    } catch {
      // A read-only or racing cache dir must not block startup.
    }
  }
  return true
}

/** The `__run` request in `argv` (`process.argv` layout), or undefined. */
export function runRequest(argv: readonly string[]): { id: string; args: string[] } | undefined {
  if (argv[2] !== RUN_SCRIPT_ARG) return undefined
  return { id: argv[3] ?? "", args: argv.slice(4) }
}

/** The process seams of {@link runEmbeddedScript}. Tests pass fakes. */
export interface RunIo {
  readonly stderr: (text: string) => void
  /** Look up a script thunk. Default: core `findEmbeddedScript`. */
  readonly find?: (id: string) => (() => Promise<unknown>) | undefined
}

/**
 * Run one embedded script. Resolves to the exit code, or `undefined` when
 * the script asked to stay alive (`main` resolved `undefined`, e.g. the
 * chrome-cdp server once it listens).
 *
 * @param id - The script id, `<plugin-id>/<script>`.
 * @param args - The script's own argv (after the id).
 * @param standalone - True in a compiled binary. From source `__run` is
 *   not supported (dev spawns the `.ts` file directly) and exits 64.
 * @param io - stderr sink and the lookup seam.
 */
export async function runEmbeddedScript(
  id: string,
  args: readonly string[],
  standalone: boolean,
  io: RunIo,
): Promise<number | undefined> {
  if (!standalone) {
    io.stderr(
      `minimal-agent: ${RUN_SCRIPT_ARG} works only in a compiled binary; from source run the script file with bun\n`,
    )
    return RUN_USAGE_EXIT
  }
  const thunk = (io.find ?? findEmbeddedScript)(id)
  if (thunk === undefined) {
    io.stderr(
      `minimal-agent: unknown embedded script ${JSON.stringify(id)} (want <plugin-id>/<script> from a manifest "scripts" map)\n`,
    )
    return RUN_USAGE_EXIT
  }
  const mod = (await thunk()) as { main?: unknown }
  if (typeof mod.main !== "function") {
    io.stderr(`minimal-agent: embedded script ${JSON.stringify(id)} has no main(argv) export\n`)
    return RUN_SOFTWARE_EXIT
  }
  const result: unknown = await (mod.main as (argv: string[]) => unknown)([...args])
  if (result === undefined) return undefined
  return typeof result === "number" && Number.isInteger(result) ? result : 0
}
