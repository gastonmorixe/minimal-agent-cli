/**
 * The CLI fields of the `ui.setup` context (paste plugin v3, PLAN 4.3, D3).
 *
 * Core `UiSetupContext` does not change. The CLI adds these fields on top:
 * - `paste.registerHook`: a plugin paste hook on the process paste chain.
 *   The priority is clamped to 0..80, so the media hook (90) runs first. The
 *   hook id gets the plugin id as a prefix.
 *   Present only when the validated manifest `permissions` has `ui:paste`,
 *   because a paste hook reads all pasted text (secrets too).
 * - `chips.register`: a chip label for one inline sideband kind. Only for a
 *   kind that this plugin owns (`sidebandKinds`: declared in its manifest
 *   and given to it by the core registry). Other kinds: no register, one
 *   warning.
 * - `log.warn`: a plugin warning, source `plugin.<id>.<source>`. Every ui
 *   plugin gets it.
 *
 * A paste event of a plugin gets `sideband` (the loader API) and `files`.
 * `files` is the `sessions:files` API bound to the active sid and to the
 * manifest id. It is present only when the validated manifest lists
 * `sessions:files` in `capabilities` and a sid exists.
 *
 * All plugin facts come from the validated manifest
 * (`PluginLoader.loadedPackages()`), never from the raw manifest JSON.
 *
 * @module plugins-ui/cli-ui-extensions
 */

import { createSessionFilesApi } from "@minimal-agent/core/host/session-files"
import { NO_SIDEBAND, type SidebandApi } from "@minimal-agent/core/host/sideband"
import { processDiagnostics } from "@minimal-agent/core/host-kit/media"
import type {
  SessionFileCreate,
  SessionFilesApi,
} from "@minimal-agent/core/plugin-api/types/host-capabilities"

import type { ChipRegistry } from "../paste/chip-registry.ts"
import type { PasteEvent, PasteHook, PasteHookRegistry } from "../paste/paste-hooks.ts"

/** The highest priority of a plugin paste hook. The media hook is 90. */
export const PLUGIN_PASTE_PRIORITY_MAX = 80

/** The capability that gives a plugin `files`. */
export const SESSION_FILES_CAPABILITY = "sessions:files"

/** The manifest permission that gives a ui plugin `ctx.paste`. */
export const UI_PASTE_PERMISSION = "ui:paste"

/** `SessionFilesApi` bound to the active sid and to the plugin id. */
export interface BoundSessionFiles {
  create(name: string, data: string): SessionFileCreate
  stat(name: string): { bytes: number } | null
}

/** The event that a plugin paste hook gets. */
export type PluginPasteEvent = PasteEvent & {
  readonly sideband: SidebandApi
  readonly files?: BoundSessionFiles
}

/** A plugin paste hook, as the plugin gives it. */
export interface PluginPasteHook {
  id: string
  priority?: number
  /**
   * Claim the paste with `{ insert }`, or pass it on with `null`. An empty
   * `insert` is treated as `null` with one warning (never drop content).
   *
   * Known limit: the hook is sync and runs on the editor thread. A hook that
   * never returns blocks the editor. The CLI has no guard for this.
   */
  onPaste(ev: PluginPasteEvent): { insert: string } | null
}

/** A plugin chip label, as the plugin gives it. */
export interface PluginChipDef {
  kind: string
  label(attrs: Record<string, unknown>, known: boolean): string
}

/** The CLI fields on top of the core `UiSetupContext`. */
export interface CliUiExtensions {
  paste?: { registerHook(h: PluginPasteHook): () => void }
  chips?: { register(c: PluginChipDef): () => void }
  log?: { warn(source: string, message: string): void }
}

/** The CLI objects that the extensions use (`LoadPluginUiOptions`). */
export interface CliUiHost {
  /** The loader sideband API. Missing or `undefined`: `NO_SIDEBAND`. */
  readonly sideband?: () => SidebandApi | undefined
  /** The process paste chain. Missing: no `ctx.paste`. */
  readonly paste?: PasteHookRegistry
  /** The process chip registry. Missing: no `ctx.chips`. */
  readonly chips?: ChipRegistry
  /** The lazy active sid. Missing or `undefined`: no `files`. */
  readonly sid?: () => string | undefined
  /** The sessions dir of the CLI session store. Missing: no `files`. */
  readonly sessionsDir?: string
}

/** The plugin facts that the extensions read from the validated manifest. */
export interface CliUiPlugin {
  /** The manifest id (the dir name under `<sid>.files/`). */
  readonly id: string
  /** The validated `capabilities`. */
  readonly capabilities: readonly string[]
  /** The validated `permissions`. */
  readonly permissions: readonly string[]
  /** The sideband kinds that this plugin owns (core registry). */
  readonly sidebandKinds: readonly string[]
}

/** `priority` clamped to 0..{@link PLUGIN_PASTE_PRIORITY_MAX}. Bad: 0. */
export function clampPluginPriority(priority: number | undefined): number {
  if (typeof priority !== "number" || !Number.isFinite(priority)) return 0
  return Math.min(PLUGIN_PASTE_PRIORITY_MAX, Math.max(0, priority))
}

/** Read the sid now. A throw gives `undefined`. */
function readSid(host: CliUiHost): string | undefined {
  try {
    return host.sid?.()
  } catch {
    return undefined
  }
}

