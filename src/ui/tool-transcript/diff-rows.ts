/**
 * Diff body rows for the tool transcript (Edit, Write, ShowDiff).
 *
 * A diff display arrives as one pre-rendered ANSI row per patch row (plain
 * colored, or syntax highlighted with a background wash). This module adds
 * the presentation the flat row list lacks:
 *
 * - A dim line-number gutter. Removed rows show their old line number.
 *   Added and context rows show their new line number. The counters come
 *   from the `@@ -a,b +c,d @@` hunk headers.
 * - Wrapping that keeps every character. A long row breaks after a space
 *   (or hard-breaks inside a long token) and keeps its indentation and
 *   inner spacing. Each continuation row gets the open SGR state back, so
 *   the wash and token colors carry across the break.
 * - A row cap. A row that needs more than {@link getDiffWrapLines} rows is
 *   cut on the last allowed row, which ends in a dim `...(+Nch)` hint.
 *
 * @module ui/tool-transcript/diff-rows
 */

import {
  codePointWidth,
  displayWidth,
  expandTabs,
  stripAnsi,
} from "@minimal-agent/core/plugin-api/utils/term-width"

import { c } from "../style/ansi.ts"
import { truncHint } from "../style/truncate-hint.ts"

/** Default for {@link getDiffWrapLines}: rows one diff line may use. */
export const DIFF_WRAP_LINES_DEFAULT = 5

let diffWrapLines = DIFF_WRAP_LINES_DEFAULT

/**
 * Set how many transcript rows one diff line may wrap onto before it is
 * cut. Values below 1 or that are not integers are ignored.
 */
export function setDiffWrapLines(n: number | undefined): void {
  if (typeof n === "number" && Number.isInteger(n) && n >= 1) diffWrapLines = n
}

/** The current wrap cap. See {@link setDiffWrapLines}. */
export function getDiffWrapLines(): number {
  return diffWrapLines
}

/** Reset the wrap cap to its default (tests). */
export function _resetDiffWrapLinesForTest(): void {
  diffWrapLines = DIFF_WRAP_LINES_DEFAULT
}

/**
 * Parse the wrap cap from a raw env or config value. Returns `undefined`
 * for anything that is not a positive integer.
 */
export function parseDiffWrapLines(raw: unknown): number | undefined {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : undefined
}

const RESET = "\x1b[0m"
/**
 * Terminal column where a transcript body row starts: the `  │ ` gutter.
 * Same value as `TOOL_PREVIEW_GUTTER_WIDTH` in `format.ts`, kept local
 * because `format.ts` imports this module (an import would be a cycle).
 * Tabs expand from this column on, so tab stops match what the terminal paints.
 */
const BODY_START_COL = 4
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
/** Number-column glyph for a hidden 2nd or later hunk header. */
const HUNK_GAP = "⋯"

/** One diff display row after numbering, before wrapping. */
interface NumberedRow {
  /** The row as rendered (ANSI kept). */
  text: string
  /** Line number for the gutter, or null for a header or title row. */
  lineNo: number | null
  /** True once the first file or hunk header was seen (rows get a gutter). */
  inDiff: boolean
  /** True for an `@@ ... @@` hunk header row. */
  hunk: boolean
}

/**
 * Give each diff display row its line number. The plain text of a row
 * (ANSI stripped) is matched against the unified-diff grammar. Inside a
 * hunk the remaining old and new counts decide what a row is, so a removed
 * row whose text starts with `--` is not taken for a `---` file header.
 */
