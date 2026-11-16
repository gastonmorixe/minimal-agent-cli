import { ANSI_CODES } from "../../terminal-kit/ansi.ts"
import { PALETTE } from "../../terminal-kit/palette.ts"

import {
  type CodeHighlighter,
  lineEndsWithOpenBackground,
  type UnifiedDiffColors,
} from "../formatter/mdstream-code-highlighter.ts"
import { c } from "../style/ansi.ts"

const { BOLD, RESET } = ANSI_CODES

/**
 * Pick the grammar that matches the slice actually being highlighted.
 *
 * Syntect's `php` grammar starts in HTML mode and only enters PHP at an opening
 * `<?php` / `<?` tag. A mid-file Read slice or a diff hunk has no tag, so it
 * lexes as one flat HTML text run. `PHP Source` (the bundled `source.php` inner
 * grammar) starts in PHP mode, and `php` stays correct for slices that really
 * are HTML — a template head, or a block after `?>`.
 *
 * Rule: the first real open tag decides, unless a `?>` comes before it. Order
 * matters in both directions; a slice that opens in PHP and later switches
 * would otherwise lose its PHP tokens. No tag at all means we are inside a PHP
 * block: PHP files are the only input here, and the alternative (assuming HTML)
 * is what produced a flat block in the first place.
 *
 * Deliberately shape-based, not content-sniffing: nothing here guesses a
 * language, it only chooses between two grammars for a language already known.
 */
export function refineEmbeddedLanguage(language: string, code: string): string {
  if (language.trim().toLowerCase() !== "php") return language

  const open = findOpenTag(code)
  if (open === -1) return PHP_SOURCE_TOKEN
  const close = code.indexOf("?>")
  if (close !== -1 && close < open) return PHP_SOURCE_TOKEN
  return "php"
}

/**
 * Index of the first REAL PHP open tag, or -1.
 *
 * Matches `<?php`, `<?=` and the short `<? ` form only. A bare `<?` is not
 * enough: `$doc = "<?xml version=\"1.0\"?>";` is legacy PHP that builds XML
 * strings, and treating it as a tag makes the grammar leave PHP mode mid-file
 * and mis-style the rest of the slice. `<` followed by anything other than
 * `php`, `=` or whitespace is not an open tag in this grammar's eyes either.
 */
function findOpenTag(code: string): number {
  const pattern = /<\?(?:php\b|=|\s)/i
  const match = pattern.exec(code)
  return match?.index ?? -1
}

/**
 * The grammar token sent to mdstream for a PHP slice with no open tag.
 *
 * Spelled as syntect's display name, not the `php-source` alias, on purpose:
 * `PHP Source` has been in the bundled syntax pack for years, so it highlights
 * on every mdstream version. The `php-source` alias only exists from 0.3.9, and
 * on older servers it resolves to plain text — the flat output this change
 * exists to remove. Switch to the alias once the CLI can require >= 0.3.9 (the
 * ready line carries no version, so there is no runtime gate yet).
 */
const PHP_SOURCE_TOKEN = "PHP Source"

/**
 * The `-`/`+` body text of a patch, markers stripped.
 *
 * File headers (`--- a/x`, `+++ b/x`), hunk headers and context rows are
 * excluded. Those are exactly the lines mdstream does not lex per stream: a
 * `<?php` sitting on a context row never reaches the added stream's lexer, so
 * letting it choose the grammar would leave the changed row flat — the bug this
 * refinement exists to fix, merely moved to the context line.
 */
function changedPayload(patch: string): string {
  const body: string[] = []
  for (const line of patch.split("\n")) {
    // Only a space after the marker makes these headers. A deleted `--$i;` shows
    // up as `---$i;` and is real body content, not a file header.
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@")) continue
    if (line.startsWith("-") || line.startsWith("+")) body.push(line.slice(1))
  }
  return body.join("\n")
}

/**
 * Background-only reset (`SGR 49`). Clears the wash without touching the
 * foreground, so a washed row can be closed at the end of its own line and the
 * next transcript row's gutter starts on the terminal's default background.
 */
const BACKGROUND_RESET = "\x1b[49m"

