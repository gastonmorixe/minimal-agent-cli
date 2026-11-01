/**
 * Terminal painters for mode chrome: the REPL prompt prefix and the label
 * colors of mode-change chips.
 *
 * Core's `ModeManager` returns host-neutral style tokens (decision 26).
 * These helpers map the tokens to SGR with
 * {@link modeStyleToSgr} and paint the text. Before decision 26 this code
 * was `ModeManager.promptPrefix` / `promptPrefixForId` in core.
 *
 * @module ui/style/mode-prompt
 */

import type { ModeManager, ModeStyle } from "@minimal-agent/core/host-kit/modes"
import { ansiStyle as c } from "../../terminal-kit/ansi.ts"

import {
  clampLabel,
  detectStyleEnv,
  modeStyleToSgr,
  paint,
  type ResolvedModeStyle,
  type StyleEnv,
} from "../../terminal-kit/mode-style.ts"

/** The `ModeManager` reads the painters need. */
export type ModeStyleSource = Pick<ModeManager, "activeId" | "modeById" | "resolvedForId">

/** Map a token style to SGR. `null` stays `null`. */
export function terminalModeStyle(
  style: ModeStyle | null,
  env: StyleEnv = detectStyleEnv(),
): ResolvedModeStyle | null {
  return style ? modeStyleToSgr(style, env) : null
}

/**
 * SGR style for a mode id. `null` id gives the "default" (no mode) style
 * in the brand color. An unknown id or a mode without style gives `null`.
 */
export function terminalModeStyleForId(
  manager: Pick<ModeManager, "resolvedForId">,
  id: string | null,
  env: StyleEnv = detectStyleEnv(),
): ResolvedModeStyle | null {
  return terminalModeStyle(manager.resolvedForId(id), env)
}

/**
 * Label foreground SGR open sequence for a mode id, or `null`. Mode-change
 * chips and the pending decoration use it.
 */
export function modeLabelFgOpen(
  manager: Pick<ModeManager, "resolvedForId">,
  id: string | null,
  env: StyleEnv = detectStyleEnv(),
): string | null {
  return terminalModeStyleForId(manager, id, env)?.label.fgOpen ?? null
}

/**
 * REPL prompt prefix for the active mode, including a trailing space.
 * See {@link modePromptPrefixForId}.
 */
export function modePromptPrefix(
  manager: ModeStyleSource,
  baseArrow: string,
  arrowGlyph = "❯",
  env: StyleEnv = detectStyleEnv(),
): string {
  return modePromptPrefixForId(manager, manager.activeId(), baseArrow, arrowGlyph, env)
}

/**
 * REPL prompt prefix for an explicit mode id, including a trailing space.
 *
 * Returns the bare `baseArrow` when `modeId` is `null` or unknown
 * (including the literal `"default"` placeholder of `<mode-change>`
 * blocks). Otherwise it paints the clamped, upper-case mode label in bold
 * (in the label color when the mode has one), then the arrow. The arrow is
 * repainted only when the mode requests an arrow color. Else the caller's
 * pre-styled `baseArrow` is reused.
 *
 * Pure: session replay calls it for each past user turn.
 *
 * @param manager - The mode manager to read modes and style tokens from.
 * @param modeId - Id of the mode whose prefix to render, or `null`.
 * @param baseArrow - Default pre-styled arrow including trailing space
 *   (e.g. `${pink("❯")} `).
 * @param arrowGlyph - Raw glyph used to rebuild the arrow when the mode
 *   restyles it. Defaults to `"❯"`.
 * @param env - Terminal style environment. Defaults to {@link detectStyleEnv}.
 */
export function modePromptPrefixForId(
  manager: ModeStyleSource,
  modeId: string | null,
  baseArrow: string,
  arrowGlyph = "❯",
  env: StyleEnv = detectStyleEnv(),
): string {
  const m = manager.modeById(modeId)
  if (!m) return baseArrow
  const resolved = terminalModeStyleForId(manager, m.id, env)
  const label = clampLabel((m.label ?? m.id).toUpperCase())
  const labelStyle = resolved?.label ?? null
  const arrowStyle = resolved?.arrow ?? null

  const paintedLabel = labelStyle ? paint(label, { ...labelStyle, bold: true }) : c.bold(label)

  const arrow = arrowStyle?.fgOpen
    ? `${paint(arrowGlyph, { ...arrowStyle, bold: true })} `
    : baseArrow

  return `${paintedLabel} ${arrow}`
}
