/**
 * Cache-break row: one scrollback line for each prompt-cache break.
 *
 * The cache plugin (`ma-cache-plugin`) sends {@link CACHE_DID_BREAK} on the
 * plugin bus for EVERY break, whatever the cause. The diagnostic log is a
 * separate channel: the scrollback diagnostic sink (`./scrollback.ts`) shows
 * only Warning and worse, so an expected TTL expiry (an info diagnostic) was
 * invisible even when it wrote ~48k tokens again. This row is driven by the
 * event, never by the log severity.
 *
 * # Visual
 *
 *   ◇ cache rewrote 26,426 tok · ttl expired · idle 63 min \> 5 min TTL · turn 5 · 16:49:36
 *   ◆ cache rewrote 30,000 tok · tools changed · turn 7 · 2 in a row, 52,000 tok · 16:50:02
 *
 * Every row uses the warning color (gold, the color of the scrollback sink)
 * for the glyph and the `cache` label. The glyph and the body tell the two
 * kinds apart: an expected break (`actionable === false`) has a hollow `◇`
 * and a dim body. An actionable break (a client change, a likely server
 * miss) has a solid `◆` and a normal body. The timestamp is dim, as in the
 * sink's block head.
 *
 * # Relation to the `⚠ warn cache.anomaly` block
 *
 * For actionable breaks the plugin still logs a warn diagnostic (with the
 * explanation) at streak milestones, which the scrollback sink shows as a
 * block. That block stays: it has the detail. The detector logs the warning
 * BEFORE it sends the event, and the bus delivers events on a microtask, so
 * the block is written first and this row follows it. The cli cannot change
 * that order without buffering the diagnostic sink.
 *
 * @module ui/status/cache-break-row
 */

import type { EventBus } from "@minimal-agent/core/host/event-bus"
import { CACHE_DID_BREAK, type CacheBreakPayload } from "@minimal-agent/core/plugin-api"
import { displayWidth, truncateDisplayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"
import { ANSI_CODES } from "../../terminal-kit/ansi.ts"
import { PALETTE } from "../../terminal-kit/palette.ts"
import { formatScrollbackTs } from "./scrollback.ts"

const paint = (open: string, s: string): string => `${open}${s}${ANSI_CODES.FG_RESET}`
const dim = (s: string): string => `${ANSI_CODES.DIM}${s}${ANSI_CODES.DIM_CLOSE}`
const bold = (open: string, s: string): string =>
  `${ANSI_CODES.BOLD}${open}${s}${ANSI_CODES.FG_RESET}${ANSI_CODES.BOLD_CLOSE}`

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === "string"

const CAUSES = new Set([
  "ttl_expired",
  "prefix_changed",
  "thinking_lookback",
  "thinking_older_entry",
  "server_miss",
  "unknown",
])

/**
 * Check an untrusted bus payload. The bus carries `unknown`, and a plugin of
 * another version can send another shape.
 *
 * @returns The payload when it is a v1 {@link CacheBreakPayload} with the
 *   fields this row reads, else `null`.
 */
export function parseCacheBreakPayload(raw: unknown): CacheBreakPayload | null {
  if (raw === null || typeof raw !== "object") return null
  const p = raw as Record<string, unknown>
  if (p.v !== 1) return null
  if (!isNum(p.turn) || !isNum(p.lost) || !isNum(p.ttlSec)) return null
  if (!isNum(p.streak) || !isNum(p.streakLost)) return null
  // Required by the contract; the row does not show them, but the return
  // type promises a full payload.
  if (!isNum(p.read) || !isNum(p.written) || !isNum(p.expectedRead)) return null
  if (!isStr(p.message)) return null
  if (p.gapSec !== undefined && !isNum(p.gapSec)) return null
  if (p.changedIndex !== undefined && !isNum(p.changedIndex)) return null
  if (p.at !== undefined && !isNum(p.at)) return null
  if (typeof p.actionable !== "boolean" || typeof p.idle !== "boolean") return null
  if (!isStr(p.cause) || !CAUSES.has(p.cause)) return null
  if (p.changed !== undefined && !isStr(p.changed)) return null
  if (p.requestId !== undefined && !isStr(p.requestId)) return null
  return p as unknown as CacheBreakPayload
}

/** `48213` → `48,213`. Locale-free, so the row is the same on every host. */
export function formatTokens(n: number): string {
  const s = String(Math.round(Math.abs(n)))
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return n < 0 ? `-${grouped}` : grouped
}

/** Seconds as a short duration: `45 s`, `63 min`, `2.5 h`. */
export function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.max(0, Math.round(sec))} s`
  const min = Math.round(sec / 60)
  if (min < 120) return `${min} min`
  const h = sec / 3600
  return `${Number.isInteger(Math.round(h * 10) / 10) ? Math.round(h) : h.toFixed(1)} h`
}

/** The cause segment of the row, without ANSI. */
function causeText(p: CacheBreakPayload): string {
  const at = p.changedIndex !== undefined ? ` #${p.changedIndex}` : ""
  switch (p.cause) {
    case "ttl_expired":
      return "ttl expired"
    case "prefix_changed":
      switch (p.changed) {
        case "tools":
          return "tools changed"
        case "system":
          return "system prompt changed"
        case "tools_system":
          return "tools + system prompt changed"
        case "options":
          return "request options changed"
        case "message":
          return `message${at} changed`
        case "thinking":
          return `thinking${at} changed`
        case "shorter":
          return `history shorter${at ? ` at${at}` : ""}`
        default:
          return "prefix changed"
      }
    case "thinking_lookback":
      return `thinking removed${at ? ` at${at}` : ""}, out of lookback`
    case "thinking_older_entry":
      return `thinking removed${at ? ` at${at}` : ""}, older entry`
    case "server_miss":
      return "likely server miss"
    default:
      return "cause unknown"
  }
}

