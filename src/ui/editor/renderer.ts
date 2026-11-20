/**
 * Pure transform from {@link EditorBuffer} state to a list of physical
 * terminal rows + a cursor position, ready to be handed to the
 * {@link Compositor} as a "live area" snapshot.
 *
 * When `columns` is provided to {@link EditorRenderer.render}, long logical
 * lines are pre-wrapped into chunks ≤ `columns` cells wide and the cursor
 * position is returned in **physical** row/col coordinates inside the live
 * area. Without `columns`, one physical row per logical line is emitted and
 * the cursor column is the raw `prompt + buf.col` (legacy MVP behavior;
 * relies on terminal-side wrap and breaks cursor placement for wrapped
 * lines — TTY callers should always pass `columns`).
 *
 * @module ui/editor/renderer
 */

import {
  codePointWidth,
  cursorRowOffset,
  cursorVisualCol,
  displayWidth,
  wrapRows,
} from "@minimal-agent/core/plugin-api/utils/term-width"
import type { BufferStyleSpan } from "../../editor/types.ts"
import type { EditorBuffer } from "../../input/editor-buffer.ts"
import { ansiStyle as c } from "../../terminal-kit/ansi.ts"

export interface EditorRendererOptions {
  prompt: string
  continuationPrompt: string
  /**
   * When `true`, invisible characters are rendered as faint glyphs:
   * spaces → `·`, tabs → `→`, line-ends → `↵`. Useful for
   * debugging whitespace in multiline inputs.
   */
  showHidden?: boolean
}

export interface EditorRenderOptions {
  firstRow?: number
  rowCount?: number
  /**
   * Terminal width in cells. When provided, output lines are pre-wrapped to
   * fit within this width and the returned cursor is in physical
   * (post-wrap) coordinates. Strongly recommended for TTY callers — without
   * it the cursor column can exceed terminal width and get clamped to the
   * right edge by the terminal.
   */
  columns?: number
  /**
   * Absolute buffer style spans (code-point offsets into `buf.toString()`,
   * with `\n` counting as 1). When omitted, uses the last value passed to
   * {@link EditorRenderer.setStyles} (default empty). Styles are ANSI-only
   * and never affect cursor column math or wrap width.
   */
  styles?: readonly BufferStyleSpan[]
}

/**
 * Stateless painter that turns an {@link EditorBuffer} into prompt-prefixed
 * terminal rows and a cursor position for the live area. Prompt widths are
 * measured once in the constructor; soft-wrapping happens per render when
 * `columns` is supplied.
 */
export class EditorRenderer {
  private prompt: string
  private continuationPrompt: string
  private promptWidth: number
  private continuationPromptWidth: number
  private showHidden: boolean
  /** Last styles set via {@link setStyles}; overridden per-render by opts.styles. */
  private styles: readonly BufferStyleSpan[] = []

  constructor(opts: EditorRendererOptions) {
    this.prompt = opts.prompt
    this.continuationPrompt = opts.continuationPrompt
    this.promptWidth = displayWidth(opts.prompt)
    this.continuationPromptWidth = displayWidth(opts.continuationPrompt)
    this.showHidden = opts.showHidden ?? false
  }

  /**
   * Enable or disable visible rendering of invisible characters. Takes
   * effect on the next call to {@link render}.
   */
  setShowHidden(v: boolean): void {
    this.showHidden = v
  }

  /**
   * Install buffer style spans for subsequent {@link render} calls.
   * Pass `[]` to clear. Does not repaint on its own — the controller
   * owns that. Per-call `opts.styles` on {@link render} overrides this.
   */
  setStyles(spans: readonly BufferStyleSpan[]): void {
    this.styles = spans
  }

  /**
   * Update the prompt prefix(es). Used when the active mode changes and
   * the prompt label needs to reflect the new mode (e.g. `ASK ❯ `).
   * `continuationPrompt` is optional — pass undefined to keep the current.
   */
  setPrompt(prompt: string, continuationPrompt?: string): void {
    this.prompt = prompt
    this.promptWidth = displayWidth(prompt)
    if (continuationPrompt !== undefined) {
      this.continuationPrompt = continuationPrompt
      this.continuationPromptWidth = displayWidth(continuationPrompt)
    }
  }

  /**
   * Current prompt prefix string, with any ANSI styling intact. Read-only
   * accessor for callers that need to compose adjacent UI affordances
   * (e.g. the "↑ N more lines" scroll indicator in
   * {@link EditorController}, which prepends this prefix so the user can
   * always tell what mode is active even when the buffer is scrolled and
   * the natural prompt-bearing row is hidden above the viewport).
   */
  getPrompt(): string {
    return this.prompt
  }

