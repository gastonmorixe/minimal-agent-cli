/**
 * Scrollback diagnostic sink — renders Warning+ events as multi-line
 * gutter-bracketed blocks in the persistent terminal scrollback.
 *
 * Sibling of {@link FileLogSink} (full RFC 5424 file log) and
 * {@link TuiDiagnosticSurface} (transient 0..2-line footer slot). The
 * three answer different questions:
 *
 *  - **File sink**: post-mortem ("what happened over the whole session?").
 *  - **TUI footer**: situational awareness ("anything wrong right now?").
 *  - **This sink**: in-flow narrative ("what just failed during this turn,
 *    in the same scroll history as the conversation?").
 *
 * Without this sink, a mid-stream API error (e.g. Anthropic's
 * `overloaded_error` returned over HTTP 200 inside the SSE body) lands
 * only in `~/.minimal-agent/logs/...` — the user sees the editor flash
 * "Sending request" then silence, with no in-context signal that
 * anything went wrong. The reports of "queries not working" with
 * "zero feedback" trace directly to that gap.
 *
 * # Visual
 *
 *   ⚠ warn   api.stream-error · 10:56:51
 *   │ overloaded_error: Overloaded
 *   ╰ request-id: req_011CbE1suHv2YRDRZuT4VAoC
 *
 *   ✗ error  auth.refresh · 10:57:02
 *   │ invalid_grant: refresh token expired
 *   ╰ hint: run `minimal-agent --login` to re-auth
 *
 * Severity chrome pulls from {@link PALETTE}:
 *   - Warning   → gold (semantic alias `warning`)
 *   - Error+    → red  (semantic alias `danger`)
 *
 * Source id renders in cyan (mirrors `ui/style/mode`'s subsystem color);
 * the timestamp and structured-data keys are dim.
 *
 * # Dedup window
 *
 * Identical `(severity, source, message)` within `dedupWindowMs`
 * (default 30 s) collapses to a single compact line:
 *
 *   ⚠ warn   api.stream-error (×3 · last 10:57:08)
 *
 * Dedup lines are themselves throttled (`dedupRepaintMinMs`, default
 * 500 ms) so a true storm — say 200 overload events in 5 s — paints at
 * most ~10 lines, not 200. A different tuple from the same source OR
 * window expiry resets the slot and the next event re-arms with a full
 * block.
 *
 * # Routing
 *
 * Writes to `process.stderr` by default. In non-interactive mode that
 * lands directly in the terminal. In the live-area REPL the host
 * rebinds the writer to `Compositor.writeBlock` (see
 * `routeDiagnosticsThroughCompositor` in `startup/diagnostic-sinks.ts`).
 * The stdio interceptor (`src/ui/stdio-interceptor.ts`) would also carry
 * stderr into the compositor, but as `writeStream`, which appends at the
 * stream cursor. While a response streams, that cursor is at the end of
 * the last response row, so the block joined that row. `writeBlock` holds
 * the block until that row is complete (the next line feed of the
 * response, or the end of the turn) and then writes it on rows of its own.
 * Both surfaces preserve the warning in scroll history.
 *
 * @module ui/status/scrollback
 */

import { type DiagnosticBus, type LogEvent, Severity } from "@minimal-agent/core/host/diagnostics"
import { diagnosticKey, diagnosticText, hasDiagnosticText } from "../../logging/diagnostic-text.ts"
import { ANSI_CODES } from "../../terminal-kit/ansi.ts"
import { PALETTE } from "../../terminal-kit/palette.ts"

// ---------------------------------------------------------------------------
// SGR helpers (no `c` import; these compose raw palette opens with attributes).
// ---------------------------------------------------------------------------

const paint = (open: string, s: string): string => `${open}${s}${ANSI_CODES.FG_RESET}`
const dim = (s: string): string => `${ANSI_CODES.DIM}${s}${ANSI_CODES.DIM_CLOSE}`
const bold = (open: string, s: string): string =>
  `${ANSI_CODES.BOLD}${open}${s}${ANSI_CODES.FG_RESET}${ANSI_CODES.BOLD_CLOSE}`

// ---------------------------------------------------------------------------
// Dedup state (one entry per source id)
// ---------------------------------------------------------------------------

interface DedupState {
  /** Encoded `(severity, source, message)` tuple. */
  key: string
  count: number
  firstAt: number
  lastAt: number
  /** Wall-clock ms of the most recent paint (full OR dedup). */
  lastPaintedAt: number
}

// ---------------------------------------------------------------------------
// Public configuration
// ---------------------------------------------------------------------------

export interface ScrollbackSinkOptions {
  /**
   * Sink for the rendered block (multi-line, includes trailing newline).
   * Default: `process.stderr.write` (bound). Tests pass a string-collector.
   * The live-area REPL re-binds to the compositor's `writeBlock` through
   * {@link ScrollbackDiagnosticSink.bindWriter}.
   */
  write?: (text: string) => void