/** Options of {@link formatCacheBreakRow}. */
export interface CacheBreakRowOptions {
  /** Fallback timestamp (epoch ms) when the payload has no `at`. Default `Date.now()`. */
  readonly now?: number
  /** Terminal width. The row is kept under it. Omitted: no truncation. */
  readonly columns?: number
  /**
   * The session id of this TUI. A break of another session (for example an
   * in-process sub-agent) gets a `session <first 8>` part, so the row says
   * whose cache broke. Omitted: no label.
   */
  readonly ownSessionId?: string
}

/**
 * Render one break as one row (no trailing newline). Pure.
 *
 * @param p - A payload that {@link parseCacheBreakPayload} accepted.
 * @param opts - The fallback time and the terminal width.
 */
export function formatCacheBreakRow(p: CacheBreakPayload, opts: CacheBreakRowOptions = {}): string {
  // Every break row is a warning, so it has the warning color (gold), as the
  // scrollback sink has. The glyph and the body tell an expected break from
  // an actionable one.
  const color = PALETTE.gold
  const glyph = p.actionable ? "◆" : "◇"

  const parts: string[] = [`rewrote ${formatTokens(p.lost)} tok`, causeText(p)]
  if (p.idle && p.gapSec !== undefined) {
    parts.push(`idle ${formatDuration(p.gapSec)} > ${formatDuration(p.ttlSec)} TTL`)
  } else if (p.idle) {
    parts.push(`idle > ${formatDuration(p.ttlSec)} TTL`)
  } else if (p.cause === "server_miss" && p.gapSec !== undefined) {
    parts.push(`gap ${formatDuration(p.gapSec)} < ${formatDuration(p.ttlSec)} TTL`)
  }
  parts.push(`turn ${p.turn}`)
  const sid = typeof p.sessionId === "string" ? p.sessionId : ""
  if (opts.ownSessionId && sid && sid !== opts.ownSessionId) {
    parts.push(`session ${sid.slice(0, 8)}`)
  }
  if (p.streak > 1) parts.push(`${p.streak} in a row, ${formatTokens(p.streakLost)} tok`)
  if (p.cause === "server_miss" && p.requestId) parts.push(`req ${p.requestId}`)

  const head = `  ${paint(color, glyph)} ${bold(color, "cache")} `
  const tail = ` ${dim(`· ${formatScrollbackTs(p.at ?? opts.now ?? Date.now())}`)}`
  let body = parts.join(" · ")

  // Keep the row under the width (one cell spare, so the terminal never
  // wraps on the last column). The body gives way; the head and the
  // timestamp stay. When even the head and the timestamp do not fit, the
  // row is cut as a whole, so it is never wider than the terminal.
  if (opts.columns !== undefined && opts.columns > 0) {
    const max = opts.columns - 1
    const room = max - displayWidth(head) - displayWidth(tail)
    if (room < 2) {
      return truncateDisplayWidth(`${head}${tail.trimStart()}`, Math.max(1, max), "…")
    }
    if (displayWidth(body) > room) body = truncateDisplayWidth(body, room, "…")
  }
  return `${head}${p.actionable ? body : dim(body)}${tail}`
}

/** Options of {@link attachCacheBreakRows}. */
export interface AttachCacheBreakRowsOptions {
  /** Terminal width at the time of each row. */
  readonly columns?: () => number | undefined
  /** Clock for the fallback timestamp. */
  readonly now?: () => number
  /** The session id of this TUI. See {@link CacheBreakRowOptions.ownSessionId}. */
  readonly ownSessionId?: string
}

/**
 * Subscribe to {@link CACHE_DID_BREAK} and write one row for each break.
 * A malformed payload is ignored.
 *
 * @param bus - The plugin event bus (`loader.bus()`).
 * @param write - Receives each row with a trailing newline. The live-area
 *   REPL passes the compositor's `writeBlock`, so the row lands on its own
 *   line, not on the open row of a streaming response.
 * @returns A function that unsubscribes. Idempotent.
 */
export function attachCacheBreakRows(
  bus: Pick<EventBus, "on">,
  write: (text: string) => void,
  opts: AttachCacheBreakRowsOptions = {},
): () => void {
  let off: (() => void) | null = bus.on(CACHE_DID_BREAK, (ctx) => {
    const p = parseCacheBreakPayload(ctx.payload)
    if (p === null) return
    const now = opts.now?.()
    const columns = opts.columns?.()
    const rowOpts: CacheBreakRowOptions = {
      ...(now !== undefined ? { now } : {}),
      ...(columns !== undefined ? { columns } : {}),
      ...(opts.ownSessionId ? { ownSessionId: opts.ownSessionId } : {}),
    }
    write(`${formatCacheBreakRow(p, rowOpts)}\n`)
  })
  return () => {
    off?.()
    off = null
  }
}
