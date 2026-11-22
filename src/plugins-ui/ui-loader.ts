/**
 * The CLI plugin UI loader (spec S35).
 *
 * Core loads only the `headless` part of a plugin manifest (S31). This
 * loader reads the `ui` part of each plugin that core accepted and loads
 * its entries: one optional `setup` module (S41) and live-area slots.
 * The setup module runs once per plugin, before its slots load. It fills
 * the plugin's style slots from `ctx.tui.kit`.
 *
 * Only this loader grants the `ui.terminal` capability. It sets `ctx.tui`
 * on every call of a `ui` entry. Headless entries (tools, hooks, events,
 * fragments, commands) run in core and never get `ctx.tui`.
 *
 * A flat manifest (no `headless` block) is not supported since S41. This
 * loader logs it and skips its `ui` part.
 *
 * @module plugins-ui/ui-loader
 */

import { join } from "node:path"

import { pluginPackageFor } from "@minimal-agent/core/host-kit/embedded-plugins"

import type {
  LiveAreaHandlerContext,
  ResolvedLiveAreaSlot,
  TerminalUiCapability,
  UiSetupHandler,
} from "@minimal-agent/core/plugin-api/types/plugin"
import { TERMINAL_KIT } from "../terminal-kit/kit.ts"
import { paletteEnvJson } from "../terminal-kit/palette.ts"

import { type CliUiHost, cliUiExtensions, manifestCapabilities } from "./cli-ui-extensions.ts"
import { importPackageModule, resolveLiveAreaSlot } from "./resolve-slot.ts"
import { isObject, parseLiveAreaSlot, parseUiSetup, UiManifestError } from "./ui-manifest.ts"

/** One plugin package that core accepted (`PluginLoader.loadedPackages()`). */
export interface AcceptedPackage {
  readonly id: string
  readonly packageDir: string
}

/**
 * Options for {@link loadPluginUi}. The {@link CliUiHost} fields (`sideband`,
 * `paste`, `chips`, `sid`, `sessionsDir`) give each `ui.setup` the CLI
 * extensions `ctx.paste`, `ctx.chips` and `ctx.log` (paste plugin v3, D3).
 */
export interface LoadPluginUiOptions extends CliUiHost {
  /** Accepted packages, in load order. */
  readonly packages: readonly AcceptedPackage[]
  /** Sink for load problems. */
  readonly logger: (msg: string) => void
  /** The `ui.terminal` capability for each call. Default: {@link terminalUiCapability}. */
  readonly tui?: () => TerminalUiCapability
  /**
   * Import the `ui` entry modules (`setup` and slots). Default: true. With
   * false, the loader reads the manifests only and runs no plugin code. Use false on routes
   * with no live area (host mode, `--prompt`, json).
   */
  readonly importModules?: boolean
}

/** The loaded UI part of every plugin. */
export interface PluginUi {
  /** Live-area slots, in plugin load order, then manifest order. Empty with no import. */
  readonly liveAreaSlots: readonly ResolvedLiveAreaSlot[]
  /** The ids of the valid live-area slots. With no import, the declared ids. */
  readonly slotIds: readonly string[]
}

/** The `ui.terminal` capability: the live terminal width and the host palette. */
export function terminalUiCapability(): TerminalUiCapability {
  return {
    capability: "ui.terminal",
    columns: process.stdout.columns ?? 80,
    paletteJson: paletteEnvJson(),
    kit: TERMINAL_KIT,
  }
}

/** Flat (pre-S31) top-level keys. Core rejects a manifest that has one (S41). */
const FLAT_KEYS: readonly string[] = ["tuis", "liveAreaSlots"]