  /**
   * Display width (in terminal cells) of {@link getPrompt}. Pre-computed
   * — `displayWidth` is not called per access.
   */
  getPromptDisplayWidth(): number {
    return this.promptWidth
  }

  /**
   * Display width (in terminal cells) of the continuation prompt used on
   * logical rows \> 0. Used by the controller's wrap-aware up/down
   * navigation to compute which physical row a cursor sits on.
   */
  getContinuationPromptDisplayWidth(): number {
    return this.continuationPromptWidth
  }

  /**
   * Width of the prompt prefix used for a given logical row index: the
   * main prompt on row 0, the continuation prompt on later rows. Pure
   * accessor; pre-computed widths, no allocation.
   */
  promptDisplayWidthForRow(row: number): number {
    return row === 0 ? this.promptWidth : this.continuationPromptWidth
  }

  render(
    buf: EditorBuffer,
    opts?: EditorRenderOptions,
  ): {
    lines: string[]
    cursor: { row: number; col: number }
  } {
    const firstRow = Math.max(0, opts?.firstRow ?? 0)
    const totalRows = buf.lines.length
    const rowCount = Math.max(
      0,
      Math.min(opts?.rowCount ?? totalRows - firstRow, totalRows - firstRow),
    )
    const cols = opts?.columns
    const wrap = typeof cols === "number" && cols > 0
    const styles = opts?.styles ?? this.styles
    // Absolute code-point offsets of each logical line start in buf.toString().
    // Built only when styles are present so the no-style path stays allocation-free.
    const lineAbsStarts =
      styles.length > 0 ? buildLineAbsStarts(buf.lines) : (null as number[] | null)

    const lines: string[] = []
    let cursorRow = 0
    let cursorCol = 0
    let cursorPlaced = false

    for (let i = 0; i < rowCount; i++) {
      const logical = firstRow + i
      const isFirstLogical = logical === 0
      const prompt = isFirstLogical ? this.prompt : this.continuationPrompt
      const promptW = isFirstLogical ? this.promptWidth : this.continuationPromptWidth
      const lineText = buf.lines[logical]
      const cells = lineCells(lineText)
      // Style of each code point of this line, or null when no span covers it.
      const styleAt = lineAbsStarts
        ? resolveLineStyles(codePointCount(lineText), lineAbsStarts[logical]!, styles)
        : null
      const isNonLastLine = logical < totalRows - 1

      if (!wrap) {
        // One row for the logical line. A tab is painted as spaces here too,
        // so the cursor column counts the same cells the terminal shows.
        lines.push(
          prompt +
            paintCells(cells, styleAt, this.showHidden) +
            (this.showHidden && isNonLastLine ? HIDDEN_NEWLINE : ""),
        )
        if (logical === buf.row) {
          cursorRow = i
          cursorCol = promptW + buf.col + tabExtraCells(lineText, buf.col)
          cursorPlaced = true
        }
        continue
      }

      const startPhysical = lines.length
      // Each chunk is a run of cells for one physical row. A cell keeps the
      // index of its code point, so styles re-apply across wrap boundaries.
      const chunks = wrapCells(cells, cols, promptW)
      for (let k = 0; k < chunks.length; k++) {
        const painted =
          paintCells(chunks[k]!, styleAt, this.showHidden) +
          (this.showHidden && isNonLastLine && k === chunks.length - 1 ? HIDDEN_NEWLINE : "")
        lines.push((k === 0 ? prompt : "") + painted)
      }

      if (logical === buf.row) {
        const colW = displayWidthOfChars(lineText, buf.col)
        const total = promptW + colW
        const atExactFill = total > 0 && total % cols === 0
        if (atExactFill) {
          // Editor uses "post-insert" cursor placement: at a wrap boundary,
          // park the cursor at col 0 of the next physical row (where the
          // next typed character will land), not at col `cols` of the
          // current row (which terminals clamp onto the last printed cell,
          // making it look like the next keystroke will replace it).
          //
          // The next row already exists when there is more content after
          // buf.col; if the cursor is at end-of-line we materialize a
          // phantom empty row so it has a home.
          const atEndOfLine = buf.col === codePointCount(lineText)
          if (atEndOfLine) lines.push("")
          cursorRow = startPhysical + total / cols
          cursorCol = 0
        } else {
          cursorRow = startPhysical + cursorRowOffset(promptW, colW, cols)
          cursorCol = cursorVisualCol(promptW, colW, cols)
        }
        cursorPlaced = true
      }
    }

    if (!cursorPlaced) {
      // Cursor's logical row is outside the window — clamp to last visible
      // physical row, column 0 (best-effort; matches legacy behavior).
      cursorRow = Math.max(0, lines.length - 1)
      cursorCol = 0
    }

    return { lines, cursor: { row: cursorRow, col: cursorCol } }
  }