  /**
   * Window during which identical `(severity, source, message)` tuples
   * collapse into a compact `(×N)` dedup line instead of a full block.
   * Default `30_000`. Set to `0` to disable dedup entirely (every event
   * re-emits a full block).
   */
  dedupWindowMs?: number

  /**
   * Minimum spacing between consecutive dedup paints for the same
   * source. Without this, an overload storm of N events would paint N
   * dedup lines back-to-back. Default `500` ms (≈2 paints/sec max per
   * source).
   */
  dedupRepaintMinMs?: number

  /** Clock injection for deterministic tests. */
  now?: () => number
}

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

/**
 * Diagnostic-bus sink that prints warn/error events into terminal scrollback
 * as styled chips. Per-source dedup collapses repeats inside a time window
 * into a counter repaint instead of new lines, and a buffering mode (used
 * during the startup banner) holds renderings until {@link flushBuffer} so
 * diagnostics cannot tear a box being painted.
 */
export class ScrollbackDiagnosticSink {
  private writeImpl: (text: string) => void
  private dedupWindowMs: number
  private dedupRepaintMinMs: number
  private now: () => number
  private active: Map<string, DedupState> = new Map() // keyed by source
  private disposeFn: (() => void) | null = null
  /**
   * When non-null the sink is in BUFFERING mode: renderings are appended
   * to this array instead of going to `writeImpl`. {@link flushBuffer}
   * drains and switches back to pass-through.
   *
   * Wired from `src/index.ts` so any plugin-loader / auth / config
   * diagnostic that fires DURING the startup banner box doesn't tear
   * through the box mid-paint. The buffer flushes once
   * `closeStartupTree()` has committed the final `╰` row, so warnings
   * land cleanly BELOW the banner with the proper `⚠ warn ╰` chrome.
   */
  private buffer: string[] | null = null

  constructor(opts: ScrollbackSinkOptions = {}) {
    this.writeImpl = opts.write ?? ((s: string) => void process.stderr.write(s))
    this.dedupWindowMs = opts.dedupWindowMs ?? 30_000
    this.dedupRepaintMinMs = opts.dedupRepaintMinMs ?? 500
    this.now = opts.now ?? (() => Date.now())
  }

  /**
   * Enter buffering mode. Subsequent renderings are queued in memory
   * instead of being written. Idempotent (calling twice does nothing).
   */
  startBuffering(): void {
    if (this.buffer === null) this.buffer = []
  }

  /**
   * Drain the buffered renderings through `writeImpl` (preserving order)
   * and exit buffering mode. Idempotent: if no buffer was active, this
   * is a no-op. Safe to call from `finally` blocks.
   */
  flushBuffer(): void {
    const buffered = this.buffer
    if (buffered === null) return
    this.buffer = null
    for (const chunk of buffered) {
      try {
        this.writeImpl(chunk)
      } catch {
        // Same isolation policy as the rest of the sink: a misbehaving
        // writer must not break drainage of the remaining entries.
      }
    }
  }

  /**
   * True iff the sink is currently buffering. Exposed for tests; callers
   * shouldn't need this — use start/flush in symmetric pairs.
   */
  isBuffering(): boolean {
    return this.buffer !== null
  }

  /** Subscribe to a bus. Idempotent. */
  attach(bus: DiagnosticBus): void {
    if (this.disposeFn) return
    this.disposeFn = bus.on("*", (e) => this.onEvent(e))
  }

  /** Unsubscribe. Idempotent. */
  detach(): void {
    this.disposeFn?.()
    this.disposeFn = null
  }

  /**
   * Rebind the writer. The live-area REPL binds the compositor's
   * `writeBlock`, so a block is written on rows of its own once the open row
   * of a streamed response is complete, instead of joining that row.
   * Optional: the default stderr writer works in non-interactive mode.
   *
   * @param write - Receives each rendered chunk (multi-line, trailing newline).
   * @returns A function that puts the previous writer back. It does nothing
   *   when another `bindWriter` call replaced this writer in the meantime.
   */
  bindWriter(write: (text: string) => void): () => void {
    const previous = this.writeImpl
    this.writeImpl = write
    return () => {
      if (this.writeImpl === write) this.writeImpl = previous
    }
  }

  /** Reset the dedup state. Tests and rare manual recoveries. */
  resetDedup(): void {
    this.active.clear()
  }

