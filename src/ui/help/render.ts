/**
 * Shared terminal help renderer.
 *
 * Commands hand over structured rows; this module owns ANSI-aware alignment,
 * wrapping to a width, and color removal (SPEC-HELP R-27, R-28, R-29). That
 * keeps help output consistent without each command manually counting
 * escape-colored columns.
 *
 * Layout of a section with a width:
 *   - The term column is as wide as the widest term that still leaves the
 *     summary at least {@link minSummaryWidth} cells. Rows with a wider term
 *     put the term on its own line and the summary on the next line.
 *   - Summaries wrap at word boundaries. Continuation lines start at the
 *     summary column.
 *   - A summary with a word wider than the summary column starts on the next
 *     line at a small hang indent, so a long flag name is not cut.
 *   - No line is wider than the width, measured with `displayWidth` (ANSI
 *     stripped). The one exception: a single word wider than the whole width
 *     is not cut. It stands alone on its own line (SPEC-HELP V-2).
 *   - With color on, a wrapped fragment that holds an SGR sequence ends with
 *     a reset, so no style leaks into the next line.
 *
 * Without a width, rows are aligned to the widest term and nothing wraps (the
 * layout before M-7).
 *
 * @module ui/help/render
 */

import { displayWidth, stripAnsi, wordWrap } from "@minimal-agent/core/plugin-api/utils/term-width"

export interface HelpRow {
  term: string
  summary: string
}

export interface HelpSection {
  title: string
  note?: string
  rows: HelpRow[]
}

export interface HelpRenderOptions {
  indent?: number
  rowIndent?: number
  gap?: number
  /** Wrap width in cells. Omit for no wrapping. */
  width?: number
  /** `false` strips every ANSI sequence from the input. Default `true`. */
  color?: boolean
}

/** Extra indent of a summary that starts on the line after its term. */
const HANG = 4

/** SGR reset added to the end of each wrapped fragment that has a style. */
const SGR_RESET = "\u001b[0m"

/** Smallest summary width the term column must leave at `width`. */
export function minSummaryWidth(width: number): number {
  return Math.max(10, Math.floor(width / 2))
}

/** Render a sequence of help sections with aligned row summaries. */
export function renderHelpSections(
  sections: readonly HelpSection[],
  opts: HelpRenderOptions = {},
): string[] {
  const indent = opts.indent ?? 2
  const rowIndent = opts.rowIndent ?? 4
  const gap = opts.gap ?? 2
  const color = opts.color !== false
  const width = opts.width !== undefined && opts.width > 0 ? Math.floor(opts.width) : undefined
  const clean = (s: string): string => (color ? s : stripAnsi(s))
  const lines: string[] = []

  for (const section of sections) {
    if (lines.length > 0) lines.push("")
    const head = `${clean(section.title)}${section.note ? ` ${clean(section.note)}` : ""}`
    lines.push(...wrapBlock(head, indent, indent + 2, width, color))
    if (section.rows.length === 0) continue
    const rows = section.rows.map((row) => ({ term: clean(row.term), summary: clean(row.summary) }))
    lines.push(...renderRows(rows, { rowIndent, gap, width, color }))
  }

  return lines
}

/**
 * Wrap one free text line to `width`. The first line starts at `indent`,
 * continuation lines at `hang`. Without a width the text is not wrapped.
 */
export function wrapHelpText(
  text: string,
  opts: { indent?: number; hang?: number; width?: number; color?: boolean } = {},
): string[] {
  const color = opts.color !== false
  const indent = opts.indent ?? 2
  return wrapBlock(color ? text : stripAnsi(text), indent, opts.hang ?? indent, opts.width, color)
}

/** Pad an ANSI-colored string to a target visible cell width. */
export function padVisible(text: string, width: number): string {
  const pad = Math.max(0, width - displayWidth(text))
  return `${text}${" ".repeat(pad)}`
}

interface RowLayout {
  rowIndent: number
  gap: number
  width: number | undefined
  color: boolean
}