function numberRows(lines: string[]): { rows: NumberedRow[]; maxLineNo: number } {
  const rows: NumberedRow[] = []
  let oldNo = 0
  let newNo = 0
  let oldLeft = 0
  let newLeft = 0
  let inDiff = false
  let maxLineNo = 0
  for (const text of lines) {
    const plain = stripAnsi(text)
    const inHunk = oldLeft > 0 || newLeft > 0
    let lineNo: number | null = null
    let hunkRow = false
    if (inHunk && plain.startsWith("-") && oldLeft > 0) {
      lineNo = oldNo++
      oldLeft--
    } else if (inHunk && plain.startsWith("+") && newLeft > 0) {
      lineNo = newNo++
      newLeft--
    } else if (inHunk && (plain.startsWith(" ") || plain === "")) {
      lineNo = newNo++
      oldNo++
      oldLeft = Math.max(0, oldLeft - 1)
      newLeft = Math.max(0, newLeft - 1)
    } else {
      const hunk = HUNK_RE.exec(plain)
      if (hunk) {
        inDiff = true
        hunkRow = true
        oldNo = Number(hunk[1])
        oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
        newNo = Number(hunk[3])
        newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
        maxLineNo = Math.max(maxLineNo, oldNo + oldLeft, newNo + newLeft)
      } else if (plain.startsWith("--- ") || plain.startsWith("+++ ")) {
        inDiff = true
      }
    }
    rows.push({ text, lineNo, inDiff, hunk: hunkRow })
  }
  return { rows, maxLineNo }
}

/** One parsed piece of a row: an escape sequence or one code point. */
type Unit = { esc: true; s: string } | { esc: false; s: string; w: number }

function parseUnits(text: string): Unit[] {
  const units: Unit[] = []
  for (let i = 0; i < text.length; ) {
    if (text.charCodeAt(i) === 0x1b && text[i + 1] === "[") {
      let j = i + 2
      while (j < text.length) {
        const code = text.charCodeAt(j)
        j += 1
        if (code >= 0x40 && code <= 0x7e) break
      }
      units.push({ esc: true, s: text.slice(i, j) })
      i = j
      continue
    }
    const cp = text.codePointAt(i)
    if (cp === undefined) break
    const s = String.fromCodePoint(cp)
    units.push({ esc: false, s, w: codePointWidth(cp) })
    i += s.length
  }
  return units
}

/**
 * Replay SGR sequences onto a style stack. A reset (`0`, or empty params)
 * clears the stack. A sequence that starts with `0;` clears it, then keeps
 * the sequence itself, because the rest of its params set a new style.
 */
function applySgr(state: string[], seq: string): void {
  if (!seq.endsWith("m")) return
  const params = seq.slice(2, -1)
  if (params === "" || params === "0") {
    state.length = 0
    return
  }
  if (params.startsWith("0;") || params.startsWith("0:")) state.length = 0
  state.push(seq)
}

/**
 * Break a row into fragments of at most `width` cells. The break goes
 * after the last space that fits, or inside the token when no space fits.
 * No character is dropped: the space stays at the end of its fragment.
 * Each fragment is self-contained: it opens with the style active at its
 * start and closes any style still open at its end.
 */
export function wrapPreserving(text: string, width: number): string[] {
  if (width <= 0 || displayWidth(text) <= width) return [text]
  const units = parseUnits(text)
  const fragments: string[] = []
  const state: string[] = []
  let prefix = ""
  let cur: Unit[] = []
  let curW = 0
  let breakAt = -1

  const emit = (part: Unit[]): void => {
    let body = prefix
    for (const u of part) {
      body += u.s
      if (u.esc) applySgr(state, u.s)
    }
    fragments.push(state.length > 0 ? `${body}${RESET}` : body)
    prefix = state.join("")
  }

  for (const u of units) {
    if (u.esc) {
      cur.push(u)
      continue
    }
    // A loop, not one check: the tail kept after a space break can still be
    // too wide for `u` (a 2-cell char), so break again until `u` fits.
    while (curW + u.w > width && curW > 0) {
      if (breakAt > 0 && breakAt < cur.length) {
        const head = cur.slice(0, breakAt)
        const tail = cur.slice(breakAt)
        emit(head)
        cur = tail
        curW = tail.reduce((sum, t) => sum + (t.esc ? 0 : t.w), 0)
      } else {
        emit(cur)
        cur = []
        curW = 0
      }
      breakAt = -1
      // The kept tail may itself hold spaces. Find its last break.
      for (let k = 0; k < cur.length; k++) {
        const t = cur[k]!
        if (!t.esc && t.s === " ") breakAt = k + 1
      }
    }
    cur.push(u)
    curW += u.w
    if (u.s === " ") breakAt = cur.length
  }
  if (cur.length > 0) emit(cur)
  return fragments
}