  /**
   * Direct event injection. The bus-attach path funnels here too;
   * exposed for tests so they don't need to wire a bus.
   */
  onEvent(e: LogEvent): void {
    // Only Warning and worse land in scrollback. File sink covers the
    // long tail (Notice/Info/Debug); the footer slot subscribes to its
    // own gating in TuiDiagnosticSurface.
    if (e.severity > Severity.Warning) return

    // A set message keys the entry. An empty one keys on the sorted attrs.
    const key = `${e.severity}|${e.source}|${diagnosticKey(e)}`
    const tsNow = this.now()
    const existing = this.active.get(e.source)

    const sameTuple =
      existing !== undefined &&
      existing.key === key &&
      this.dedupWindowMs > 0 &&
      tsNow - existing.lastAt <= this.dedupWindowMs

    if (sameTuple && existing !== undefined) {
      existing.count += 1
      existing.lastAt = tsNow
      // Throttle dedup paints so a storm doesn't fill scrollback with
      // identical (×N) lines. The count keeps climbing; the next paint
      // after the cooldown reflects the true total.
      if (tsNow - existing.lastPaintedAt >= this.dedupRepaintMinMs) {
        existing.lastPaintedAt = tsNow
        this.emit(`${renderDedupLine(e, existing)}\n`)
      }
      return
    }

    this.active.set(e.source, {
      key,
      count: 1,
      firstAt: tsNow,
      lastAt: tsNow,
      lastPaintedAt: tsNow,
    })
    this.emit(`${renderBlock(e)}\n`)
  }

  /**
   * Route a rendered chunk through the buffer (when active) or the
   * writer. Centralized so the buffering policy can't drift between
   * the full-block and dedup-line paths.
   */
  private emit(chunk: string): void {
    if (this.buffer !== null) {
      this.buffer.push(chunk)
      return
    }
    this.writeImpl(chunk)
  }
}

// ---------------------------------------------------------------------------
// Rendering — pure functions, exported for tests
// ---------------------------------------------------------------------------

/** Format an epoch-ms timestamp as local-time `HH:MM:SS`. */
export function formatScrollbackTs(ms: number): string {
  const d = new Date(ms)
  const h = String(d.getHours()).padStart(2, "0")
  const m = String(d.getMinutes()).padStart(2, "0")
  const s = String(d.getSeconds()).padStart(2, "0")
  return `${h}:${m}:${s}`
}

/**
 * Severity chrome: icon glyph, padded word (5 chars for visual
 * alignment when both kinds appear), and the gutter/word color.
 */
export function scrollbackSeverityChrome(sev: Severity): {
  icon: string
  word: string
  color: string
} {
  if (sev === Severity.Warning) {
    return { icon: "⚠", word: "warn ", color: PALETTE.gold }
  }
  const word =
    sev === Severity.Error
      ? "error"
      : sev === Severity.Critical
        ? "crit "
        : sev === Severity.Alert
          ? "alert"
          : "emerg"
  return { icon: "✗", word, color: PALETTE.red }
}

/** Render a full multi-line block (head + body rows + close arm). */
export function renderBlock(e: LogEvent): string {
  const { icon, word, color } = scrollbackSeverityChrome(e.severity)
  const head =
    `  ${paint(color, icon)} ${bold(color, word)} ` +
    `${paint(PALETTE.cyan, e.source)} ${dim(`· ${formatScrollbackTs(e.ts)}`)}`

  const body: string[] = []
  // Split the message on real newlines so each line carries its own
  // gutter prefix. Long single lines still wrap naturally in the
  // terminal (without continuation), matching console.error behavior.
  // An empty message prints no empty first row: the registry text leads
  // when a renderer exists, else only the data rows (or the fallback text
  // when there are none).
  const text = diagnosticText(e)
  const dataRows = e.structuredData
    ? Object.entries(e.structuredData).map(([k, v]) => `${dim(`${k}:`)} ${String(v)}`)
    : []
  const showText =
    e.message !== "" ||
    (text !== "" && (hasDiagnosticText(e.diagnostic?.source ?? "") || dataRows.length === 0))
  if (showText) {
    for (const line of text.split("\n")) {
      body.push(line)
    }
  }
  body.push(...dataRows)

  const out: string[] = [head]
  for (let i = 0; i < body.length; i++) {
    const arm = i === body.length - 1 ? "╰" : "│"
    out.push(`  ${paint(color, arm)} ${body[i]}`)
  }
  return out.join("\n")
}

/** Render the compact `(×N · last HH:MM:SS)` dedup line. */
export function renderDedupLine(e: LogEvent, state: DedupState): string {
  const { icon, word, color } = scrollbackSeverityChrome(e.severity)
  return (
    `  ${paint(color, icon)} ${bold(color, word)} ` +
    `${paint(PALETTE.cyan, e.source)} ` +
    dim(`(×${state.count} · last ${formatScrollbackTs(state.lastAt)})`)
  )
}

// ---------------------------------------------------------------------------
// NOTE (S34 Phase 2, Cluster 1c): core's `StructuredData` re-export that
// used to live here was dropped on the move, not carried over. It is a
// type-only convenience alias for `Readonly<Record<string, string | number
// | boolean>>`, deliberately NOT part of the public
// `@minimal-agent/core/host/diagnostics` surface (only the boot-time
// `getDiagnosticBus`/`createDiagnosticBus`/`Severity`/`Facility`/
// `DiagnosticBus`/`LogEvent` half is exported). Confirmed by a repo-wide
// search that nothing imports `StructuredData` from this module
// specifically (every other consumer reaches core's `src/bus/
// diagnostic-bus.ts` directly and stays in core) — safe to drop rather than
// reimplement a type nobody here uses.
// ---------------------------------------------------------------------------
