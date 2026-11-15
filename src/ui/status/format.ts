import type { StatusActivity, StatusDirection } from "@minimal-agent/core/host/status-bus"
import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"
import { ansiStyle as c } from "../../terminal-kit/ansi.ts"

export const LABEL_BYTES_RE = /\(\d+(?:\.\d+)?\s?(?:B|KB|MB)\)\s*$/

/** Compact "wall-clock elapsed" formatter for status-row suffixes. */
export function formatElapsed(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const totalSec = Math.floor(safe / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  const sec = totalSec - totalMin * 60
  if (totalMin < 60) return `${totalMin}m ${sec}s`
  const hours = Math.floor(totalMin / 60)
  const min = totalMin - hours * 60
  return `${hours}h ${min}m`
}

/** Render a faint elapsed suffix, including its leading space. */
export function formatElapsedSuffix(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return ""
  return ` ${c.dim(`(${formatElapsed(ms)})`)}`
}

/**
 * Fallback stall threshold: how long a downloading stream may stay silent
 * before the row says `⋯ stalled`, when core reports no idle budget.
 * Plain text streams send deltas every few hundred ms, so 2 s (the old
 * value) flickered on healthy streams.
 */
export const STALL_THRESHOLD_MS = 8_000

/**
 * Share of the core watchdog's idle budget (`activity.idleBudgetMs`) after
 * which the row says `⋯ stalled`. Half the budget warns well before the
 * watchdog aborts (15 s of a 30 s budget, 2.5 min of a 5 min thinking or
 * tool-input budget) without flagging a model that is just thinking.
 */
export const STALL_BUDGET_FRACTION = 0.5

/** Activity phases during which the provider may legitimately send nothing. */
const BLOCK_PHASES = new Set(["thinking", "writing", "tool-input"])

/**
 * The label to show for one status entry. Core reports the open content
 * block as a fact (`activity.phase`); the CLI owns the words. A network
 * row ("Receiving stream") becomes "Reasoning", "Writing response" or
 * "Streaming <tool> input" while that block is open. Every other row keeps
 * its bus label.
 *
 * "Reasoning", not "Thinking": the REPL's per-turn fallback row is
 * already called "Thinking" (it means "a turn is running"), so the
 * model's reasoning block gets its own word.
 */
export function displayLabelFor(label: string, activity: StatusActivity | undefined): string {
  switch (activity?.phase) {
    case "thinking":
      return "Reasoning"
    case "writing":
      return "Writing response"
    case "tool-input":
      return activity.toolName ? `Streaming ${activity.toolName} input` : "Streaming tool input"
    default:
      return label
  }
}

/** The stall threshold for one activity (see {@link STALL_BUDGET_FRACTION}). */
export function stallThresholdFor(activity: StatusActivity): number {
  const budget = activity.idleBudgetMs
  if (budget != null && Number.isFinite(budget) && budget > 0) {
    return Math.max(STALL_THRESHOLD_MS, budget * STALL_BUDGET_FRACTION)
  }
  return STALL_THRESHOLD_MS
}

/**
 * Rate over a sliding window of recent samples instead of the row's
 * lifetime: a long silent block no longer drags the number down forever,
 * and the rate drops to nothing once a stream goes quiet.
 *
 * One instance per renderer. It resets itself when the entry id, the
 * direction or the unit (tokens vs bytes) changes.
 */
export class RateWindow {
  private samples: Array<{ t: number; v: number }> = []
  private key = ""

  constructor(private readonly windowMs = 3_000) {}

  /** Record the current counter and return the windowed rate text, if any. */
  observe(entryId: number, activity: StatusActivity, now: number): string | null {
    const dir = activity.direction
    const tok = dir === "up" ? activity.sentTokens : activity.recvTokens
    const useTokens = tok != null && tok > 0
    const value = useTokens ? tok : pickBytesForDirection(activity)
    if (value == null || value <= 0) return null
    const key = `${entryId}:${dir ?? ""}:${useTokens ? "tok" : "b"}`
    if (key !== this.key) {
      this.key = key
      this.samples = []
    }
    const last = this.samples[this.samples.length - 1]
    if (!last || last.v !== value || now - last.t >= 250) this.samples.push({ t: now, v: value })
    // The counter is a step function between samples. The baseline is its
    // value at `now - windowMs`: the newest sample at or before that time.
    // Older samples are dropped. Before a full window has passed, the
    // oldest sample and the real span are used instead.
    const cutoff = now - this.windowMs
    while (this.samples.length > 1 && this.samples[1].t <= cutoff) this.samples.shift()
    const first = this.samples[0]
    const spanMs = first.t <= cutoff ? this.windowMs : now - first.t
    if (spanMs < 500) return null
    const delta = value - first.v
    if (delta <= 0) return null
    const perSec = delta / (spanMs / 1000)
    return useTokens ? fmtTokRate(perSec) : fmtByteRate(perSec)
  }

  reset(): void {
    this.samples = []
    this.key = ""
  }
}

/**
 * Elapsed-time start per status entry. A row that comes back on top (the
 * turn's "Thinking" after a request or tool clears) resumes its own count
 * instead of restarting at 0 s.
 */
export class EntryClock {
  private starts = new Map<number, number>()

  constructor(private readonly maxEntries = 64) {}

  startOf(id: number, now: number): number {
    const known = this.starts.get(id)
    if (known != null) return known
    this.starts.set(id, now)
    if (this.starts.size > this.maxEntries) {
      const oldest = this.starts.keys().next().value
      if (oldest != null) this.starts.delete(oldest)
    }
    return now
  }

  /** Forget every entry (the bus is empty, or the renderer stopped). */
  clear(): void {
    this.starts.clear()
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  return String(n)
}

export interface FormatActivityOptions {
  now?: number
  maxWidth?: number
  stallThresholdMs?: number
  entryStartedAt?: number
  hideBytes?: boolean
  /**
   * Windowed rate source. When set, the rate segment comes from it (and
   * `entryId` keys its samples); otherwise the lifetime average is used.
   */
  rateWindow?: RateWindow
  entryId?: number
}

/** Render the structured activity payload as a compact status-row infix. */
export function formatActivityInfix(
  activity: StatusActivity | undefined,
  opts: FormatActivityOptions = {},
): string {
  if (!activity) return ""
  const now = opts.now ?? Date.now()
  const stallThresh = opts.stallThresholdMs ?? stallThresholdFor(activity)
  const dir = activity.direction
  // Judge progress by content, not bytes, when core reports it: a
  // keep-alive ping proves the socket is up, not that the model produced
  // anything.
  const usesContent = activity.lastContentAt != null
  const progressAt = activity.lastContentAt ?? activity.lastChunkAt
  const stalled = dir === "down" && progressAt != null && now - progressAt > stallThresh

  let arrow: string
  if (stalled) arrow = c.gold("⋯ stalled")
  else if (dir === "up") arrow = c.sky("↑")
  else if (dir === "down") arrow = c.lime("↓")
  else arrow = c.dim("·")

  const segs: string[] = []

  // Time in the current content block ("Thinking · 14s"). The row's own
  // elapsed suffix keeps showing the whole request.
  if (
    activity.phase &&
    BLOCK_PHASES.has(activity.phase) &&
    activity.phaseStartedAt != null &&
    now - activity.phaseStartedAt >= 1_000
  ) {
    segs.push(c.faintWhite(formatElapsed(now - activity.phaseStartedAt)))
  }

  if (!opts.hideBytes) {
    const b = pickBytesForDirection(activity)
    if (b != null && b > 0) segs.push(c.faintWhite(fmtBytes(b)))
  }

  const tok = dir === "up" ? activity.sentTokens : activity.recvTokens
  if (tok != null && tok > 0) {
    segs.push(c.faintWhite(`~${fmtTokens(tok)} tok`))
  }

  if (opts.rateWindow) {
    const rate = opts.rateWindow.observe(opts.entryId ?? 0, activity, now)
    if (rate) segs.push(c.dim(rate))
  } else if (opts.entryStartedAt != null && opts.entryStartedAt > 0) {
    const elapsedMs = now - opts.entryStartedAt
    if (elapsedMs >= 500) {
      const rate = computeRate(activity, elapsedMs, dir)
      if (rate) segs.push(c.dim(rate))
    }
  }

  const target = activity.target
  if (target?.host) {
    const proto = target.protocol ? `:${target.protocol}` : ""
    segs.push(c.faintWhite(`${target.host}${proto}`))
  }

  if (stalled && progressAt != null) {
    const sinceMs = now - progressAt
    const sinceS = Math.max(1, Math.floor(sinceMs / 1000))
    const what = usesContent ? "last output" : "last byte"
    segs.unshift(c.faintWhite(`${what} ${formatElapsed(sinceS * 1000)} ago`))
  }

  const sep = c.dim(" · ")
  const arrowGap = stalled && segs.length > 0 ? sep : " "
  const compose = (parts: string[]): string =>
    parts.length === 0 ? ` ${arrow}` : ` ${arrow}${arrowGap}${parts.join(sep)}`
  let result = compose(segs)

  if (opts.maxWidth != null && Number.isFinite(opts.maxWidth)) {
    while (displayWidth(result) > opts.maxWidth && segs.length > 0) {
      segs.pop()
      result = compose(segs)
    }
    if (displayWidth(result) > opts.maxWidth) return ""
  }
  return result
}

function pickBytesForDirection(activity: StatusActivity): number | undefined {
  if (activity.direction === "up") return activity.sentBytes ?? activity.recvBytes
  if (activity.direction === "down") return activity.recvBytes ?? activity.sentBytes
  return activity.recvBytes ?? activity.sentBytes
}

function computeRate(
  activity: StatusActivity,
  elapsedMs: number,
  dir: StatusDirection | undefined,
): string | null {
  const secs = elapsedMs / 1000
  if (secs <= 0) return null
  const tok = dir === "up" ? activity.sentTokens : activity.recvTokens
  if (tok != null && tok > 0) return fmtTokRate(tok / secs)
  const b = pickBytesForDirection(activity)
  if (b != null && b > 0) return fmtByteRate(b / secs)
  return null
}

function fmtTokRate(tps: number): string {
  if (tps < 10) return `${tps.toFixed(1)} tok/s`
  return `${Math.round(tps)} tok/s`
}

function fmtByteRate(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`
  return `${(bps / 1024).toFixed(1)} KB/s`
}