/** Count the code points of a row, ANSI excluded. */
function visibleCodePoints(text: string): number {
  let n = 0
  for (const _ of stripAnsi(text)) n++
  return n
}

/**
 * Cut `fragment` so it plus a dim `...(+Nch)` hint fits `width` cells.
 * `elided` is the code point count already cut after this fragment.
 */
function cutWithHint(fragment: string, width: number, elided: number): string {
  // Reserve room for the widest hint this cut can produce (every code point
  // of the fragment cut too), so the final hint always fits.
  const units = parseUnits(fragment)
  const total = units.reduce((n, u) => n + (u.esc ? 0 : 1), 0)
  const keepW = Math.max(1, width - displayWidth(truncHint(elided + total, "ch")))
  let out = ""
  let w = 0
  let kept = 0
  for (const u of units) {
    if (u.esc) {
      out += u.s
      continue
    }
    if (w + u.w > keepW) break
    out += u.s
    w += u.w
    kept++
  }
  // Full reset first: the hint must not inherit the row's color or wash.
  return `${out}${RESET}${c.dim(truncHint(elided + (total - kept), "ch"))}`
}

/**
 * Lay out one diff row onto at most `maxRows` fragments of `width` cells.
 * Returns the fragments unchanged when they fit. Otherwise the last kept
 * fragment ends in a dim `...(+Nch)` hint for everything cut.
 */
export function wrapDiffRow(text: string, width: number | undefined, maxRows: number): string[] {
  if (width === undefined || width <= 0) return [text]
  const fragments = wrapPreserving(text, width)
  if (fragments.length <= maxRows) return fragments
  const kept = fragments.slice(0, maxRows)
  const dropped = fragments.slice(maxRows)
  const elided = dropped.reduce((n, f) => n + visibleCodePoints(f), 0)
  kept[kept.length - 1] = cutWithHint(kept[kept.length - 1]!, width, elided)
  return kept
}

/**
 * A Read row, `N\t<code>`. The number may sit in a dim run when the body
 * was syntax highlighted (`highlightReadBody`).
 */
