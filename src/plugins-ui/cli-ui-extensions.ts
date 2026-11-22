/**
 * The CLI fields of the `ui.setup` context (paste plugin v3, PLAN 4.3, D3).
 *
 * Core `UiSetupContext` does not change. The CLI adds these fields on top:
 * - `paste.registerHook`: a plugin paste hook on the process paste chain.
 *   The priority is clamped to 0..80, so the media hook (90) runs first. The
 *   hook id gets the plugin id as a prefix.
 * - `chips.register`: a chip label for one inline sideband kind.
 * - `log.warn`: a plugin warning, to the paste diagnostics.
 *
 * A paste event of a plugin gets `sideband` (the loader API) and `files`.
 * `files` is the `sessions:files` API bound to the active sid and to the
 * manifest id. It is present only when the manifest lists `sessions:files`
 * in `capabilities` and a sid exists.
 *
 * @module plugins-ui/cli-ui-extensions
 */

import { createSessionFilesApi } from "@minimal-agent/core/host/session-files"
import { NO_SIDEBAND, type SidebandApi } from "@minimal-agent/core/host/sideband"
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

/** The plugin facts that the extensions read from the raw manifest. */
export interface CliUiPlugin {
  /** The manifest id (the dir name under `<sid>.files/`). */
  readonly id: string
  /** The `capabilities` of the raw manifest. */
  readonly capabilities: readonly string[]
}

/** `priority` clamped to 0..{@link PLUGIN_PASTE_PRIORITY_MAX}. Bad: 0. */
export function clampPluginPriority(priority: number | undefined): number {
  if (typeof priority !== "number" || !Number.isFinite(priority)) return 0
  return Math.min(PLUGIN_PASTE_PRIORITY_MAX, Math.max(0, priority))
}

/** The `capabilities` strings of a raw manifest (none: `[]`). */
export function manifestCapabilities(raw: Record<string, unknown>): string[] {
  const caps = raw.capabilities
  return Array.isArray(caps) ? caps.filter((c): c is string => typeof c === "string") : []
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

/** `api` bound to `sid`. */
function bindFiles(api: SessionFilesApi, sid: string): BoundSessionFiles {
  return {
    create: (name, data) => api.create(sid, name, data),
    stat: (name) => api.stat(sid, name),
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
  const filesFor = (sid: string | undefined): BoundSessionFiles | undefined =>
    api && sid !== undefined ? bindFiles(api, sid) : undefined
  const ext: CliUiExtensions = {}
  const paste = host.paste
  if (paste) {
    ext.paste = {
      registerHook(h) {
        const hook: PasteHook = {
          id: `${plugin.id}:${h.id}`,
          priority: clampPluginPriority(h.priority),
          onPaste(ev) {
            const files = filesFor(ev.sid ?? readSid(host))
            const out = h.onPaste({
              ...ev,
              sideband: host.sideband?.() ?? NO_SIDEBAND,
              ...(files ? { files } : {}),
            })
            if (out == null) return null
            if (typeof out.insert !== "string") throw new Error("result has no insert string")
            return { kind: "insert", text: out.insert }
          },
        }
        return paste.register(hook)
      },
    }
    ext.log = {
      warn: (source, message) => paste.warn(source, message, { plugin: plugin.id }),
    }
  }
  const chips = host.chips
  if (chips) {
    // The store check of a chip: the file `<attrs.id>.txt` of the active
    // sid. One stat call. No files API, no sid, or no string id: true.
    const knownOf = (attrs: Record<string, unknown>): boolean => {
      const files = filesFor(readSid(host))
      if (!files || typeof attrs.id !== "string") return true
      try {
        return files.stat(`${attrs.id}.txt`) !== null
      } catch {
        return true
      }
    }
    ext.chips = {
      register(c) {
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
  return ext
}