/**
 * Highlight a Read result while leaving its cat-n line-number column untouched.
 *
 * Each Read row is also a `gutter + body` frame row, and the raw highlight mode
 * carries NO bleeding-background guard (the guard in mdstream-code-highlighter.ts
 * is gated on `mode === "unified-diff"`). A payload that ended on an open wash
 * would therefore tint the next row's gutter. Real mdstream v0.3.6 raw output
 * closes every row (measured CLEAN 8/8 by
 * `research/2026-11-05-code-highlight-render/recheck-read-path.ts`), so this is
 * latent, not a live bleed. The same end-of-line close the native diff path uses
 * is applied here so the invariant does not depend on the highlighter's manners.
 */
export async function highlightReadBody(
  numberedBody: string,
  language: string,
  highlighter: CodeHighlighter,
): Promise<string | null> {
  const rows = numberedBody.split("\n")
  const parsed = rows.map((row) => row.match(/^(\d+)\t(.*)$/s))
  if (parsed.some((match) => match === null)) return null

  const code = parsed.map((match) => match![2]).join("\n")
  const ansi = await highlighter.highlight({
    language: refineEmbeddedLanguage(language, code),
    code,
  })
  if (ansi === null) return null
  const highlighted = splitLogicalLines(ansi)
  if (highlighted.length !== parsed.length) return null

  const body = highlighted.map((line, index) => `${c.dim(parsed[index]![1]!)}\t${line}`).join("\n")
  return closeOpenBackgrounds(body)
}

/**
 * Compose syntax token foregrounds with unified-diff semantics. The one-cell
 * +/- marker keeps the bright semantic color, while changed payload rows get a
 * soft background wash and retain the highlighter's token foregrounds.
 */
export async function highlightUnifiedDiff(
  patch: string,
  language: string,
  highlighter: CodeHighlighter,
  title?: string,
): Promise<string | null> {
  const palette = resolveDiffPalette()
  // Decide on the changed lines only. mdstream lexes `-`/`+` bodies; context
  // rows reach the lexers only through its continuity pass, which a patch this
  // large may skip. A `<?php` that lives on a context row therefore must not
  // choose the grammar, or the added row stays flat.
  const diffLanguage = refineEmbeddedLanguage(language, changedPayload(patch))
  const native = highlighter.highlightUnifiedDiff
    ? await highlighter.highlightUnifiedDiff({
        language: diffLanguage,
        code: patch,
        diffStyle: "bg-wash",
        colors: palette.colors,
      })
    : null
  if (native !== null) {
    // Order matters: darken the wash FIRST, then close it. The close only
    // inspects the end of each row and appends `SGR 49`, so running it last
    // keeps the background-only reset the final byte on a washed row.
    return withOptionalTitle(closeOpenBackgrounds(darkenNativeWash(native, palette.colors)), title)
  }

  const lines = patch.split("\n")
  const oldPayload: string[] = []
  const newPayload: string[] = []
  for (const line of lines) {
    if (isFileHeader(line) || line.startsWith("@@")) continue
    if (line.startsWith("-")) oldPayload.push(line.slice(1))
    else if (line.startsWith("+")) newPayload.push(line.slice(1))
    else if (line.startsWith(" ")) {
      oldPayload.push(line.slice(1))
      newPayload.push(line.slice(1))
    }
  }

  const oldCode = oldPayload.join("\n")
  const newCode = newPayload.join("\n")
  // Each stream is lexed independently with fresh state, so each side picks the
  // grammar its own lines need. The two sides may disagree on one patch, which
  // is correct: each choice matches the text that stream actually sees.
  const oldLanguage = refineEmbeddedLanguage(language, oldCode)
  const newLanguage = refineEmbeddedLanguage(language, newCode)
  const [oldAnsi, newAnsi] = await Promise.all([
    oldCode.length === 0
      ? Promise.resolve("")
      : highlighter.highlight({ language: oldLanguage, code: oldCode }),
    newCode.length === 0
      ? Promise.resolve("")
      : highlighter.highlight({ language: newLanguage, code: newCode }),
  ])
  if (oldAnsi === null || newAnsi === null) return null
  const oldLines = oldPayload.length === 0 ? [] : splitLogicalLines(oldAnsi)
  const newLines = newPayload.length === 0 ? [] : splitLogicalLines(newAnsi)
  if (oldLines.length !== oldPayload.length || newLines.length !== newPayload.length) return null

  let oldIndex = 0
  let newIndex = 0
  const out: string[] = []
  if (title) {
    out.push(`${RESET}${BOLD}${title}${RESET}`)
    out.push(`${RESET}\x1b[2m${"─".repeat(Math.min(title.length + 4, 64))}${RESET}`)
  }
  // Every row is joined with "\n", and a newline does not reset SGR. A changed
  // row drives its wash from after the marker reset to the end of the row, so
  // trailing padding inherits it, and every other row starts with a full RESET
  // so an open wash can never bleed into it.
  for (const line of lines) {
    if (isFileHeader(line)) out.push(`${RESET}${BOLD}${line}${RESET}`)
    else if (line.startsWith("@@")) out.push(`${RESET}${palette.hunk}${line}${RESET}`)
    else if (line.startsWith("-")) {
      const payload = reassertBackground(oldLines[oldIndex++] ?? "", palette.removalWash)
      out.push(
        `${palette.removalWash}${palette.removal}-${RESET}${palette.removalWash}${payload}${BACKGROUND_RESET}`,
      )
    } else if (line.startsWith("+")) {
      const payload = reassertBackground(newLines[newIndex++] ?? "", palette.additionWash)
      out.push(
        `${palette.additionWash}${palette.addition}+${RESET}${palette.additionWash}${payload}${BACKGROUND_RESET}`,
      )
    } else if (line.startsWith(" ")) {
      const payload = newLines[newIndex++] ?? ""
      oldIndex++
      out.push(closeRowBackground(`${RESET} ${payload}`))
    } else {
      out.push(closeRowBackground(`${RESET}${line}`))
    }
  }
  // The host draws each transcript row as `gutter + body` (formatToolPreview),
  // and it never resets before a gutter. A wash still ACTIVE at the END of a
  // changed row therefore tints the next row's two gutter spaces plus its `│`
  // or `╰` glyph. Measured with
  // `bun run research/2026-11-05-code-highlight-render/probe-native.ts`:
  // the `+const a = 2` row ends on a foreground colour with its background
  // still set, and the `╰` closer below it inherits that wash. Gating a single
  // close on the LAST row is not enough, because that patch's last row can be
  // a context row, so every changed row is closed in its own branch above.
  //
  // The close is a BACKGROUND-ONLY reset (`SGR 49`), not a full reset. The wash
  // must still run to the last glyph of the row (asserted by
  // code-highlight-diff-wash.test.ts), while the background must be back to
  // default before the caller prepends the next row's gutter.
  return out.join("\n")
}

