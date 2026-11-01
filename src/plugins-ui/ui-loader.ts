/**
 * The CLI plugin UI loader (spec S35).
 *
 * Core loads only the `headless` part of a plugin manifest (S31). This
 * loader reads the `ui` part of each plugin that core accepted and loads
 * its entries. Today a `ui` block holds live-area slots.
 *
 * Only this loader grants the `ui.terminal` capability. It sets `ctx.tui`
 * on every call of a `ui` entry. Headless entries (tools, hooks, events,
 * fragments, commands) run in core and never get `ctx.tui`.
 *
 * Until S41, a legacy flat manifest still has its live-area slots at the
 * top level. This loader reads them with one warning per plugin.
 *
 * @module plugins-ui/ui-loader
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import type {
  LiveAreaHandlerContext,
  ResolvedLiveAreaSlot,
  TerminalUiCapability,
} from "@minimal-agent/core/plugin-api/types/plugin"
import { paletteEnvJson } from "@minimal-agent/core/plugin-api/utils/palette"

import { resolveLiveAreaSlot } from "./resolve-slot.ts"
import { isObject, parseLiveAreaSlot, UiManifestError } from "./ui-manifest.ts"

/** One plugin package that core accepted (`PluginLoader.loadedPackages()`). */
export interface AcceptedPackage {
  readonly id: string
  readonly packageDir: string
}

/** Options for {@link loadPluginUi}. */
export interface LoadPluginUiOptions {
  /** Accepted packages, in load order. */
  readonly packages: readonly AcceptedPackage[]
  /** Sink for load problems and legacy warnings. */
  readonly logger: (msg: string) => void
  /** The `ui.terminal` capability for each call. Default: {@link terminalUiCapability}. */
  readonly tui?: () => TerminalUiCapability
}

/** The loaded UI part of every plugin. */
export interface PluginUi {
  /** Live-area slots, in plugin load order, then manifest order. */
  readonly liveAreaSlots: readonly ResolvedLiveAreaSlot[]
}

/** The `ui.terminal` capability: the live terminal width and the host palette. */
export function terminalUiCapability(): TerminalUiCapability {
  return {
    capability: "ui.terminal",
    columns: process.stdout.columns ?? 80,
    paletteJson: paletteEnvJson(),
  }
}

/** The raw live-area slot list of a manifest: `ui.liveAreaSlots`, else legacy flat. */
function rawSlotsOf(
  raw: Record<string, unknown>,
  id: string,
  logger: (msg: string) => void,
): unknown[] {
  if (raw.headless !== undefined || raw.ui !== undefined) {
    const ui = raw.ui
    if (ui === undefined) return []
    if (!isObject(ui)) throw new Error("ui must be an object if present")
    if (ui.liveAreaSlots == null) return []
    if (!Array.isArray(ui.liveAreaSlots)) {
      throw new Error("ui.liveAreaSlots must be an array if present")
    }
    return ui.liveAreaSlots as unknown[]
  }
  if (raw.liveAreaSlots == null) return []
  if (!Array.isArray(raw.liveAreaSlots))
    throw new Error("liveAreaSlots must be an array if present")
  logger(
    `plugin "${id}": manifest.json has flat liveAreaSlots; move them to the ui block ` +
      "(read until S41)",
  )
  return raw.liveAreaSlots as unknown[]
}

/** Wrap a slot so every call gets `ctx.tui` (the `ui.terminal` grant). */
function grantTui(
  slot: ResolvedLiveAreaSlot,
  tui: () => TerminalUiCapability,
): ResolvedLiveAreaSlot {
  return {
    ...slot,
    invoke: (ctx: LiveAreaHandlerContext) => slot.invoke({ ...ctx, tui: tui() }),
  }
}

/**
 * Load the `ui` part of every accepted package. A bad manifest or a bad
 * entry is logged and skipped. This function never throws.
 */
export async function loadPluginUi(opts: LoadPluginUiOptions): Promise<PluginUi> {
  const tui = opts.tui ?? terminalUiCapability
  const liveAreaSlots: ResolvedLiveAreaSlot[] = []
  for (const pkg of opts.packages) {
    const manifestPath = join(pkg.packageDir, "manifest.json")
    let rawSlots: unknown[]
    try {
      const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"))
      if (!isObject(raw)) continue
      rawSlots = rawSlotsOf(raw, pkg.id, opts.logger)
    } catch (e) {
      opts.logger(
        `${pkg.packageDir}: ui block skipped: ${e instanceof Error ? e.message : String(e)}`,
      )
      continue
    }
    const seen = new Set<string>()
    for (let i = 0; i < rawSlots.length; i++) {
      try {
        const def = parseLiveAreaSlot(rawSlots[i], i, manifestPath, seen)
        const resolved = await resolveLiveAreaSlot(def, pkg.id, pkg.packageDir, opts.logger)
        if (resolved) liveAreaSlots.push(grantTui(resolved, tui))
      } catch (e) {
        const msg = e instanceof UiManifestError || e instanceof Error ? e.message : String(e)
        opts.logger(`${pkg.packageDir}: live-area slot skipped: ${msg}`)
      }
    }
  }
  return { liveAreaSlots }
}
