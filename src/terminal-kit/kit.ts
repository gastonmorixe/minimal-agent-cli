/**
 * The terminal kit that the CLI grants to plugin `ui` code (S41).
 *
 * Plugin `ui` modules get it through `ctx.tui.kit`. A `ui.setup` module
 * passes it to `StyleSlots.install`, so the plugin's headless renderers
 * paint with the host styles. Headless hosts never build a kit.
 *
 * @module terminal-kit/kit
 */

import type {
  TerminalCodes,
  TerminalKit,
  TerminalPalette,
  TerminalStyles,
} from "@minimal-agent/core/plugin-api/utils/style-slots"

import { ANSI_CODES, ansiStyle, bgRgb } from "./ansi.ts"
import { PALETTE } from "./palette.ts"
import { renderUnifiedDiff } from "./unified-diff.ts"

/** The CLI terminal kit. One frozen value: every field is a pure helper. */
export const TERMINAL_KIT: TerminalKit = Object.freeze({
  codes: ANSI_CODES satisfies TerminalCodes,
  styles: ansiStyle satisfies TerminalStyles,
  palette: PALETTE satisfies TerminalPalette,
  bgRgb,
  renderUnifiedDiff,
})