const READ_ROW_RE = /^(\x1b\[2m)?(\d+)(?:\x1b\[22m)?\t/

/**
 * Lay Read's `cat -n` rows out on the same gutter as diff rows: the number
 * right-aligned to the widest visible number, one space, then a blank
 * marker column, then the code. A Read body's code column then lines up
 * with a diff's context rows, and no tab stop can shift it (`1000\tz` used
 * to jump a whole tab stop right of `999\ty`). Rows that are not numbered
 * (a leading note) pass through as-is.
 */
export function renderReadRows(lines: string[]): string[] {
  let numW = 0
  for (const line of lines) {
    const m = READ_ROW_RE.exec(line)
    if (m) numW = Math.max(numW, m[2]!.length)
  }
  if (numW === 0) return lines
  return lines.map((line) => {
    const m = READ_ROW_RE.exec(line)
    if (!m) return line
    const cell = m[2]!.padStart(numW)
    // A plain Read body is dimmed whole by the caller, so a dim run here
    // would end that outer dim early. Keep the number dim only when the
    // source dimmed it (the highlighted body).
    return `${m[1] ? c.dim(cell) : cell}  ${line.slice(m[0].length)}`
  })
}

/**
 * Split a hunk row into its one-cell `+`/`-`/` ` marker and its payload.
 * The marker keeps the escapes before it and is closed with a reset when it
 * leaves a style open. The payload starts with the style that was active
 * after the marker, so it renders the same as before the split.
 */
function splitMarker(text: string): { marker: string; payload: string } | null {
  const units = parseUnits(text)
  const state: string[] = []
  let marker = ""
  let i = 0
  for (; i < units.length; i++) {
    const u = units[i]!
    marker += u.s
    if (u.esc) {
      applySgr(state, u.s)
      continue
    }
    if (u.s !== "+" && u.s !== "-" && u.s !== " ") return null
    i++
    break
  }
  if (i === 0 || i > units.length) return null
  const carry = state.join("")
  const payload = carry + units.slice(i).reduce((s, u) => s + u.s, "")
  return { marker: state.length > 0 ? `${marker}${RESET}` : marker, payload }
}

/**
 * Render a diff display into body rows (no outer `│` gutter): a dim line
 * number column, the `+`/`-` marker column, then the payload wrapped to fit
 * `bodyWidth`. Continuation rows leave the number and marker columns blank,
 * so wrapped text lines up under the payload, not under the marker. Title
 * rows above the first header keep no number column. `bodyWidth` undefined
 * means no width signal: rows are numbered but not wrapped.
 *
 * With `hideHunkHeaders` (Edit and Write), the `@@` rows still drive the
 * numbers but get no row of their own. The first hunk header is dropped.
 * Each later one becomes one dim `⋯` row in the number column, so a gap
 * between hunks stays visible.
 */
export function renderDiffRows(
  lines: string[],
  bodyWidth: number | undefined,
  maxRows: number = getDiffWrapLines(),
  opts: { hideHunkHeaders?: boolean } = {},
): string[] {
  const { rows, maxLineNo } = numberRows(lines)
  const numW = Math.max(1, String(Math.max(0, maxLineNo - 1)).length)
  const blank = " ".repeat(numW + 1)
  const out: string[] = []
  let hunksSeen = 0
  for (const row of rows) {
    if (opts.hideHunkHeaders && row.hunk) {
      if (hunksSeen > 0) out.push(c.dim(HUNK_GAP.padStart(numW)))
      hunksSeen++
      continue
    }
    if (!row.inDiff) {
      out.push(...wrapDiffRow(expandTabs(row.text, BODY_START_COL), bodyWidth, maxRows))
      continue
    }
    const num = row.lineNo === null ? blank : `${c.dim(String(row.lineNo).padStart(numW))} `
    // Expand tabs from the real column: gutter, number column, one space.
    // The marker is the first cell of the row, so the payload tab stops
    // match the terminal. A raw tab measures 0 cells and breaks the width.
    const text = expandTabs(row.text, BODY_START_COL + numW + 1)
    // A row that fits keeps its bytes as-is. Only a row that wraps needs
    // the marker split off, so its continuations line up under the payload.
    const fits = bodyWidth === undefined || displayWidth(text) <= bodyWidth - numW - 1
    const split = row.lineNo === null || fits ? null : splitMarker(text)
    if (split === null) {
      const contentW = bodyWidth === undefined ? undefined : Math.max(1, bodyWidth - numW - 1)
      const frags = wrapDiffRow(text, contentW, maxRows)
      for (let i = 0; i < frags.length; i++) out.push(`${i === 0 ? num : blank}${frags[i]}`)
      continue
    }
    // One more cell for the marker column.
    const payloadW = bodyWidth === undefined ? undefined : Math.max(1, bodyWidth - numW - 2)
    const frags = wrapDiffRow(split.payload, payloadW, maxRows)
    for (let i = 0; i < frags.length; i++) {
      out.push(i === 0 ? `${num}${split.marker}${frags[i]}` : `${blank} ${frags[i]}`)
    }
  }
  return out
}

/**
 * The patch an Edit/Write diff shows: the core patch without its leading
 * `--- a/<path>` / `+++ b/<path>` file headers. The tool header row already
 * names the one file, so the headers only repeat it (and an absolute path
 * reads as `a//Users/...`). The model-facing patch is untouched.
 */
export function displayPatch(patch: string): string {
  const lines = patch.split("\n")
  let i = 0
  while (i < lines.length && /^(?:---|\+\+\+) /.test(lines[i]!)) i++
  return lines.slice(i).join("\n")
}

/**
 * One dim summary row above an Edit/Write diff, in place of the old bold
 * `New file: <path>` title and rule: `new file · 9 lines` for a created
 * file, else `+3 −1` (added and removed line counts).
 */
export function diffSummary(patch: string, isNew: boolean): string {
  let added = 0
  let removed = 0
  let inHunk = false
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) inHunk = true
    else if (!inHunk) continue
    else if (line.startsWith("+")) added++
    else if (line.startsWith("-")) removed++
  }
  if (isNew) return `new file · ${added} ${added === 1 ? "line" : "lines"}`
  return `+${added} −${removed}`
}

