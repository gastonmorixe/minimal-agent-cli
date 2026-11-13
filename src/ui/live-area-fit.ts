/**
 * Fit the live area to the terminal viewport.
 *
 * The compositor erases the live area with relative cursor moves
 * (`ESC[nA` then `ESC[J`). A terminal stops `ESC[nA` at the top row of
 * the viewport. So the compositor can only erase rows that are still on
 * screen. When the live area is taller than the viewport, its top rows
 * scroll into scrollback as the terminal paints them, and each repaint
 * leaves one more copy there.
 *
 * The functions here keep the painted live area inside the viewport, so
 * every row the compositor owns stays in reach of the erase.
 *
 * @module ui/live-area-fit
 */

import { truncateDisplayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"

import { c } from "./style/ansi.ts"

/** Cursor position inside the live area, 0-based. */
export interface LiveCursor {
  row: number
  col: number
}

/** A live area that fits the row budget. */
export interface FittedLiveArea {
  lines: string[]
  cursor: LiveCursor | null
}

/**
 * Viewport rows the compositor owns above the live area: the row of a
 * partial stream line, and one blank separator row.
 */
const ROWS_ABOVE_LIVE = 2

/**
 * Max rows the live area may use in a viewport of `viewportRows` rows.
 *
 * @param viewportRows - Terminal rows, or a value of 0 or less when unknown.
 * @returns The row budget, at least 1. Infinity when the row count is unknown.
 */
export function liveAreaRowBudget(viewportRows: number | undefined): number {
  if (typeof viewportRows !== "number" || !Number.isFinite(viewportRows) || viewportRows <= 0) {
    return Number.POSITIVE_INFINITY
  }
  return Math.max(1, Math.floor(viewportRows) - ROWS_ABOVE_LIVE)
}

/**
 * Clip `lines` to `maxRows` rows and keep the cursor row visible.
 *
 * Rows drop from the bottom first, because the bottom rows are the footer
 * and the top rows are the status row and the prompt. If the cursor row is
 * below the budget, the window moves down until the cursor row is its last
 * row. The last visible row then shows a count of the hidden rows, unless
 * that row holds the cursor or is the only row.
 *
 * @param lines - Live-area rows, each at most one terminal row wide.
 * @param cursor - Cursor position inside `lines`, or null when hidden.
 * @param maxRows - Row budget from {@link liveAreaRowBudget}.
 * @param columns - Terminal width, used to clip the marker row.
 * @returns The input when it fits, or a clipped copy.
 */
export function fitLiveAreaToRows(
  lines: string[],
  cursor: LiveCursor | null,
  maxRows: number,
  columns?: number,
): FittedLiveArea {
  if (lines.length <= maxRows) return { lines, cursor }
  const budget = Math.max(1, Math.floor(maxRows))
  const cursorRow = cursor ? Math.min(Math.max(0, cursor.row), lines.length - 1) : 0
  const top = Math.max(0, cursorRow - budget + 1)
  const visible = lines.slice(top, top + budget)
  const markerRow = visible.length - 1
  const cursorRowInWindow = cursorRow - top
  if (markerRow > 0 && !(cursor && cursorRowInWindow === markerRow)) {
    // The marker replaces one visible row, so that row is hidden too.
    const hidden = lines.length - visible.length + 1
    visible[markerRow] = hiddenRowsMarker(hidden, columns)
  }
  return {
    lines: visible,
    cursor: cursor ? { row: cursorRowInWindow, col: cursor.col } : null,
  }
}

function hiddenRowsMarker(hidden: number, columns: number | undefined): string {
  const text = `… +${hidden} more row${hidden === 1 ? "" : "s"}`
  // Stay under the terminal width, like every other live-area row.
  const width = typeof columns === "number" && columns > 1 ? columns - 1 : 0
  return c.dim(width > 0 ? truncateDisplayWidth(text, width) : text)
}
