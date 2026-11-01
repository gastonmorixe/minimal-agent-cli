/**
 * Mode-style SGR mapper.
 *
 * Core's `ModeManager` resolves a plugin manifest's declarative
 * `ModeStyleRequest` to host-neutral {@link ModeStyle} tokens (core
 * `src/modes/mode-style.ts`, decision 26). Core holds no terminal code.
 * This module maps those tokens to concrete SGR sequences, so the TUI can
 * render a mode without making any color decisions of its own.
 *
 *   manifest.json  ──parse──▶  ModeStyleRequest
 *                                    │
 *              core resolveModeStyleTokens(request, theme)
 *                                    │
 *                                    ▼
 *                       ModeStyle (tokens)
 *                                    │
 *                     modeStyleToSgr(style, env)
 *                                    │
 *                                    ▼
 *                       ResolvedModeStyle  ──▶  TUI render
 *
 * This module is the terminal *policy* layer: it owns the palette, picks
 * SGR sequences from terminal capability, drops a background that is the
 * same as the foreground, and truncates over-long labels.
 *
 * # Scope
 *
 * Per the user's instruction ("don't hardcode hexes now, use the ANSI ones
 * so it keeps as it renders now"), the mapper emits only the SGR sequences
 * from the shared palette. Semantic tokens (`accent`, `accent-soft`,
 * `brand`, `danger`, `muted`) map to palette names, so the user's terminal
 * theme stays in charge of the actual pigment. Hex values pass through as
 * 24-bit truecolor SGR on truecolor terminals only.
 *
 * `ansi`, `palette`, and `term-width` stay in core's plugin-api for now:
 * real sibling plugins still depend on them for tool-handler output (see
 * the S33 session report), so this file imports them from there.
 *
 * @module terminal-kit/mode-style
 */

