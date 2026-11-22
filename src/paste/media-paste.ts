/**
 * The media paste hook (paste plugin v3, D4), priority 90.
 *
 * Three cases:
 * 1. A dropped media path (or paths) gives `insert` with the `[Image #id …]`
 *    (or other media) token, through {@link mediaPasteInterceptor}. On Linux,
 *    a blank paste with an image on the clipboard also gives a sync `insert`.
 * 2. A blank text with no sync image gives `defer(() => clipboardImageToken())`
 *    (J1). `clipboardImageToken` keeps the `media.clipboard_failed` warning and
 *    the `acceptOrWarn` gate (`media.rejected`).
 * 3. Any other text gives `null`, so the next hook (or the literal insert)
 *    gets it.
 *
 * @module paste/media-paste
 */

import type {
  Diagnostics,
  MediaRegistry,
  SyntheticTextResolver,
} from "@minimal-agent/core/host-kit/media"

import type { ClipboardImageResult } from "./clipboard.ts"
import { clipboardImageToken } from "./clipboard-token.ts"
import type { PasteHook, PasteOutcome } from "./paste-hooks.ts"
import { mediaPasteInterceptor } from "./paste-intercept.ts"

/** The priority of the media hook. Plugin hooks are clamped below it (0..80). */
export const MEDIA_PASTE_PRIORITY = 90

/** Options for {@link createMediaPasteHook}. All are for tests or host wiring. */
export interface MediaPasteHookOptions {
  /** The media registry. Default: the session registry. */
  registry?: () => MediaRegistry | undefined
  /** The diagnostics handle. Default: the process bus. */
  diagnostics?: Diagnostics
  /** The plugin text resolver for the rejection message. */
  text?: SyntheticTextResolver
  /** The active model id, for the provider media gate. */
  modelId?: () => string | undefined
  /** The sync interceptor (tests). Default: {@link mediaPasteInterceptor}. */
  intercept?: typeof mediaPasteInterceptor
  /** The async clipboard image reader (tests). Default: the native reader. */
  readImage?: () => Promise<ClipboardImageResult>
}

/**
 * A cheap, lossless pre-check: a media drop starts with an absolute path, a
 * quote, a `file://` URL or a backslash escape. Prose fails here, so a large
 * text paste is never tokenized.
 */
function mayBeDrop(text: string): boolean {
  const m = /\S/.exec(text)
  if (!m) return false
  const ch = text[m.index]
  return ch === "/" || ch === "~" || ch === "'" || ch === '"' || ch === "f" || ch === "\\"
}

/** Build the media paste hook. */
export function createMediaPasteHook(opts: MediaPasteHookOptions = {}): PasteHook {
  const intercept = opts.intercept ?? mediaPasteInterceptor
  const registry = () => opts.registry?.()
  const modelId = () => opts.modelId?.()
  return {
    id: "media",
    priority: MEDIA_PASTE_PRIORITY,
    onPaste: (ev): PasteOutcome | null => {
      const blank = !/\S/.test(ev.text)
      if (!blank && !mayBeDrop(ev.text)) return null
      const token = intercept(ev.text, registry(), opts.diagnostics, opts.text, modelId())
      if (token != null) return { kind: "insert", text: token }
      if (!blank) return null
      return {
        kind: "defer",
        // `undefined` arguments take the defaults (session registry, process
        // bus, native reader).
        run: () =>
          clipboardImageToken(registry(), opts.diagnostics, opts.text, modelId(), opts.readImage),
      }
    },
  }
}