  /**
   * Number of physical terminal rows the buffer needs to render without
   * truncation. When `columns` is provided, accounts for soft-wrap of long
   * logical lines using a display-width model that handles ANSI, wide
   * glyphs and combining marks; otherwise returns one row per logical line
   * (legacy behavior).
   *
   * Callers driving a Compositor live area should always pass `columns` —
   * otherwise wrapped lines will spill out of the reserved live region.
   */
  measureRows(buf: EditorBuffer, columns?: number): number {
    if (!columns || columns <= 0) return buf.lines.length
    let total = 0
    for (let i = 0; i < buf.lines.length; i++) {
      const promptW = i === 0 ? this.promptWidth : this.continuationPromptWidth
      const w = promptW + editorLineWidth(buf.lines[i])
      let rows = wrapRows(w, columns)
      // Phantom row when the cursor sits at end of an exact-fill line —
      // must match the renderer's `lines.push("")` branch above.
      if (i === buf.row && buf.col === codePointCount(buf.lines[i]) && w > 0 && w % columns === 0) {
        rows += 1
      }
      total += rows
    }
    return Math.max(1, total)
  }
}

/** Number of code points in `text` (matches EditorBuffer's column model). */
function codePointCount(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)
    if (cp === undefined) break
    i += cp > 0xffff ? 2 : 1
    n += 1
  }
  return n
}

/**
 * Cells between tab stops in the editor. The renderer paints a tab as spaces
 * up to the next stop, counted from the start of the line content (after the
 * prompt), so the same text has the same shape on every row.
 *
 * The terminal never gets a raw tab from the editor. A terminal moves a tab
 * to ITS next stop, counted from the left edge of the screen, so the width of
 * a raw tab depends on the prompt and on the wrap position, and no width
 * table can give it. Rows with a raw tab were wider on screen than the
 * renderer measured (`codePointWidth` gives a tab 0 cells), the terminal
 * wrapped them, and the compositor erase stopped short: each repaint left one
 * more copy of the frame on screen (user report Nov 20 2026, a paste of
 * `cat -n` text).
 */
export const EDITOR_TAB_STOP = 8

/** Cells a tab uses when it starts `contentCol` cells into the line content. */
function tabCells(contentCol: number): number {
  return EDITOR_TAB_STOP - (contentCol % EDITOR_TAB_STOP)
}

/**
 * Display width of the first `charCount` code points of `text`, with each tab
 * counted as the cells to its next stop. `charCount` is in code-point units
 * (matching {@link EditorBuffer}'s column model).
 */
function displayWidthOfChars(text: string, charCount: number): number {
  let width = 0
  let consumed = 0
  for (let i = 0; i < text.length && consumed < charCount; ) {
    const cp = text.codePointAt(i)
    if (cp === undefined) break
    width += cp === 0x09 ? tabCells(width) : codePointWidth(cp)
    i += cp > 0xffff ? 2 : 1
    consumed += 1
  }
  return width
}

/**
 * Display width, in terminal cells, of one logical editor line as the
 * renderer paints it: plain text with no ANSI, each tab counted as the cells
 * to its next stop. Use this, not `displayWidth`, for any wrap math on buffer
 * text.
 */
export function editorLineWidth(text: string): number {
  return displayWidthOfChars(text, Number.POSITIVE_INFINITY)
}

/**
 * Cells that the tabs among the first `charCount` code points add beyond one
 * cell each. The no-wrap layout counts one cell for each code point, so this
 * is the correction for its cursor column.
 */
function tabExtraCells(text: string, charCount: number): number {
  if (!text.includes("\t")) return 0
  let width = 0
  let extra = 0
  let consumed = 0
  for (let i = 0; i < text.length && consumed < charCount; ) {
    const cp = text.codePointAt(i)
    if (cp === undefined) break
    if (cp === 0x09) {
      const w = tabCells(width)
      extra += w - 1
      width += w
    } else {
      width += codePointWidth(cp)
    }
    i += cp > 0xffff ? 2 : 1
    consumed += 1
  }
  return extra
}