/**
 * Close a background that a FALLBACK row's highlighter payload leaves open at
 * end of line.
 *
 * The context and pass-through branches only PREFIX their row with a full
 * `RESET`. That reset reaches the terminal AFTER the caller has already painted
 * the row's own gutter, so a payload ending on an open wash tints the `│`/`╰`
 * of the row BELOW. The `-`/`+` branches close themselves with `BACKGROUND_RESET`
 * for the same reason.
 *
 * CONDITIONAL close, not unconditional: `lineEndsWithOpenBackground` gates it, so
 * a row that already ends closed keeps byte-identical output. That matters here
 * because these branches also carry rows the highlighter never touched (patch
 * rows the compositor passes through verbatim), and an appended `SGR 49` there
 * would be a silent edit to bytes that are not ours to rewrite. An `SGR 49` on a
 * row with no background is visually a no-op, so the two choices are equal on
 * screen and the conditional one is smaller on the wire.
 *
 * Measured before this close with
 * `bun run research/2026-11-05-code-highlight-render/recheck-fallback-ctx.ts`:
 * a context row whose tokens end on an open `48;2` left the closer `╰` painted
 * with that wash, and so did an empty `+` payload row.
 */
function closeRowBackground(row: string): string {
  return lineEndsWithOpenBackground(row) ? `${row}${BACKGROUND_RESET}` : row
}

function splitLogicalLines(value: string): string[] {
  // `code` is assembled by joining one payload per source row. A final empty
  // source row therefore produces a trailing `\n`, and split()'s final empty
  // element is the real highlighted counterpart of that row — not an artifact
  // to discard. This is the common full-file Read case for source files ending
  // in a newline. Dropping it made the row-count guard fail closed, so bounded
  // reads highlighted while otherwise-identical full-file reads stayed plain.
  return value.split("\n")
}

