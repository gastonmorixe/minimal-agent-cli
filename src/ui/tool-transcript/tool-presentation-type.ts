/**
 * The {@link ToolPresentation} type: a leaf module with no imports, so
 * `format.ts` and `frame-tint.ts` can both use it with no import cycle.
 * `format.ts` re-exports it, so the old import path still works.
 *
 * @module ui/tool-transcript/tool-presentation-type
 */

/**
 * Cosmetic per-tool presentation hints stripped from tool definitions before
 * they go on the model wire. The transcript renderer owns how these hints are
 * applied to the TUI frame.
 */
export interface ToolPresentation {
  /** Glyph drawn before the bold tool name in the transcript header. */
  icon?: string
  /** Palette key (a method name on `c`) for the icon + label color. */
  color?: string
  /**
   * Input field whose value can headline the transcript header before the
   * handler returns.
   */
  headerKey?: string
}
