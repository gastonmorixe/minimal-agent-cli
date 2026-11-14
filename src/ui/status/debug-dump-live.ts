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
import { describeSystemBlock } from "@minimal-agent/core/host/system-block-origins"
import {
  type DumpBlock,
  isRequestDumpRow,
  RequestDumpCollector,
  renderDumpBlock,
} from "./debug-dump.ts"
import type { DumpOriginSource, SystemSlotSpan } from "./debug-dump-origins.ts"

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
  /**
   * Cells per line for the hanging-indent wrap of `--verbose` lines, read at
   * paint time. Return undefined (or omit) for no wrap. Verbose lines are
   * never clipped, only wrapped.
   */
  readonly wrapWidth?: () => number | undefined
  /** Explicit verbose gate, read at paint time. False forces the compact form. */
  readonly verbose?: () => boolean
  /** Origin data for the `--verbose` reference lines. */
  readonly origins?: DumpOriginSource
}

/** The terminal width from stdout, else `$COLUMNS`, else undefined. */
function terminalColumns(): number | undefined {
  const cols = process.stdout.columns ?? 0
  if (cols > 0) return cols
  const env = Number.parseInt(process.env.COLUMNS ?? "", 10)
  return Number.isFinite(env) && env > 0 ? env : undefined
}

/**
 * Line width for the live dump: the terminal width, or undefined under
 * `--verbose` (which promises untruncated debug output) or with no width.
 */
export function liveDumpWidth(): number | undefined {
  if (process.env.VERBOSE) return undefined
  return terminalColumns()
}

/**
 * Wrap width for `--verbose` dump lines: the terminal width (stdout, else
 * `$COLUMNS`), or undefined with no width, which means no wrap.
 */
export function liveDumpWrapWidth(): number | undefined {
  return terminalColumns()
}

/**
 * True when `--verbose` is on, so the dump renders real lines with a gutter.
 *
 * Read at paint time, like the widths. This is the explicit verbose decision:
 * without it the renderer would infer verbose mode from the presence of typed
 * `kind` rows, which core controls, not the user.
 */
export function liveDumpVerbose(): boolean {
  return (process.env.VERBOSE ?? "") !== ""
}

/** The loader capability that gives the afterInstructions text (memoized in core). */
interface PromptBlocksSource {
  getPromptBlocksAsync?(): Promise<{ readonly afterInstructions: string | null }>
}

/** Options for {@link attachLiveAreaRequestDump}. */
export interface LiveAreaDumpOptions {
  /** Bus to read. Defaults to the process bus. */
  readonly bus?: DiagnosticBus
  /** Origin data, typically the plugin loader. */
  readonly origins?: DumpOriginSource & PromptBlocksSource
  /**
   * Core slot spans of one system block text. Defaults to the core
   * `describeSystemBlock`. Tests inject a fake.
   */
  readonly describeSystemBlock?: (text: string) => readonly SystemSlotSpan[] | undefined
  /** Wrap width for verbose lines. Defaults to {@link liveDumpWrapWidth}. */
  readonly wrapWidth?: () => number | undefined
  /** Verbose gate. Defaults to {@link liveDumpVerbose}. */
  readonly verbose?: () => boolean
}

/**
 * Add the core slot describer and the afterInstructions text to the loader.
 *
 * The text is fetched once, in the background. `getPromptBlocksAsync` is
 * memoized in core, so this call costs nothing after the first session
 * prompt build. Until it resolves, fragment refs are not shown.
 *
 * The call is fully guarded: a synchronous throw or a non-thenable return must
 * not escape this function. `attachLiveAreaRequestDump` runs during TUI
 * startup, so an escape there aborts the whole session over a debug extra.
 */
function withOriginExtras(opts: LiveAreaDumpOptions): DumpOriginSource | undefined {
  const base = opts.origins
  const describe = opts.describeSystemBlock
  if (base === undefined && describe === undefined) return undefined
  let after: string | null | undefined
  const fetchBlocks = base?.getPromptBlocksAsync
  if (base !== undefined && typeof fetchBlocks === "function") {
    try {
      const pending: unknown = fetchBlocks.call(base)
      if (
        pending !== null &&
        (typeof pending === "object" || typeof pending === "function") &&
        typeof (pending as { then?: unknown }).then === "function"
      ) {
        ;(pending as Promise<{ readonly afterInstructions: string | null }>)
          .then((b) => {
            after = b.afterInstructions
          })
          .catch(() => undefined)
      }
    } catch {
      // A loader that throws here is the same as one with no text: refs fall
      // back to "origin not recorded" and the dump still renders.
    }
  }
  return {
    loadedPackages: () => (typeof base?.loadedPackages === "function" ? base.loadedPackages() : []),
    ...(typeof base?.toolOwners === "function"
      ? { toolOwners: () => base.toolOwners?.() ?? new Map() }
      : {}),
    ...(typeof base?.getPromptProvenance === "function"
      ? { getPromptProvenance: () => base.getPromptProvenance?.() }
      : {}),
    ...(describe === undefined
      ? typeof base?.describeSystemBlock === "function"
        ? { describeSystemBlock: (t: string) => base.describeSystemBlock?.(t) }
        : {}
      : { describeSystemBlock: describe }),
    afterInstructionsText: () => after ?? base?.afterInstructionsText?.(),
  }
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
 * @param opts - Bus, origin data (the plugin loader), slot describer, wrap width.
 * @returns Handle whose `dispose()` unsubscribes and flushes the tail.
 */
export function attachLiveAreaRequestDump(
  compositor: DumpStreamWriter,
  opts: LiveAreaDumpOptions = {},
): RequestDumpRenderHandle {
  const origins = withOriginExtras({
    ...opts,
    describeSystemBlock: opts.describeSystemBlock ?? describeSystemBlock,
  })
  return attachRequestDumpRenderer({
    bus: opts.bus ?? getDiagnosticBus(),
    write: (text) => compositor.writeStream(text),
    width: liveDumpWidth,
    wrapWidth: opts.wrapWidth ?? liveDumpWrapWidth,
    verbose: opts.verbose ?? liveDumpVerbose,
    ...(origins === undefined ? {} : { origins }),
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
  const paint = (block: DumpBlock): void => {
    const wrapWidth = opts.wrapWidth?.()
    const verbose = {
      ...(opts.verbose === undefined ? {} : { enabled: opts.verbose() }),
      ...(opts.origins === undefined ? {} : { origins: opts.origins }),
      ...(wrapWidth === undefined ? {} : { wrapWidth }),
    }
    write(`${renderDumpBlock(block, opts.width?.(), verbose).join("\n")}\n`)
  }

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