function isFileHeader(line: string): boolean {
  return line.startsWith("---") || line.startsWith("+++")
}

/**
 * Close a row-scoped background wash at END OF LINE, after the payload.
 *
 * mdstream's native bg-wash rows keep their background set to the end of the
 * row on purpose, so trailing padding inherits the wash. A newline does not
 * reset SGR, so that open wash would tint the next transcript row's gutter.
 * Appending `SGR 49` here keeps the wash covering the last glyph AND returns
 * the background to default before the caller prepends the next row's gutter.
 *
 * Rows that do not open a background (file headers, hunk headers) are left
 * byte-identical.
 */
function closeOpenBackgrounds(body: string): string {
  return body
    .split("\n")
    .map((line) => (lineEndsWithOpenBackground(line) ? `${line}${BACKGROUND_RESET}` : line))
    .join("\n")
}

/** Truecolor background, `;` parameter form: `ESC[48;2;r;g;bm`. */
const TRUE_COLOR_BACKGROUND = /\x1b\[48;2;(\d+);(\d+);(\d+)m/g
/** Truecolor background, colon sub-parameter form: `ESC[48:2::r:g:bm`. */
const TRUE_COLOR_BACKGROUND_COLON = /\x1b\[48:2::(\d+):(\d+):(\d+)m/g

/**
 * Replace mdstream's FULL-OPACITY row wash with the dark tint the local
 * fallback already paints.
 *
 * mdstream's bg-wash mode reuses the raw accent colour as the row background,
 * so a lime addition arrives as `38;2;135;255;0m+` for the marker (foreground,
 * correct) followed by `48;2;135;255;0m` for the whole row (background,
 * blinding). Measured with
 * `bun run research/2026-11-05-code-highlight-render/probe-wash-colors.ts`:
 * `#ff00af` and `#87ff00` at full opacity behind every glyph of the row.
 *
 * Two rules keep this narrow:
 *
 * 1. Only a background whose NUMERIC r/g/b triple equals one of the two accents
 *    we hand mdstream (`colors.deleted`, `colors.inserted`) is rewritten. A
 *    themed code background, or any future non-wash background, passes through
 *    byte-identical.
 * 2. The replacement tint is `darkenHex` applied to that accent, i.e. the exact
 *    same `Math.floor(channel * 0.22)` math and therefore the exact same escape
 *    the fallback builds in `resolveDiffPalette()`. The two paths converge by
 *    construction instead of by two copies of a constant.
 *
 * Marker foregrounds are untouched: this only ever matches `48;2`, never `38;2`.
 */
function darkenNativeWash(body: string, colors: UnifiedDiffColors): string {
  const tints = new Map<string, string>()
  for (const accent of [colors.deleted, colors.inserted]) {
    if (accent === undefined) continue
    const triple = rgbTriple(accent)
    const tinted = rgbTriple(darkenHex(accent, accent))
    if (triple === null || tinted === null || triple === tinted) continue
    tints.set(triple, tinted)
  }
  if (tints.size === 0) return body

  const rewrite = (colon: boolean) => (whole: string, red: string, green: string, blue: string) => {
    const tint = tints.get(`${Number(red)};${Number(green)};${Number(blue)}`)
    if (tint === undefined) return whole
    const [r, g, b] = tint.split(";")
    return colon ? `\x1b[48:2::${r}:${g}:${b}m` : `\x1b[48;2;${r};${g};${b}m`
  }

  return body
    .replace(TRUE_COLOR_BACKGROUND, rewrite(false))
    .replace(TRUE_COLOR_BACKGROUND_COLON, rewrite(true))
}

/** `#rrggbb` to its `r;g;b` decimal triple, for numeric (not string) compare. */
function rgbTriple(hex: string): string | null {
  const match = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!match) return null
  return [match[1]!, match[2]!, match[3]!].map((part) => Number.parseInt(part, 16)).join(";")
}

function withOptionalTitle(body: string, title: string | undefined): string {
  if (!title) return body
  // Title rows start with a full RESET for the same reason the compositor
  // fallback rows do: an unknown SGR state from the caller must not tint them.
  return `${RESET}${BOLD}${title}${RESET}\n${RESET}\x1b[2m${"─".repeat(Math.min(title.length + 4, 64))}${RESET}\n${body}`
}

function resolveDiffPalette(): {
  removal: string
  addition: string
  hunk: string
  removalWash: string
  additionWash: string
  colors: UnifiedDiffColors
} {
  let configured: Record<string, string> = {}
  try {
    configured = JSON.parse(process.env.MINIMAL_AGENT_PALETTE ?? "{}") as Record<string, string>
  } catch {
    // Palette environment is optional presentation data.
  }
  const removal = configured.removal ?? configured.error ?? configured.pink ?? PALETTE.pink
  const addition = configured.addition ?? configured.success ?? configured.lime ?? PALETTE.lime
  const hunk = configured["accent-soft"] ?? configured.cyan ?? PALETTE.cyan
  const deleted = sgrForegroundToHex(removal) ?? "#ff5fd7"
  const inserted = sgrForegroundToHex(addition) ?? "#87ff00"
  return {
    removal,
    addition,
    hunk,
    removalWash: backgroundEscape(darkenHex(deleted, "#59163d")),
    additionWash: backgroundEscape(darkenHex(inserted, "#2f5900")),
    // mdstream owns wash strength in bg-wash mode: it reuses the raw accent
    // colour at FULL opacity as the row background, so #ff5fd7 arrives as
    // `48;2;255;95;215` (measured with `mdstream --highlight-server`). It keeps
    // these bright semantic colours on the +/- marker. The local compositor
    // fallback below keeps its own darker tint instead.
    colors: { deleted, inserted },
  }
}

function reassertBackground(value: string, background: string): string {
  return value.replaceAll(RESET, `${RESET}${background}`)
}

function darkenHex(color: string | undefined, fallback: string): string {
  const hex = color ?? fallback
  const match = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!match) return fallback
  return rgbHex(
    Math.floor(Number.parseInt(match[1]!, 16) * 0.22),
    Math.floor(Number.parseInt(match[2]!, 16) * 0.22),
    Math.floor(Number.parseInt(match[3]!, 16) * 0.22),
  )
}

