/**
 * Validation of the `ui` block of a plugin manifest (S35).
 *
 * Core ignores the `ui` block (S31). The CLI validates it here. The checks
 * match the old core checks for live-area slots.
 *
 * @module plugins-ui/ui-manifest
 */

import type {
  ManifestHandlerEntry,
  ManifestLiveAreaSlot,
} from "@minimal-agent/core/plugin-api/types/plugin"

/** Thrown for a malformed `ui` block entry. */
export class UiManifestError extends Error {
  readonly manifestPath: string
  constructor(message: string, manifestPath: string) {
    super(message)
    this.name = "UiManifestError"
    this.manifestPath = manifestPath
  }
}

/** Keep the old error class name in the copied checks. */
const ManifestError = UiManifestError

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/

/** True for a plain JSON object. */
export function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x)
}

/** Read a required non-empty string field. */
function requireString(
  obj: Record<string, unknown>,
  key: string,
  err: (msg: string) => void,
): string {
  if (typeof obj[key] !== "string" || !obj[key]) {
    err(`${key} is required and must be a non-empty string`)
  }
  return obj[key] as string
}

/** Validate a `handler` entry (module or subprocess). */
function parseHandlerEntry(raw: unknown, at: string, manifestPath: string): ManifestHandlerEntry {
  const err = (msg: string) => {
    throw new ManifestError(`${at}.handler: ${msg}`, manifestPath)
  }
  if (!isObject(raw)) err("handler must be an object")
  const obj = raw as Record<string, unknown>
  if (obj.type === "module") {
    if (typeof obj.path !== "string" || !obj.path) err("path is required for module handler")
    if (obj.export != null && obj.export !== "default") {
      err(`only export="default" is supported (got: ${JSON.stringify(obj.export)})`)
    }
    return { type: "module", path: obj.path as string, export: "default" }
  }
  if (obj.type === "subprocess") {
    if (!Array.isArray(obj.command) || obj.command.length === 0) {
      err("command must be a non-empty array for subprocess handler")
    }
    for (const c of obj.command as unknown[]) {
      if (typeof c !== "string") err("command entries must be strings")
    }
    return { type: "subprocess", command: obj.command as string[] }
  }
  err(`unknown handler.type: ${JSON.stringify(obj.type)}`)
  throw new Error("unreachable")
}

/**
 * Validate the `ui.setup` entry (S41). It must be a module handler: the
 * setup runs in the CLI process and fills the plugin's style slots.
 */
export function parseUiSetup(raw: unknown, manifestPath: string): ManifestHandlerEntry {
  const handler = parseHandlerEntry(raw, "ui.setup", manifestPath)
  if (handler.type !== "module") {
    throw new ManifestError("ui.setup.handler: ui.setup must be a module handler", manifestPath)
  }
  return handler
}

/**
 * Validate a single `liveAreaSlots[i]` entry.
 */
export function parseLiveAreaSlot(
  raw: unknown,
  index: number,
  manifestPath: string,
  seenIds: Set<string>,
): ManifestLiveAreaSlot {
  const at = `ui.liveAreaSlots[${index}]`
  const err = (msg: string) => {
    throw new ManifestError(`${at}: ${msg}`, manifestPath)
  }
  if (!isObject(raw)) err("live-area slot must be an object")
  const obj = raw as Record<string, unknown>

  const id = requireString(obj, "id", err)
  if (!ID_RE.test(id)) err(`live-area slot id must match ${ID_RE}`)
  if (seenIds.has(id)) err(`duplicate live-area slot id: ${id}`)
  seenIds.add(id)

  const handler = parseHandlerEntry(obj.handler, at, manifestPath)

  let position: "header" | "footer" | undefined
  if (obj.position != null) {
    if (obj.position !== "header" && obj.position !== "footer") {
      err(`position must be "header" or "footer" (got: ${JSON.stringify(obj.position)})`)
    }
    position = obj.position as "header" | "footer"
  }

  let order: number | undefined
  if (obj.order != null) {
    if (typeof obj.order !== "number" || !Number.isFinite(obj.order)) {
      err(`order must be a finite number (got: ${JSON.stringify(obj.order)})`)
    }
    order = obj.order as number
  }

  let refreshMs: number | undefined
  if (obj.refreshMs != null) {
    if (typeof obj.refreshMs !== "number" || !Number.isFinite(obj.refreshMs) || obj.refreshMs < 0) {
      err(`refreshMs must be a non-negative number (got: ${JSON.stringify(obj.refreshMs)})`)
    }
    refreshMs = obj.refreshMs as number
  }

  let timeoutMs: number | undefined
  if (obj.timeoutMs != null) {
    if (typeof obj.timeoutMs !== "number" || !Number.isFinite(obj.timeoutMs) || obj.timeoutMs < 0) {
      err(`timeoutMs must be a non-negative number (got: ${JSON.stringify(obj.timeoutMs)})`)
    }
    timeoutMs = obj.timeoutMs as number
  }

  let placeholder: string | undefined
  if (obj.placeholder != null) {
    if (typeof obj.placeholder !== "string") {
      err(`placeholder must be a string (got: ${JSON.stringify(obj.placeholder)})`)
    }
    placeholder = obj.placeholder as string
  }

  let refreshOn: string[] | undefined
  if (obj.refreshOn != null) {
    if (!Array.isArray(obj.refreshOn)) err("refreshOn must be an array of event names if present")
    const seen = new Set<string>()
    refreshOn = []
    for (let i = 0; i < (obj.refreshOn as unknown[]).length; i++) {
      const e = (obj.refreshOn as unknown[])[i]
      if (typeof e !== "string" || e.length === 0) {
        err(`refreshOn[${i}] must be a non-empty string event name`)
      }
      const name = e as string
      if (/\s/.test(name)) {
        err(`refreshOn[${i}] must not contain whitespace (got: ${JSON.stringify(name)})`)
      }
      if (seen.has(name)) {
        err(`refreshOn[${i}] duplicate event name: ${JSON.stringify(name)}`)
      }
      seen.add(name)
      refreshOn.push(name)
    }
  }

  for (const k of Object.keys(obj)) {
    if (
      ![
        "id",
        "handler",
        "position",
        "order",
        "refreshMs",
        "timeoutMs",
        "placeholder",
        "refreshOn",
      ].includes(k)
    ) {
      err(`unknown live-area slot key: ${JSON.stringify(k)}`)
    }
  }

  return {
    id,
    handler,
    position,
    ...(order !== undefined ? { order } : {}),
    refreshMs,
    timeoutMs,
    placeholder,
    refreshOn,
  }
}
