/**
 * Display-width text helpers for one-shot CLI tables: fit, pad, left
 * truncation and the cwd formatter. All measurement is in terminal cells
 * (CJK and emoji are two cells), never in UTF-16 units.
 *
 * @module ui/format/text
 */

import {
  codePointWidth,
  displayWidth,
  stripAnsi,
  truncateDisplayWidth,
} from "@minimal-agent/core/plugin-api/utils/term-width"

/** The one-cell truncation mark. */
export const ELLIPSIS = "…"

/**
 * OSC sequences (for example OSC 8 hyperlinks): `ESC ]` or C1 `0x9d`, then
 * the payload, then BEL, `ESC \\` or C1 ST `0x9c`. A terminal also ends an
 * OSC at the next ESC or at the end of the text, so the match does too.
 */
const OSC_RE = /(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c|(?=\u001b)|$)/gu

/**
 * Bidi embedding, override and isolate controls (U+202A-202E,
 * U+2066-2069). They have no width but can reorder the text after them.
 */
const BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/gu

/**
 * Make one-line plain text: remove OSC (hyperlinks), then SGR/CSI, then
 * bidi controls; change tabs, newlines and other C0/C1 control characters
 * to one space. A control character has no width, so it must not reach a
 * cell that the renderer measures.
 */
export function toCellText(text: string): string {
  return stripAnsi(text.replace(OSC_RE, ""))
    .replace(BIDI_RE, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
}

/** Truncate on the right to `width` cells, with `…` when text is cut. */
export function fitDisplayWidth(text: string, width: number): string {
  if (width <= 0) return ""
  return truncateDisplayWidth(text, width, ELLIPSIS)
}

/** The longest start of `text` that has at most `width` cells. No ellipsis. */
export function sliceDisplayWidth(text: string, width: number): string {
  let out = ""
  let used = 0
  for (const ch of text) {
    const w = codePointWidth(ch.codePointAt(0) ?? 0)
    if (used + w > width) break
    out += ch
    used += w
  }
  return out
}

/** Truncate on the left to `width` cells, with a leading `…` when text is cut. */
export function fitDisplayWidthLeft(text: string, width: number): string {
  if (width <= 0) return ""
  if (displayWidth(text) <= width) return text
  const chars = Array.from(text)
  let out = ""
  let used = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i] ?? ""
    const w = codePointWidth(ch.codePointAt(0) ?? 0)
    if (used + w > width - 1) break
    out = ch + out
    used += w
  }
  return ELLIPSIS + out
}

/** Pad on the right to `width` cells. Text with SGR is measured without it. */
export function padEndDisplay(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)))
}

/** Pad on the left to `width` cells. Text with SGR is measured without it. */
export function padStartDisplay(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - displayWidth(text))) + text
}

/** Options for {@link formatCwd}. */
export interface FormatCwdOptions {
  /** Home directory to show as `~`. Default: `process.env.HOME`. */
  home?: string
}

/**
 * Show a working directory in at most `width` cells: `$HOME` becomes `~`,
 * and a long path loses its left part (`…/project/src`), because the end
 * of a path is the part that tells paths apart.
 */
export function formatCwd(cwd: string, width: number, options: FormatCwdOptions = {}): string {
  const home = (options.home ?? process.env.HOME ?? "").replace(/\/+$/u, "")
  let path = toCellText(cwd)
  if (home && (path === home || path.startsWith(`${home}/`))) {
    path = `~${path.slice(home.length)}`
  }
  return fitDisplayWidthLeft(path, width)
}
