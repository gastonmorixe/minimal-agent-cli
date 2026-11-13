/**
 * Live-area `--debug` wiring: subscribe to the transport's request-dump
 * diagnostics and paint them as colored blocks above the prompt.
 *
 * # Why a separate module
 *
 * `runReplLiveArea` owns the editor and the compositor but is already at the
 * project's file-size budget, and this wiring attaches only when `--debug` is
 * on. Keeping it here also makes it testable without building the whole TTY
 * stack: the sink takes a bus and a writer, nothing else.
 *
 * # Why the compositor writer
 *
 * The pre-split dump wrote through `console.error`, and the live-area
 * `StdioInterceptor` turned that into a `compositor.writeStream` call — the
 * only path that lands text ABOVE the pinned live area. Writing to raw fd 2
 * instead (what the boot-time `StderrMirrorSink` does) would print over the
 * editor. We use the same channel the REPL itself uses for transcript rows.
 *
 * @module ui/status/debug-dump-live
 */

import {
  type DiagnosticBus,
  getDiagnosticBus,
  Severity,
} from "@minimal-agent/core/host/diagnostics"
import {
  type DumpBlock,
  isRequestDumpRow,
  RequestDumpCollector,
  renderDumpBlock,
} from "./debug-dump.ts"

/** What the sink needs to paint. */
export interface RequestDumpRenderOptions {
  /** The bus the transport emits `transport.request-dump` on. */
  readonly bus: DiagnosticBus
  /** Write one finished block above the live area (typically `compositor.writeStream`). */
  readonly write: (text: string) => void
  /**
   * Cells per line, read at paint time so a resize applies. Return undefined
   * to keep lines whole. Omitted: lines are never clipped.
   */
  readonly width?: () => number | undefined
}

/**
 * Line width for the live dump: the terminal width, or undefined under
 * `--verbose` (which promises untruncated debug output) or with no width.
 */
export function liveDumpWidth(): number | undefined {
  if (process.env.VERBOSE) return undefined
  const cols = process.stdout.columns ?? 0
  if (cols > 0) return cols
  const env = Number.parseInt(process.env.COLUMNS ?? "", 10)
  return Number.isFinite(env) && env > 0 ? env : undefined
}

/** Live wiring handle. Call {@link RequestDumpRenderHandle.dispose} on teardown. */
export interface RequestDumpRenderHandle {
  /** Unsubscribe and drain anything still buffered. */
  dispose(): void
}

/** The one compositor capability this wiring needs. */
export interface DumpStreamWriter {
  /** Write text above the pinned live area. */
  writeStream(chunk: string): void
}

/**
 * Attach the renderer to the live area.
 *
 * Separate from {@link attachRequestDumpRenderer} so the REPL keeps a one-line
 * call site: `runReplLiveArea` sits at the project's file-size budget, and the
 * wiring should not push it over.
 *
 * @param compositor - The live-area compositor.
 * @returns Handle whose `dispose()` unsubscribes and flushes the tail.
 */
export function attachLiveAreaRequestDump(
  compositor: DumpStreamWriter,
  bus: DiagnosticBus = getDiagnosticBus(),
): RequestDumpRenderHandle {
  return attachRequestDumpRenderer({
    bus,
    write: (text) => compositor.writeStream(text),
    width: liveDumpWidth,
  })
}

/**
 * Attach the renderer. Debug rows are collected per request and painted as
 * one colored block when the transport marks its final row.
 *
 * A Debug row on this source without the row index is outside the structured
 * contract; it is written verbatim so a producer that skips the contract still
 * surfaces instead of vanishing.
 *
 * @param opts - Bus + writer.
 * @returns Handle whose `dispose()` unsubscribes and flushes the tail.
 */
export function attachRequestDumpRenderer(opts: RequestDumpRenderOptions): RequestDumpRenderHandle {
  const collector = new RequestDumpCollector()
  const { write } = opts
  const paint = (block: DumpBlock): void =>
    write(`${renderDumpBlock(block, opts.width?.()).join("\n")}\n`)

  const off = opts.bus.on(
    (e) => e.source === "transport.request-dump" && e.severity === Severity.Debug,
    (e) => {
      if (!isRequestDumpRow(e.source, e.structuredData)) {
        write(`${e.message}\n`)
        return
      }
      const completed = collector.push(e.message, e.structuredData)
      if (completed !== null) paint(completed)
    },
  )

  return {
    dispose: () => {
      off()
      const tail = collector.flush()
      if (tail !== null) paint(tail)
    },
  }
}