import {
  type ModeColor,
  type ModeColorToken,
  type ModeStyle,
  type ModeSurfaceStyle,
  resolveModeStyleTokens,
} from "@minimal-agent/core/host-kit/modes"
import type { ModeStyleRequest, ThemeKey } from "@minimal-agent/core/plugin-api/types/plugin"
import { truncateDisplayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"
import { ANSI_CODES } from "./ansi.ts"
import { PALETTE, SEMANTIC } from "./palette.ts"

export { styleFromLegacyColor } from "@minimal-agent/core/host-kit/modes"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Concrete render output for one surface (label / arrow / status).
 *
 * `fgOpen` / `bgOpen` are pre-baked SGR open sequences. To render, the TUI
 * concatenates `fgOpen + bgOpen + (bold? "\x1b[1m" : "") + text + reset`.
 * `null` means "do not paint this attribute" — for `bg` that's the
 * transparent default; for `fg` it means "inherit terminal default".
 */
export interface ResolvedSurfaceStyle {
  fgOpen: string | null
  bgOpen: string | null
  bold: boolean
  dim: boolean
}

/** Concrete style for all three surfaces, plus the cached reset string. */
export interface ResolvedModeStyle {
  label: ResolvedSurfaceStyle
  arrow: ResolvedSurfaceStyle
  status: ResolvedSurfaceStyle
  /** SGR reset. Use after every painted run. */
  reset: string
}

/** Inputs to the mapper. */
export interface StyleEnv {
  theme: ThemeKey
  capability: "truecolor" | "ansi256" | "ansi16"
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESET = ANSI_CODES.RESET

/**
 * Maximum visible label length before truncation. Picked at 8 because the
 * common cases (`ASK`, `PLAN`, `REVIEW`, `RECORD`) all fit and the prompt
 * stays compact on narrow terminals.
 */
export const MAX_LABEL_WIDTH = 8

/**
 * SGR open sequence for each color token. Palette names come from the
 * shared plugin-api palette, so host UI and plugin chrome can never drift.
 * Semantic tokens map to a palette name. `accent` prefers calm blue over
 * the broad semantic sky. `brand` is the pigment of the default prompt
 * arrow (`❯`).
 */
export const TOKEN_FG_OPEN: Readonly<Record<ModeColorToken, string>> = {
  cyan: PALETTE.cyan,
  blue: PALETTE.blue,
  magenta: PALETTE.magenta,
  yellow: PALETTE.yellow,
  green: PALETTE.green,
  red: PALETTE.red,
  orange: PALETTE.orange,
  pink: PALETTE.pink,
  purple: PALETTE.purple,
  lime: PALETTE.lime,
  sky: PALETTE.sky,
  gold: PALETTE.gold,
  accent: PALETTE.blue,
  "accent-soft": PALETTE[SEMANTIC["accent-soft"]],
  brand: PALETTE[SEMANTIC.brand],
  danger: PALETTE[SEMANTIC.danger],
  muted: PALETTE[SEMANTIC.muted],
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the mapper's environment from process state.
 *
 * - `theme` from `MINIMAL_AGENT_THEME` (`dark` | `light` | `high-contrast`),
 *   defaulting to `dark` when unset/invalid. We don't sniff `COLORFGBG` or
 *   OSC 11 yet; that's a future hook.
 * - `capability` from `COLORTERM` (truecolor) and `TERM` (256-color
 *   substring), falling back to `ansi16`.
 */
export function detectStyleEnv(env: NodeJS.ProcessEnv = process.env): StyleEnv {
  let theme: ThemeKey = "dark"
  const t = env.MINIMAL_AGENT_THEME
  if (t === "light" || t === "dark" || t === "high-contrast") theme = t

  let capability: StyleEnv["capability"] = "ansi16"
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") {
    capability = "truecolor"
  } else if ((env.TERM ?? "").includes("256")) {
    capability = "ansi256"
  }

  return { theme, capability }
}

/**
 * Map host-neutral mode style tokens to concrete SGR sequences.
 *
 * Each surface maps alone. For each color the mapper picks the richest
 * form the terminal supports: hex on truecolor, then the 256-color index,
 * then the token. A hex on a terminal without truecolor maps to `null`, so
 * the terminal default shows instead of a wrong color. When `fg` and `bg`
 * map to the same color, the mapper drops `bg`.
 */
export function modeStyleToSgr(
  style: ModeStyle,
  env: StyleEnv = detectStyleEnv(),
): ResolvedModeStyle {
  return {
    label: surfaceToSgr(style.label, env),
    arrow: surfaceToSgr(style.arrow, env),
    status: surfaceToSgr(style.status, env),
    reset: RESET,
  }
}

/**
 * Resolve a mode's declarative style request to concrete ANSI sequences.
 * Core resolves the request to tokens for `env.theme`. Then
 * {@link modeStyleToSgr} maps the tokens.
 */
export function resolveModeStyle(
  request: ModeStyleRequest,
  env: StyleEnv = detectStyleEnv(),
): ResolvedModeStyle {
  return modeStyleToSgr(resolveModeStyleTokens(request, env.theme), env)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function surfaceToSgr(surface: ModeSurfaceStyle, env: StyleEnv): ResolvedSurfaceStyle {
  const fgOpen = surface.fg ? colorToFgSgr(surface.fg, env) : null
  let bgOpen = surface.bg ? colorToBgSgr(surface.bg, env) : null

  // Identity guard: if fg and bg resolve to the *same* sequence, drop bg.
  if (fgOpen && bgOpen && sameColorPayload(fgOpen, bgOpen)) bgOpen = null

  return { fgOpen, bgOpen, bold: surface.bold, dim: surface.dim }
}

/** Strip the leading "3" or "4" of an SGR color so fg and bg compare. */
function sameColorPayload(fg: string, bg: string): boolean {
  // Cheap: drop the first numeric character of the sequence body.
  // `\x1b[34m` ↔ `\x1b[44m`, `\x1b[38;5;199m` ↔ `\x1b[48;5;199m`.
  const norm = (s: string) => s.replace(/\x1b\[([34])(8?;?)/, "X")
  return norm(fg) === norm(bg)
}

function colorToFgSgr(color: ModeColor, env: StyleEnv): string | null {
  if (env.capability === "truecolor" && color.hex) return hexToFgSgr(color.hex, env)
  if (color.ansi256 != null) return `\x1b[38;5;${color.ansi256}m`
  if (color.token) return TOKEN_FG_OPEN[color.token]
  if (color.hex) return hexToFgSgr(color.hex, env)
  return null
}

function colorToBgSgr(color: ModeColor, env: StyleEnv): string | null {
  const fg = colorToFgSgr(color, env)
  if (!fg) return null
  // Convert fg SGR → bg SGR. `\x1b[3Nm` → `\x1b[4Nm`; `\x1b[38;5;Nm` → `\x1b[48;5;Nm`;
  // `\x1b[38;2;R;G;Bm` → `\x1b[48;2;R;G;Bm`.
  return fg.replace("\x1b[3", "\x1b[4")
}

function hexToFgSgr(hex: string, env: StyleEnv): string | null {
  if (env.capability !== "truecolor") {
    // Future: nearest-256 fallback. For MVP, drop hex on non-truecolor terms
    // so the terminal default kicks in instead of a wrong color.
    return null
  }
  const m = hex.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/)
  if (!m) return null
  const r = parseInt(m[1], 16)
  const g = parseInt(m[2], 16)
  const b = parseInt(m[3], 16)
  return `\x1b[38;2;${r};${g};${b}m`
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

/**
 * Paint `text` with a resolved surface style. Handles bold, dim, fg, bg,
 * and a clean SGR reset.
 */
export function paint(text: string, style: ResolvedSurfaceStyle): string {
  const opens: string[] = []
  if (style.bold) opens.push("\x1b[1m")
  if (style.dim) opens.push("\x1b[2m")
  if (style.fgOpen) opens.push(style.fgOpen)
  if (style.bgOpen) opens.push(style.bgOpen)
  if (opens.length === 0) return text
  return `${opens.join("")}${text}${RESET}`
}

/**
 * Truncate a label to {@link MAX_LABEL_WIDTH} *display cells* with an ellipsis.
 * Plugin authors are not expected to hit this in practice — it's a guardrail
 * against a misbehaving manifest stuffing the prompt full of text.
 *
 * Measures and cuts by terminal display width, not `.length` (B-072): the old
 * code-unit math counted a 2-cell CJK glyph as 1 (so a full-width label
 * overflowed the prompt) and sliced on a UTF-16 boundary (splitting a surrogate
 * pair into mojibake). `truncateDisplayWidth` counts real cells and never
 * splits a codepoint, while preserving the prior shape: a body of
 * `MAX_LABEL_WIDTH - 3` cells plus a 3-cell `"..."`.
 */
export function clampLabel(label: string): string {
  return truncateDisplayWidth(label, MAX_LABEL_WIDTH, "...")
}
