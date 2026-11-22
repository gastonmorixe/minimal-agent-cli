/**
 * The display-cell model of one logical editor line (renderer helpers).
 *
 * A line becomes a list of {@link LineCell}s: one cell for each code point,
 * one cell for each column of a tab, and the cells of the label of each
 * atomic chip span (paste plugin v3, D2). The wrap and the cursor maps read
 * the same cells, so the cursor stays on the cell that the terminal shows.
 *
 * @module ui/editor/line-cells
 */

import { codePointWidth } from "@minimal-agent/core/plugin-api/utils/term-width"
import type { ChipSpan } from "../../paste/chip-registry.ts"

/** See `EDITOR_TAB_STOP` in `renderer.ts`: cells between tab stops. */
export const EDITOR_TAB_STOP = 8

/** No chip spans. */
export const NO_CHIP_SPANS: readonly ChipSpan[] = []

/** Cells a tab uses when it starts `contentCol` cells into the line content. */
export function tabCells(contentCol: number): number {
  return EDITOR_TAB_STOP - (contentCol % EDITOR_TAB_STOP)
}

/**
 * One painted unit of a logical line. Most code points give one cell entry of
 * their display width (0 for a combining mark, 2 for a wide glyph). A tab
 * gives one entry of width 1 for each cell to its next stop, so a wrap can
 * fall inside it. A chip gives one entry for each code point of its label.
 */
export interface LineCell {
  /** Text to paint: the code point, or one space for a cell of a tab. */
  text: string
  /** Index of the source code point in the logical line (a chip: its span start). */
  cp: number
  /** Display width in terminal cells. */
  width: number
  /** `head` for the first cell of a tab, `fill` for its other cells. */
  tab?: "head" | "fill"
  /** Set on each cell of a chip label. `head` is the first cell. */
  chip?: { part: "head" | "fill"; end: number; width: number }
}

/** Split a logical line into {@link LineCell}s, with tabs and chips expanded. */
export function lineCells(text: string, spans: readonly ChipSpan[] = NO_CHIP_SPANS): LineCell[] {
  const cells: LineCell[] = []
  let col = 0
  let index = 0
  let next = 0
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)
    if (cp === undefined) break
    const ch = String.fromCodePoint(cp)
    i += ch.length
    const span = spans[next]
    if (span !== undefined && span.start === index) {
      // Paint the label once, then skip the code points of the node.
      const labelCells = Array.from(span.label).map((c) => ({
        text: c,
        width: codePointWidth(c.codePointAt(0) ?? 0),
      }))
      const width = labelCells.reduce((sum, c) => sum + c.width, 0)
      labelCells.forEach((c, k) => {
        cells.push({
          text: c.text,
          cp: span.start,
          width: c.width,
          chip: { part: k === 0 ? "head" : "fill", end: span.end, width },
        })
      })
      col += width
      next += 1
      index += 1
      while (index < span.end && i < text.length) {
        const skip = text.codePointAt(i) ?? 0
        i += skip > 0xffff ? 2 : 1
        index += 1
      }
      continue
    }
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
 * A chip is not split: when it does not fit in the rest of a row that has
 * content, the row breaks before it. Only a chip wider than a whole row is
 * cut at the row end.
 *
 * Always returns at least one chunk (possibly empty) so the caller can
 * still emit the prompt-only row for empty buffers.
 */
export function wrapCells(
  cells: readonly LineCell[],
  cols: number,
  firstPromptW: number,
): LineCell[][] {
  const result: LineCell[][] = []
  let cap = Math.max(1, cols - firstPromptW)
  let cur: LineCell[] = []
  let curW = 0
  for (const cell of cells) {
    const head = cell.chip?.part === "head" ? cell.chip : undefined
    // A chip head breaks the row when the whole chip does not fit. With an
    // empty row it breaks only when the chip fits in a full row.
    const breakHere = head
      ? curW + head.width > cap && (cur.length > 0 || head.width <= cols)
      : curW + cell.width > cap
    if (breakHere) {
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

/** Width in cells of a chunk, with the prompt on chunk 0. */
function chunkWidth(chunk: readonly LineCell[], k: number, promptW: number): number {
  let w = k === 0 ? promptW : 0
  for (const cell of chunk) w += cell.width
  return w
}

/**
 * The physical place of a cursor at buffer column `col`, in a line that the
 * caller wrapped into `chunks`. The cursor sits before the first cell of a
 * code point at or after `col` (a chip cell counts at its span start). At
 * the end of the line it sits after the last cell; `phantom` is true when
 * that place is past a full row (the renderer then adds an empty row).
 */
export function cursorInChunks(
  chunks: readonly (readonly LineCell[])[],
  col: number,
  promptW: number,
  cols: number,
): { row: number; col: number; phantom: boolean } {
  for (let k = 0; k < chunks.length; k++) {
    let x = k === 0 ? promptW : 0
    for (const cell of chunks[k]!) {
      if (cell.cp >= col) return { row: k, col: x, phantom: false }
      x += cell.width
    }
  }
  const last = chunks.length - 1
  const w = chunkWidth(chunks[last] ?? [], last, promptW)
  if (w > 0 && w >= cols) return { row: last + 1, col: 0, phantom: true }
  return { row: last, col: w, phantom: false }
}

/**
 * The buffer column for a target cell `targetCol` (from the left edge) on
 * physical row `targetRow` of a wrapped line. The cursor lands on a unit edge
 * (a chip and a tab are one unit). Past the content of a row that is not the
 * last, it lands before the last unit of that row, so it stays on that row.
 */
export function colInChunks(
  chunks: readonly (readonly LineCell[])[],
  targetRow: number,
  targetCol: number,
  promptW: number,
  lineLength: number,
): number {
  const k = Math.max(0, Math.min(targetRow, chunks.length - 1))
  const chunk = chunks[k] ?? []
  // An empty row (a chip that breaks before itself on row 0) holds no unit:
  // the cursor goes to the first unit of the next row, not to the line end.
  if (chunk.length === 0) return chunks[k + 1]?.[0]?.cp ?? 0
  let x = k === 0 ? promptW : 0
  let col = chunk[0]?.cp ?? lineLength
  let lastStart = col
  for (let j = 0; j < chunk.length; ) {
    const cell = chunk[j]!
    // One unit: the cells that share a code point index (chip or tab).
    let w = 0
    let n = j
    while (n < chunk.length && chunk[n]!.cp === cell.cp) {
      w += chunk[n]!.width
      n += 1
    }
    if (x + w > targetCol) return cell.cp
    x += w
    lastStart = cell.cp
    col = cell.chip ? cell.chip.end : cell.cp + 1
    j = n
  }
  if (k < chunks.length - 1) return lastStart
  return Math.min(col, lineLength)
}

/** Physical rows of a wrapped line, with the phantom row of an exact fill when the cursor is at the end. */
export function rowsOfChunks(
  chunks: readonly (readonly LineCell[])[],
  promptW: number,
  cols: number,
  cursorAtEnd: boolean,
): number {
  const last = chunks.length - 1
  const full = chunkWidth(chunks[last] ?? [], last, promptW) >= cols
  return chunks.length + (cursorAtEnd && full ? 1 : 0)
}