/** The files API of one plugin, or `null` when the plugin must not get one. */
function filesApiOf(
  host: CliUiHost,
  plugin: CliUiPlugin,
  logger: (msg: string) => void,
): SessionFilesApi | null {
  if (!plugin.capabilities.includes(SESSION_FILES_CAPABILITY)) return null
  if (!host.sid || host.sessionsDir === undefined) return null
  try {
    return createSessionFilesApi({
      sessionsDir: host.sessionsDir,
      pluginId: plugin.id,
      isOwnedSession: (s) => s === readSid(host),
    })
  } catch (e) {
    logger(`${plugin.id}: no session files: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/** The chip `known` cache of one plugin: key `<sid>\0<attrs.id>`. */
type KnownCache = Map<string, boolean>

const knownKey = (sid: string, id: string): string => `${sid}\0${id}`

/**
 * `api` bound to `sid`. A create of `<id>.txt` that gives "ok" or "exists"
 * sets `known` of (`sid`, `id`) to true, so the chip paint needs no stat.
 */
function bindFiles(api: SessionFilesApi, sid: string, known: KnownCache): BoundSessionFiles {
  return {
    create: (name, data) => {
      const out = api.create(sid, name, data)
      if ((out === "ok" || out === "exists") && name.endsWith(".txt")) {
        known.set(knownKey(sid, name.slice(0, -4)), true)
      }
      return out
    },
    stat: (name) => api.stat(sid, name),
  }
}

/**
 * The `ctx.paste` of one plugin. `ev.sid` is always set by
 * `PasteHookRegistry.event` (the same lazy getter as `host.sid`), so the
 * hook binds `files` to it with no second read.
 */
function pasteExtension(
  host: CliUiHost,
  paste: PasteHookRegistry,
  plugin: CliUiPlugin,
  filesFor: (sid: string | undefined) => BoundSessionFiles | undefined,
): NonNullable<CliUiExtensions["paste"]> {
  return {
    registerHook(h) {
      const id = `${plugin.id}:${h.id}`
      const hook: PasteHook = {
        id,
        priority: clampPluginPriority(h.priority),
        onPaste(ev) {
          const files = filesFor(ev.sid)
          const out = h.onPaste({
            ...ev,
            sideband: host.sideband?.() ?? NO_SIDEBAND,
            ...(files ? { files } : {}),
          })
          if (out == null) return null
          if (typeof out.insert !== "string") throw new Error("result has no insert string")
          if (out.insert === "") {
            paste.warn("paste.hook_empty", `Paste hook ${id} gave an empty insert`, { hook: id })
            return null
          }
          return { kind: "insert", text: out.insert }
        },
      }
      return paste.register(hook)
    },
  }
}

/** The `ctx.chips` of one plugin: only for the kinds that it owns. */
function chipsExtension(
  chips: ChipRegistry,
  plugin: CliUiPlugin,
  knownOf: (attrs: Record<string, unknown>) => boolean,
  warn: (source: string, message: string) => void,
): NonNullable<CliUiExtensions["chips"]> {
  return {
    register(c) {
      if (!plugin.sidebandKinds.includes(c.kind)) {
        warn(
          "chips.kind_not_owned",
          `chip kind ${JSON.stringify(c.kind)} is not owned by ${plugin.id}`,
        )
        return () => {}
      }
      return chips.register({
        kind: c.kind,
        label: (attrs, _body, known) => {
          const a = attrs as Record<string, unknown>
          return c.label(a, known ?? knownOf(a))
        },
      })
    },
  }
}

/**
 * The CLI fields of the setup context of one plugin. The files API is made
 * one time here; each paste binds it to the sid of that paste.
 */
export function cliUiExtensions(
  host: CliUiHost,
  plugin: CliUiPlugin,
  logger: (msg: string) => void,
): CliUiExtensions {
  const api = filesApiOf(host, plugin, logger)
  const known: KnownCache = new Map()
  const filesFor = (sid: string | undefined): BoundSessionFiles | undefined =>
    api && sid !== undefined ? bindFiles(api, sid, known) : undefined
  // The source prefix of core `createPluginLogger`, with `plugin.` in front.
  const sink = host.paste ?? processDiagnostics()
  const warn = (source: string, message: string): void => {
    try {
      sink.warn(`plugin.${plugin.id}.${source}`, message, { plugin: plugin.id })
    } catch {
      // A plugin log must never throw into plugin code.
    }
  }
  const ext: CliUiExtensions = { log: { warn } }
  if (host.paste && plugin.permissions.includes(UI_PASTE_PERMISSION)) {
    ext.paste = pasteExtension(host, host.paste, plugin, filesFor)
  }
  if (host.chips) {
    // The store check of a chip: the file `<attrs.id>.txt` of the active
    // sid. Cached per (sid, id): the plugin's own create sets true; a miss
    // does one stat and keeps its result, so a repaint does no stat. No
    // files API, no sid, or no string id: true.
    const knownOf = (attrs: Record<string, unknown>): boolean => {
      const sid = readSid(host)
      const files = filesFor(sid)
      if (!files || sid === undefined || typeof attrs.id !== "string") return true
      const key = knownKey(sid, attrs.id)
      const hit = known.get(key)
      if (hit !== undefined) return hit
      try {
        const found = files.stat(`${attrs.id}.txt`) !== null
        known.set(key, found)
        return found
      } catch {
        return true
      }
    }
    ext.chips = chipsExtension(host.chips, plugin, knownOf, warn)
  }
  return ext
}