/** The `ui` block of a manifest, or `undefined` when it has none. */
function uiBlockOf(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const flat = FLAT_KEYS.filter((k) => raw[k] !== undefined)
  if (flat.length > 0) {
    throw new Error(
      `flat manifest keys ${flat.join(", ")} are not supported since S41 (use headless and ui blocks)`,
    )
  }
  const ui = raw.ui
  if (ui === undefined) return undefined
  if (!isObject(ui)) throw new Error("ui must be an object if present")
  for (const k of Object.keys(ui)) {
    if (k !== "setup" && k !== "liveAreaSlots") {
      throw new Error(`unknown ui key: ${JSON.stringify(k)}`)
    }
  }
  return ui
}

/** The raw live-area slot list of a `ui` block. */
function rawSlotsOf(ui: Record<string, unknown> | undefined): unknown[] {
  if (ui?.liveAreaSlots == null) return []
  if (!Array.isArray(ui.liveAreaSlots)) {
    throw new Error("ui.liveAreaSlots must be an array if present")
  }
  return ui.liveAreaSlots as unknown[]
}

/**
 * Run the `ui.setup` module of one plugin (S41). A missing module, a bad
 * export, or a throw is logged. The plugin then paints plain text.
 */
async function runUiSetup(
  raw: unknown,
  pkg: AcceptedPackage,
  manifestPath: string,
  tui: () => TerminalUiCapability,
  logger: (msg: string) => void,
  extensions: () => object,
): Promise<void> {
  try {
    const entry = parseUiSetup(raw, manifestPath)
    if (entry.type !== "module") return
    const source = pluginPackageFor(pkg.packageDir)
    const abs = source.resolve(entry.path)
    const mod = (await importPackageModule(source, entry.path)) as { default?: UiSetupHandler }
    if (typeof mod.default !== "function") {
      logger(`${pkg.packageDir}: ui.setup ${abs} has no default export function`)
      return
    }
    await mod.default({
      ...extensions(),
      tui: tui(),
      pluginId: pkg.id,
      packageDir: pkg.packageDir,
    })
  } catch (e) {
    logger(`${pkg.packageDir}: ui.setup skipped: ${e instanceof Error ? e.message : String(e)}`)
  }
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
  const slotIds: string[] = []
  for (const pkg of opts.packages) {
    const manifestPath = join(pkg.packageDir, "manifest.json")
    let rawSlots: unknown[]
    let ui: Record<string, unknown> | undefined
    let manifestId = pkg.id
    let capabilities: string[] = []
    try {
      // Through the package source, so an embedded package (no manifest
      // on disk) reads the manifest text of the binary.
      const text = pluginPackageFor(pkg.packageDir).readText("manifest.json")
      if (text === null) throw new Error(`cannot read ${manifestPath}`)
      const raw: unknown = JSON.parse(text)
      if (!isObject(raw)) continue
      if (typeof raw.id === "string") manifestId = raw.id
      capabilities = manifestCapabilities(raw)
      ui = uiBlockOf(raw)
      rawSlots = rawSlotsOf(ui)
    } catch (e) {
      opts.logger(
        `${pkg.packageDir}: ui block skipped: ${e instanceof Error ? e.message : String(e)}`,
      )
      continue
    }
    if (ui?.setup !== undefined && opts.importModules !== false) {
      const plugin = { id: manifestId, capabilities }
      await runUiSetup(ui.setup, pkg, manifestPath, tui, opts.logger, () =>
        cliUiExtensions(opts, plugin, opts.logger),
      )
    }
    const seen = new Set<string>()
    for (let i = 0; i < rawSlots.length; i++) {
      try {
        const def = parseLiveAreaSlot(rawSlots[i], i, manifestPath, seen)
        if (opts.importModules === false) {
          slotIds.push(def.id)
          continue
        }
        const resolved = await resolveLiveAreaSlot(def, pkg.id, pkg.packageDir, opts.logger)
        if (resolved) {
          liveAreaSlots.push(grantTui(resolved, tui))
          slotIds.push(def.id)
        }
      } catch (e) {
        const msg = e instanceof UiManifestError || e instanceof Error ? e.message : String(e)
        opts.logger(`${pkg.packageDir}: live-area slot skipped: ${msg}`)
      }
    }
  }
  return { liveAreaSlots, slotIds }
}
