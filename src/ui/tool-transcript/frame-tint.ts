/**
 * The color of the frame glyphs (`╭ │ ┊ ╰`) of one tool transcript block.
 *
 * A tool with a known presentation color gets a dim version of that color,
 * so the frame of an `Edit` block (gold) is dim gold. All other tools keep
 * the historical `c.dimCyan` frame, byte for byte.
 *
 * @module ui/tool-transcript/frame-tint
 */

import { type AnsiWrapper, combo } from "../../terminal-kit/ansi.ts"
import { PALETTE, type PaletteName } from "../../terminal-kit/palette.ts"
import { c } from "../style/ansi.ts"
import type { ToolPresentation } from "./format.ts"

/** The SGR close of a dim foreground frame glyph. Same as `c.dimCyan`. */
const DIM_FG_CLOSE = "\x1b[22;39m"

/**
 * The frame glyph wrapper for a tool presentation.
 *
 * The `color` key must be a `c` helper (the label color) and a
 * {@link PALETTE} name. Then the open SGR is the palette code with a dim
 * prefix in one sequence (gold: `\x1b[2;38;5;214m`). An absent, empty, or
 * unknown key gives `c.dimCyan`. Pure: the same input gives the same bytes.
 */
export function frameTint(presentation?: ToolPresentation | null): AnsiWrapper {
  const key = presentation?.color
  if (!key || !Object.hasOwn(c, key) || !Object.hasOwn(PALETTE, key)) return c.dimCyan
  const open = PALETTE[key as PaletteName]
  return combo(`\x1b[2;${open.slice(2)}`, DIM_FG_CLOSE)
}
