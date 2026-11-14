/**
 * Pure builder for the one-time "status ready" banner that appears
 * above the REPL prompt at session start.
 *
 * Lifted out of `src/agent.ts` so the banner can be written ONCE from
 * `src/index.ts`, BEFORE any resume replay. Previously the banner was
 * emitted from inside `runRepl` / `runReplLiveArea`, which on resume
 * placed it BELOW the replayed content (visible jump: header → replay
 * → banner, instead of header → banner → replay).
 *
 * The trailing `\n\n` (NOT `\n`) is load-bearing: it provides the one
 * blank row of breathing room between the banner and whatever comes
 * next (resume separator, prompt, etc.). The compositor's
 * `capBlankLines` caps consecutive `\n` runs in scrollback at 2, so a
 * single blank row is the max we'll ever see even if downstream code
 * adds more.
 *
 * @module ready-banner
 */

import { c } from "../style/ansi.ts"

/**
 * Build the colored banner string. Pure : no I/O, no side effects.
 *
 * @returns ANSI-tagged banner: `\n  status ready\n\n`.
 */
export function buildReadyBanner(): string {
  return `\n  ${c.bold(c.purple("status"))} ${c.faintWhite("ready")}\n\n`
}