function renderRows(rows: readonly HelpRow[], layout: RowLayout): string[] {
  const { rowIndent, gap, width, color } = layout
  const termWidths = rows.map((row) => displayWidth(row.term))
  const limit =
    width === undefined
      ? Number.POSITIVE_INFINITY
      : width - rowIndent - gap - minSummaryWidth(width)
  const termCol = Math.max(0, ...termWidths.filter((w) => w <= limit))
  const summaryCol = rowIndent + termCol + gap
  const avail = width === undefined ? Number.POSITIVE_INFINITY : width - summaryCol
  const pad = " ".repeat(rowIndent)
  const out: string[] = []

  rows.forEach((row, i) => {
    const tw = termWidths[i] ?? 0
    const longestWord = maxWordWidth(row.summary)
    if (tw <= termCol && longestWord <= avail) {
      if (row.summary === "") {
        out.push(`${pad}${row.term}`)
        return
      }
      const parts = wrapTo(row.summary, avail, color)
      out.push(`${pad}${padVisible(row.term, termCol)}${" ".repeat(gap)}${parts[0] ?? ""}`)
      for (const part of parts.slice(1)) out.push(`${" ".repeat(summaryCol)}${part}`)
      return
    }
    // The term is too wide for the column, or the summary has a word wider
    // than the summary column: term on its own line, summary below it.
    out.push(...wrapBlock(row.term, rowIndent, rowIndent + 2, width, color))
    if (row.summary === "") return
    const col = longestWord <= avail ? summaryCol : rowIndent + HANG
    out.push(...wrapBlock(row.summary, col, col, width, color))
  })

  return out
}

function wrapBlock(
  text: string,
  first: number,
  rest: number,
  width: number | undefined,
  color: boolean,
): string[] {
  if (width === undefined) return [`${" ".repeat(first)}${text}`]
  // Wrap every line to the narrower of the two widths, so one `wordWrap`
  // call keeps the style carry across lines.
  const avail = Math.max(1, width - Math.max(first, rest))
  return wrapTo(text, avail, color).map((line, i) => `${" ".repeat(i === 0 ? first : rest)}${line}`)
}

/**
 * `wordWrap` to `avail`, with two changes:
 *   - A word wider than `avail` is not cut. It stands whole on its own line
 *     and only that line is wider than `avail` (SPEC-HELP V-2), so a URL or
 *     a flag name can still be copied.
 *   - When the text wraps, every fragment with an SGR sequence ends with a
 *     reset, the last one too. `wordWrap` drops a trailing close sequence,
 *     so without the reset a style stays open into the next row.
 */
function wrapTo(text: string, avail: number, color: boolean): string[] {
  const parts = wrapKeepingLongWords(text, avail)
  if (!color || parts.length < 2) return parts
  return parts.map((part) => (part.includes("\u001b[") ? `${part}${SGR_RESET}` : part))
}

/** `wordWrap`, but a word wider than `avail` gets its own unbroken line. */
function wrapKeepingLongWords(text: string, avail: number): string[] {
  // ANSI sequences hold no blanks, so a split on blanks keeps each sequence
  // attached to its word.
  const words = text.split(/[ \t]+/u).filter((w) => w !== "")
  if (words.every((w) => displayWidth(w) <= avail)) return wordWrap(text, avail)
  const out: string[] = []
  let run: string[] = []
  let seen = ""
  const flush = (): void => {
    if (run.length === 0) return
    const joined = run.join(" ")
    out.push(...wordWrap(`${openSgr(seen)}${joined}`, avail))
    seen += ` ${joined}`
    run = []
  }
  for (const word of words) {
    if (displayWidth(word) <= avail) {
      run.push(word)
      continue
    }
    flush()
    out.push(`${openSgr(seen)}${word}`)
    seen += ` ${word}`
  }
  flush()
  return out
}

/** The SGR sequences in `text` after its last full reset. */
function openSgr(text: string): string {
  const seqs = text.match(/\u001b\[[0-9;]*m/gu) ?? []
  let start = 0
  seqs.forEach((seq, i) => {
    if (seq === "\u001b[m" || seq === "\u001b[0m") start = i + 1
  })
  return seqs.slice(start).join("")
}

function maxWordWidth(text: string): number {
  return Math.max(
    0,
    ...stripAnsi(text)
      .split(/[ \t]+/u)
      .map(displayWidth),
  )
}