/** Content rows a new-file Write preview shows before its `shown N/M L` footer. */
export const NEW_FILE_PREVIEW_LINES = 10

/**
 * The lines of a created file, read from its all-additions patch (the `+`
 * rows after the first hunk header, marker removed). The count matches
 * {@link diffSummary}, so the summary row and the footer agree.
 */
export function newFileLines(patch: string): string[] {
  const out: string[] = []
  let inHunk = false
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) inHunk = true
    else if (inHunk && line.startsWith("+")) out.push(line.slice(1))
  }
  return out
}

/**
 * The `N\t<code>` rows a new-file preview shows: the first
 * {@link NEW_FILE_PREVIEW_LINES} lines. Live and replay highlight this
 * exact text (`highlightReadBody`), so both give the same rows.
 */
export function newFileNumberedBody(patch: string): string {
  return newFileLines(patch)
    .slice(0, NEW_FILE_PREVIEW_LINES)
    .map((line, i) => `${i + 1}\t${line}`)
    .join("\n")
}

/**
 * Display and footer for a Write that created a file: the dim
 * `new file · N lines` summary row, then Read-style `N\t<code>` rows
 * (`highlighted` when a highlighter ran, else plain). A file longer than
 * {@link NEW_FILE_PREVIEW_LINES} gets a dim `shown 10/N L` footer.
 */
export function newFileDisplay(
  patch: string,
  highlighted?: string | null,
): { display: string; footer?: string } {
  const total = newFileLines(patch).length
  const body = highlighted ?? newFileNumberedBody(patch)
  const display = `${c.dim(diffSummary(patch, true))}\n${body}`
  if (total <= NEW_FILE_PREVIEW_LINES) return { display }
  return { display, footer: c.dim(`shown ${NEW_FILE_PREVIEW_LINES}/${total} L`) }
}

/**
 * True when a Write display is a {@link newFileDisplay} body: its 1st row
 * (ANSI stripped) is the `new file · ` summary and its 2nd row is a
 * Read-style `N\t` row, not a diff row. Both checks keep a plugin or
 * persisted display that only looks numbered from a false match.
 */
export function isNewFileDisplay(display: string): boolean {
  const nl = display.indexOf("\n")
  return (
    nl >= 0 &&
    stripAnsi(display.slice(0, nl)).startsWith("new file · ") &&
    READ_ROW_RE.test(display.slice(nl + 1))
  )
}

/**
 * Render a {@link newFileDisplay} body: Read-style rows on the diff gutter
 * (dim right-aligned number, space, blank marker column, code). No `+`
 * marker and no addition color. Long rows wrap and cut like diff rows.
 * Rows that are not numbered (the summary) pass through, wrapped.
 */
export function renderNewFileRows(
  lines: string[],
  bodyWidth: number | undefined,
  maxRows: number = getDiffWrapLines(),
): string[] {
  let numW = 0
  for (const line of lines) {
    const m = READ_ROW_RE.exec(line)
    if (m) numW = Math.max(numW, m[2]!.length)
  }
  const blank = " ".repeat(numW + 2)
  const payloadW = bodyWidth === undefined ? undefined : Math.max(1, bodyWidth - numW - 2)
  const out: string[] = []
  for (const line of lines) {
    const m = READ_ROW_RE.exec(line)
    if (!m) {
      out.push(...wrapDiffRow(expandTabs(line, BODY_START_COL), bodyWidth, maxRows))
      continue
    }
    const num = `${c.dim(m[2]!.padStart(numW))}  `
    // The code starts after the gutter, the number column, a space, and the
    // blank marker column. Expand tabs from there so the stops match.
    const code = expandTabs(line.slice(m[0].length), BODY_START_COL + numW + 2)
    const frags = wrapDiffRow(code, payloadW, maxRows)
    for (let i = 0; i < frags.length; i++) out.push(`${i === 0 ? num : blank}${frags[i]}`)
  }
  return out
}