function backgroundEscape(hex: string): string {
  const match = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!match) return ""
  return `\x1b[48;2;${Number.parseInt(match[1]!, 16)};${Number.parseInt(match[2]!, 16)};${Number.parseInt(match[3]!, 16)}m`
}

function sgrForegroundToHex(sgr: string): string | undefined {
  const truecolor = sgr.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/)
  if (truecolor) {
    return `#${[truecolor[1], truecolor[2], truecolor[3]]
      .map((part) => Number(part).toString(16).padStart(2, "0"))
      .join("")}`
  }

  const indexed = sgr.match(/\x1b\[38;5;(\d+)m/)
  if (indexed) return indexedColorToHex(Number(indexed[1]))

  const legacy = sgr.match(/\x1b\[(3[0-7]|9[0-7])m/)
  if (legacy) return legacyColorToHex(Number(legacy[1]))
  return undefined
}

function indexedColorToHex(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined
  if (index < 16) {
    const code = index < 8 ? 30 + index : 90 + (index - 8)
    return legacyColorToHex(code)
  }
  if (index >= 232) {
    const channel = 8 + (index - 232) * 10
    return rgbHex(channel, channel, channel)
  }
  const value = index - 16
  const levels = [0, 95, 135, 175, 215, 255]
  return rgbHex(
    levels[Math.floor(value / 36)]!,
    levels[Math.floor((value % 36) / 6)]!,
    levels[value % 6]!,
  )
}

function legacyColorToHex(code: number): string | undefined {
  const normal = [
    [0, 0, 0],
    [205, 49, 49],
    [13, 188, 121],
    [229, 229, 16],
    [36, 114, 200],
    [188, 63, 188],
    [17, 168, 205],
    [229, 229, 229],
  ] as const
  const bright = [
    [102, 102, 102],
    [241, 76, 76],
    [35, 209, 139],
    [245, 245, 67],
    [59, 142, 234],
    [214, 112, 214],
    [41, 184, 219],
    [255, 255, 255],
  ] as const
  const entry = code >= 90 ? bright[code - 90] : normal[code - 30]
  return entry ? rgbHex(entry[0], entry[1], entry[2]) : undefined
}

function rgbHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}
