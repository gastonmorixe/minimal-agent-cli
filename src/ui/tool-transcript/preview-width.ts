/**
 * Tool-preview body width helper, shared by `format.ts` and
 * `diagnostics-panel.ts`.
 *
 * @module ui/tool-transcript/preview-width
 */

export const TOOL_PREVIEW_GUTTER_WIDTH = 4
export const TOOL_PREVIEW_WRAP_SAFETY_WIDTH = 1

/**
 * Compute the safe body width for a tool transcript line as
 * `terminal_cols - gutter - wrap_safety`. Returns `undefined` when the
 * caller has no width signal (non-TTY contexts like unit tests where
 * `process.stdout.columns` is also unset). That sentinel lets the
 * display-channel branch (Edit/Write diffs) opt out of clamping when
 * width is unknown : tests get deterministic full-width output, and
 * production gets a real number.
 *
 * The `gutter` accounts for the `"  │ "` (or `"  ╰ "`) prefix every row
 * carries (4 cells); the 1-cell `WRAP_SAFETY` keeps a column free at the
 * right edge so a single off-by-one in a wide-glyph terminal can't tip
 * the line into a wrap.
 */
export function toolPreviewBodyWidth(cols?: number): number | undefined {
  const raw = cols ?? process.stdout.columns
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined
  const max = Math.floor(raw) - TOOL_PREVIEW_GUTTER_WIDTH - TOOL_PREVIEW_WRAP_SAFETY_WIDTH
  return max > 0 ? max : 0
}