/**
 * Visual position of a cursor sitting `col` code points into a logical line
 * `text` whose prompt prefix occupies `promptW` cells, in a terminal of
 * `cols` cells wide.
 *
 * - `visualRow` (0-based) is the physical row within the logical line.
 * - `visualCol` (0-based, 0..cols-1) is the cell column within `visualRow`.
 * - `rowsInLine` is how many physical rows the whole logical line occupies.
 *
 * Returns `{ visualRow: 0, visualCol: promptW, rowsInLine: 1 }` when
 * `cols <= 0` (no-wrap layout). Callers should treat that as "no visual
 * navigation possible" and fall back to logical row movement.
 *
 * Used by the controller's wrap-aware up/down arrow navigation so a long
 * wrapped logical line walks visual row at a time instead of jumping the
 * whole line per keystroke.
 */
export function computeCursorVisualPos(
  text: string,
  col: number,
  promptW: number,
  cols: number,
): { visualRow: number; visualCol: number; rowsInLine: number } {
  if (cols <= 0) {
    return { visualRow: 0, visualCol: promptW, rowsInLine: 1 }
  }
  const colCells = displayWidthOfChars(text, col)
  const totalCells = promptW + colCells
  const lineWidth = promptW + editorLineWidth(text)
  // Use the same wrap math as the renderer. Both `cursorRowOffset` and
  // `cursorVisualCol` (from term-width.ts) park the exact-fill cursor at
  // the end of the current row; we follow the same convention so the
  // visual position we return matches what the user sees.
  const visualRow = totalCells <= 0 ? 0 : Math.floor(Math.max(0, totalCells - 1) / cols)
  const mod = totalCells === 0 ? 0 : totalCells % cols
  const visualCol = mod === 0 && totalCells > 0 ? cols : mod
  const rowsInLine = lineWidth <= 0 ? 1 : Math.max(1, Math.ceil(lineWidth / cols))
  return { visualRow, visualCol, rowsInLine }
}

/**
 * Inverse of {@link computeCursorVisualPos}: given a logical line, a
 * target physical row within that line, and a desired visual column
 * (cell offset from the left edge), return the buffer's code-point
 * column the cursor should sit at.
 *
 * - `targetVisualRow` is 0-based within the logical line; values
 *   beyond the line's actual `rowsInLine` are clamped to the last row.
 * - `targetVisualCol` is 0-based and may be greater than the content
 *   of the target row, in which case the cursor lands at end-of-row
 *   (or end-of-line on the last row, matching the "stop at the visible
 *   tail" UX users expect from arrow nav).
 *
 * The prompt prefix of `promptW` cells occupies the head of `visualRow=0`,
 * so a `targetVisualRow=0`, `targetVisualCol=0` request returns col 0
 * regardless of `promptW` (the cursor parks just after the prompt; the
 * caller doesn't see negative columns).
 */
export function findColAtVisualPos(
  text: string,
  targetVisualRow: number,
  targetVisualCol: number,
  promptW: number,
  cols: number,
): number {
  if (cols <= 0 || targetVisualRow < 0) return 0
  // Total cells from line start to target visual position.
  const rowStartCells = targetVisualRow * cols
  // First row starts after the prompt; later rows start at col 0.
  const targetTotalCells = rowStartCells + targetVisualCol
  // Walk the line counting cells until we exceed targetTotalCells - promptW.
  const targetContentCells = Math.max(0, targetTotalCells - promptW)
  let cells = 0
  let col = 0
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)
    if (cp === undefined) break
    const ch = String.fromCodePoint(cp)
    const w = cp === 0x09 ? tabCells(cells) : codePointWidth(cp)
    // If consuming this char would put us past the target, stop here.
    // Tie-break: when `cells + w === targetContentCells` we consume (the
    // cursor sits AFTER the char, which is how all other editors render
    // a cursor at the right edge of a glyph).
    if (cells + w > targetContentCells) return col
    cells += w
    col += 1
    i += ch.length
  }
  return col
}

/**
 * One painted unit of a logical line. Most code points give one cell entry of
 * their display width (0 for a combining mark, 2 for a wide glyph). A tab
 * gives one entry of width 1 for each cell to its next stop, so a wrap can
 * fall inside it.
 */
interface LineCell {
  /** Text to paint: the code point, or one space for a cell of a tab. */
  text: string
  /** Index of the source code point in the logical line. */
  cp: number
  /** Display width in terminal cells. */
  width: number
  /** `head` for the first cell of a tab, `fill` for its other cells. */
  tab?: "head" | "fill"
}

/** Split a logical line into {@link LineCell}s, with tabs expanded. */
function lineCells(text: string): LineCell[] {
  const cells: LineCell[] = []
  let col = 0
  let index = 0
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)
    if (cp === undefined) break
    const ch = String.fromCodePoint(cp)
    i += ch.length
    if (cp === 0x09) {
      const n = tabCells(col)
      for (let k = 0; k < n; k++) {
        cells.push({ text: " ", cp: index, width: 1, tab: k === 0 ? "head" : "fill" })
      }
      col += n
    } else {
      const width = codePointWidth(cp)
      cells.push({ text: ch, cp: index, width })
      col += width
    }
    index += 1
  }
  return cells
}

