/**
 * Re-export shim — the mode-style resolver's real implementation now lives
 * in the leaf contract package at `./terminal-kit/mode-style.ts` (spec S33;
 * this file used to re-export core's temporary `src/internal/terminal-render`
 * bridge copy, which existed only to keep core's own `src/modes/modes.ts`
 * and this file compiling until S34 moved this file out of core — that move
 * is this commit, so the bridge is no longer needed here). This file stays
 * at its path for back-compat with existing importers (`mode.test.ts`, etc.).
 *
 * @module ui/style/mode
 */

export * from "../../terminal-kit/mode-style.ts"
