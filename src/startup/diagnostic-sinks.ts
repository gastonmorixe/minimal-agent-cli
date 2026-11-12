/**
 * Diagnostic-sink wiring for agent startup.
 *
 * Attaches the process-wide diagnostic sinks to the diagnostic bus, in the
 * order the boot flow needs them: the per-session file log, the persistent
 * cross-session audit log, the scrollback sink (Warning+ terminal chrome),
 * and the opt-in stderr mirror. Lifted out of `src/index.ts` so the entry
 * point stays a thin composition root.
 *
 * The scrollback sink is RETURNED (not just attached) because the entry
 * point drives its two-phase lifecycle: `startBuffering()` here — before any
 * startup-banner row is drawn — and `flushBuffer()` later, after
 * `closeStartupTree()` commits the final row. Without that split, a warning
 * emitted mid-banner would tear through the box mid-paint.
 *
 * The sinks attach by stdio mode (S38). The file and global logs attach in
 * every mode. The scrollback sink does not attach in `protocol` mode, so no
 * human chrome reaches stderr there. `--debug` (or
 * `MINIMAL_AGENT_LOG_STDERR=1`) attaches the plain stderr mirror instead.
 *
 * @module host/startup/diagnostic-sinks
 */

import { getDiagnosticBus } from "@minimal-agent/core/host/diagnostics"
import { getSessionId } from "@minimal-agent/core/host/session-id"
import type { StdioMode } from "../cli/output-format.ts"
import { registerA1DiagnosticText } from "../logging/diagnostic-text-a1.ts"
import type { ScrollbackDiagnosticSink } from "../ui/status/scrollback.ts"

/** Inputs the sink wiring needs from the entry point. */
export interface DiagnosticSinkOptions {
  /** Whether the startup banner will be drawn (arms scrollback buffering). */
  readonly showHeader: boolean
  /** The process environment (only `MINIMAL_AGENT_LOG_STDERR` is read). */
  readonly env: Record<string, string | undefined>
  /** How this run uses stdio. Default `interactive` (the old wiring). */
  readonly mode?: StdioMode
  /** `--debug` is set: mirror diagnostics to stderr outside the TUI. */
  readonly debug?: boolean
}

/** Which optional sinks attach. The file and global logs always attach. */
export interface DiagnosticSinkPlan {
  /** The Warning+ scrollback sink (human chrome on stderr). */
  readonly scrollback: boolean
  /** The plain one-line stderr mirror of every diagnostic. */
  readonly stderrMirror: boolean
}

/**
 * Decide which optional sinks attach for a stdio mode. Pure.
 *
 * `protocol` mode gets no scrollback sink. `--debug` adds the stderr mirror
 * in `protocol` and `print` mode. The REPL keeps its TUI surfaces, so
 * `--debug` adds no raw mirror there (a raw fd 2 write would tear the live
 * area). `MINIMAL_AGENT_LOG_STDERR=1` adds the mirror in every mode, as before.
 */
export function planDiagnosticSinks(opts: DiagnosticSinkOptions): DiagnosticSinkPlan {
  const mode = opts.mode ?? "interactive"
  const debugMirror = opts.debug === true && mode !== "interactive"
  return {
    scrollback: mode !== "protocol",
    stderrMirror: opts.env.MINIMAL_AGENT_LOG_STDERR === "1" || debugMirror,
  }
}

/**
 * Construct and attach the startup diagnostic sinks to the bus.
 *
 * @param opts - Header visibility, environment, stdio mode, debug flag.
 * @returns The scrollback sink, so the caller can drive its buffer lifecycle.
 *   `null` when the plan attaches no scrollback sink (`protocol` mode).
 */
export async function attachStartupDiagnosticSinks(
  opts: DiagnosticSinkOptions,
): Promise<ScrollbackDiagnosticSink | null> {
  // Renderers first. Core sends the old message AND attrs (dual-write), so
  // these render only when the message is empty (the later step).
  registerA1DiagnosticText()
  const bus = getDiagnosticBus()
  const plan = planDiagnosticSinks(opts)

  const { FileLogSink } = await import("@minimal-agent/core/host/log-file")
  new FileLogSink(getSessionId()).attach(bus)

  // Persistent, cross-session audit log (`~/.minimal-agent/ma.log`). Unlike
  // the per-session file sink above, this single durable log survives across
  // runs and records long-lived subsystem history. Notice+ only, session id
  // stamped into every line. Best-effort; never throws into boot.
  const { GlobalLogSink } = await import("@minimal-agent/core/host/log-global")
  new GlobalLogSink({ sessionId: getSessionId() }).attach(bus)

  if (plan.stderrMirror) {
    // No interceptor yet — write straight to fd 2. The live-area bootstrap
    // re-attaches a compositor-aware mirror once the interceptor exists.
    const { StderrMirrorSink } = await import("../logging/log-stderr.ts")
    new StderrMirrorSink().attach(bus)
  }

  if (!plan.scrollback) return null

  // Scrollback sink — renders Warning+ events as gutter-bracketed blocks
  // (gold ⚠ warn / red ✗ error) in the persistent terminal transcript.
  // Attached here, before any other subsystem can emit, so the first error
  // of the session is captured.
  const { ScrollbackDiagnosticSink } = await import("../ui/status/scrollback.ts")
  const scrollbackSink = new ScrollbackDiagnosticSink()
  scrollbackSink.attach(bus)

  // Start buffering immediately: any diagnostic that fires during the banner
  // window gets queued and flushed below the banner once the startup tree's
  // final row is committed.
  if (opts.showHeader) scrollbackSink.startBuffering()

  return scrollbackSink
}