/**
 * Split `cells` into chunks such that each chunk's display width fits within
 * the available cells of its physical row. The first chunk is sized for
 * `cols - firstPromptW` cells (because the prompt occupies the head of the
 * first physical row); subsequent chunks get the full `cols` width.
 *
 * Always returns at least one chunk (possibly empty) so the caller can
 * still emit the prompt-only row for empty buffers.
 */
function wrapCells(cells: readonly LineCell[], cols: number, firstPromptW: number): LineCell[][] {
  const result: LineCell[][] = []
  let cap = Math.max(1, cols - firstPromptW)
  let cur: LineCell[] = []
  let curW = 0
  for (const cell of cells) {
    if (curW + cell.width > cap) {
      result.push(cur)
      cur = []
      curW = 0
      cap = cols
    }
    cur.push(cell)
    curW += cell.width
  }
  if (result.length === 0 || cur.length > 0) result.push(cur)
  return result
}

/**
 * Absolute code-point offset of each logical line start in `lines.join("\\n")`.
 * Line i starts at the sum of prior line code-point lengths, each plus one for
 * the newline separator (except after the last line).
 */
function buildLineAbsStarts(lines: readonly string[]): number[] {
  const starts: number[] = new Array(lines.length)
  let abs = 0
  for (let i = 0; i < lines.length; i++) {
    starts[i] = abs
    abs += codePointCount(lines[i]!) + (i < lines.length - 1 ? 1 : 0)
  }
  return starts
}

/**
 * Style of each of the `count` code points of a logical line that starts at
 * absolute offset `absStart`, or null where no span covers it. Later spans
 * win when spans overlap. Returns null when no span touches the line.
 */
function resolveLineStyles(
  count: number,
  absStart: number,
  styles: readonly BufferStyleSpan[],
): (string | null)[] | null {
  if (count === 0 || styles.length === 0) return null
  let styleAt: (string | null)[] | null = null
  for (const span of styles) {
    if (typeof span.start !== "number" || typeof span.end !== "number") continue
    if (typeof span.style !== "string" || span.style.length === 0) continue
    if (!(span.end > span.start)) continue
    const from = Math.max(0, span.start - absStart)
    const to = Math.min(count, span.end - absStart)
    if (from >= to) continue
    styleAt ??= new Array<string | null>(count).fill(null)
    for (let i = from; i < to; i++) styleAt[i] = span.style
  }
  return styleAt
}

/**
 * Text for one physical row of `cells`.
 *
 * Runs of cells with the same style get its SGR open and a `\x1b[0m` reset,
 * so the plain text after a run is unstyled. Styles never change display
 * width: only ANSI is inserted.
 *
 * With `showHidden`, a space becomes a faint `·` (U+00B7) and the first cell
 * of a tab a faint `→` (U+2192); the other cells of the tab stay blank. Each
 * glyph uses one cell, the same as the cell it replaces, so cursor positions
 * stay valid.
 */
function paintCells(
  cells: readonly LineCell[],
  styleAt: readonly (string | null)[] | null,
  showHidden: boolean,
): string {
  let out = ""
  let i = 0
  while (i < cells.length) {
    const style = styleAt ? (styleAt[cells[i]!.cp] ?? null) : null
    let run = ""
    let j = i
    while (j < cells.length && (styleAt ? (styleAt[cells[j]!.cp] ?? null) : null) === style) {
      run += cellText(cells[j]!, showHidden)
      j++
    }
    out += style ? `${style}${run}\x1b[0m` : run
    i = j
  }
  return out
}

function cellText(cell: LineCell, showHidden: boolean): string {
  if (!showHidden) return cell.text
  if (cell.tab === "head") return HIDDEN_TAB
  if (cell.tab === "fill") return " "
  return cell.text === " " ? HIDDEN_SPACE : cell.text
}

/**
 * Faint newline glyph appended at the end of every non-last logical line
 * when show-hidden mode is active.
 */
const HIDDEN_NEWLINE = c.dim("\u21b5")

/** Faint `·` (U+00B7 MIDDLE DOT) for a space in show-hidden mode. */
const HIDDEN_SPACE = c.dim("\u00b7")

/** Faint `→` (U+2192 RIGHTWARDS ARROW) for the first cell of a tab in show-hidden mode. */
const HIDDEN_TAB = c.dim("\u2192")
