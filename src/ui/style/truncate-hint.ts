/**
 * User-facing truncation hint: the `...(+N<unit>)` dialect used in tool
 * transcript headers/previews and the queue decoration, and any future
 * place where the TUI elides long content for display.
 *
 * Goal: one canonical visual idiom across the whole TUI so a user who
 * sees `...(+45ch)` in a Bash header recognizes the same shape in a Read
 * preview, regardless of which subsystem produced it.
 *
 * Design notes:
 *
 *  - **No color in here.** Callers wrap the composed string in `c.dim`,
 *    `c.red`, etc. Returning bare characters avoids ANSI nesting bugs
 *    where an inner reset (`\x1b[22m`) would prematurely close an outer
 *    dim wrapper.
 *
 *  - **For humans, not the model.** Core's tool truncation produces a
 *    structured `[truncated: shown N of M bytes, ...]` notice that goes
 *    back to the *model* as a resume hint. This module is for *humans*
 *    looking at the TUI.
 *
 *  - **Unit codes** are deliberately terse to keep the hint short:
 *      `ch` = characters
 *      `B`  = bytes
 *      `L`  = lines
 *    Add new units sparingly: every new code is a small cognitive tax
 *    on users skimming the transcript.
 *
 * Core keeps its own private copy of the same idiom for the debug request
 * dump. Keep the two in step.
 *
 * @module ui/style/truncate-hint
 */

/** Unit suffix appended after the elided count. See module docs. */
export type TruncUnit = "ch" | "B" | "L"

/**
 * Compact "how much was elided" suffix, e.g. `...(+312ch)` or `...(+4L)`.
 *
 * Returns the empty string when `n <= 0` so callers can do
 * `body + truncHint(remaining)` without guarding the zero case.
 */
export function truncHint(n: number, unit: TruncUnit = "ch"): string {
  if (n <= 0) return ""
  return `...(+${n}${unit})`
}
