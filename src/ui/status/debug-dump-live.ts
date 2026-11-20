/**
 * Live-area `--debug` wiring: subscribe to core's typed `llm.requestWillSend`
 * channel (the request inspector) and paint each request as one colored
 * block above the prompt.
 *
 * # Zero cost
 *
 * Core builds the request snapshot only when the channel has a subscriber.
 * The REPL attaches this renderer only with `--debug` (see
 * `startup/live-repl.ts`), so a run without it costs one `Set.size` read
 * per request.
 *
 * # No double render
 *
 * With `--debug` the plain-text log sink (`logging/request-dump-log.ts`)
 * also re-emits each request as `transport.request-dump` Debug diagnostics,
 * for the file log. No TUI diagnostic sink draws them: the scrollback sink
 * drops anything above Warning, the footer surface ignores Debug, and the
 * stderr mirror is off in interactive mode. This renderer reads the typed
 * event, never those rows, so each request is painted once.
 *
 * # Why a separate module
 *
 * `runReplLiveArea` owns the editor and the compositor but is already at the
 * project's file-size budget, and this wiring attaches only when `--debug` is
 * on. Keeping it here also makes it testable without building the whole TTY
 * stack: the sink takes a channel and a writer, nothing else.
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
  processRequestInspector,
  type RequestInspector,
} from "@minimal-agent/core/host/request-inspector"
import { NO_SIDEBAND } from "@minimal-agent/core/host/sideband"
import { describeSystemBlock } from "@minimal-agent/core/host/system-block-origins"
import { type DebugGateEnv, isVerboseEnv } from "../../cli/debug-gate.ts"
import { dumpView } from "../../logging/request-dump-model.ts"
import { renderDumpBlock } from "./debug-dump.ts"
import type { DumpOriginSource, SystemSlotSpan } from "./debug-dump-origins.ts"

/** What the sink needs to paint. */
export interface RequestDumpRenderOptions {
  /** The `llm.requestWillSend` channel to subscribe to. */
  readonly inspector: RequestInspector
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
  /** Verbose gate, read at paint time. Omitted or false: the compact form. */
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
 *
 * @param env - The environment for the `VERBOSE` gate. Default: `process.env`.
 */
export function liveDumpWidth(env: DebugGateEnv = process.env): number | undefined {
  if (isVerboseEnv(env)) return undefined
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
 * Read at paint time, like the widths. The verbose form is a CLI decision:
 * core sends the same snapshot either way.
 *
 * @param env - The environment. Default: `process.env`.
 */
export function liveDumpVerbose(env: DebugGateEnv = process.env): boolean {
  return isVerboseEnv(env)
}

/** The loader capability that gives the afterInstructions text (memoized in core). */
interface PromptBlocksSource {
  getPromptBlocksAsync?(): Promise<{ readonly afterInstructions: string | null }>
}

/** Options for {@link attachLiveAreaRequestDump}. */
export interface LiveAreaDumpOptions {
  /** Channel to subscribe to. Defaults to the process channel. */
  readonly inspector?: RequestInspector
  /** Origin data, typically the plugin loader. */
  readonly origins?: DumpOriginSource & PromptBlocksSource
  /**
   * Core slot spans of one system block text. Defaults to the core
   * `describeSystemBlock`. Tests inject a fake.
   */
  readonly describeSystemBlock?: (text: string) => readonly SystemSlotSpan[] | undefined
  /** Wrap width for verbose lines. Defaults to {@link liveDumpWrapWidth}. */
  readonly wrapWidth?: () => number | undefined
  /** Verbose gate. Defaults to {@link liveDumpVerbose} on `env`. */
  readonly verbose?: () => boolean
  /** The environment for the `VERBOSE` gate, read at paint time. Default: `process.env`. */
  readonly env?: DebugGateEnv
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
    // The loader's sideband API: it finds the section tags and the attachments.
    ...(typeof base?.sideband === "function"
      ? { sideband: () => base.sideband?.() ?? NO_SIDEBAND }
      : {}),
  }
}

/** Live wiring handle. Call {@link RequestDumpRenderHandle.dispose} on teardown. */
export interface RequestDumpRenderHandle {
  /** Unsubscribe. Idempotent. Nothing is buffered: one request is one event. */
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
 * @param opts - Channel, origin data (the plugin loader), slot describer, wrap width.
 * @returns Handle whose `dispose()` unsubscribes.
 */
export function attachLiveAreaRequestDump(
  compositor: DumpStreamWriter,
  opts: LiveAreaDumpOptions = {},
): RequestDumpRenderHandle {
  const env = opts.env ?? process.env
  const origins = withOriginExtras({
    ...opts,
    describeSystemBlock: opts.describeSystemBlock ?? describeSystemBlock,
  })
  return attachRequestDumpRenderer({
    inspector: opts.inspector ?? processRequestInspector(),
    write: (text) => compositor.writeStream(text),
    width: () => liveDumpWidth(env),
    wrapWidth: opts.wrapWidth ?? liveDumpWrapWidth,
    verbose: opts.verbose ?? (() => liveDumpVerbose(env)),
    ...(origins === undefined ? {} : { origins }),
  })
}

/**
 * Attach the live-area renderer only when the user asked for it.
 *
 * Without `--debug` this subscribes to nothing, so core sees no subscriber on
 * the request channel and builds no snapshot (zero cost).
 *
 * @param compositor - The live-area compositor.
 * @param debug - The parsed `opts.debug` (`--debug` or `DEBUG=1`, the rule of
 *   `cli/debug-gate.ts`).
 * @param opts - See {@link attachLiveAreaRequestDump}.
 * @returns The handle, or `null` when the dump is off.
 */
export function attachLiveAreaRequestDumpIfWanted(
  compositor: DumpStreamWriter,
  debug: boolean,
  opts: LiveAreaDumpOptions = {},
): RequestDumpRenderHandle | null {
  return debug ? attachLiveAreaRequestDump(compositor, opts) : null
}

/**
 * Attach the renderer. Each `llm.requestWillSend` event is painted as one
 * colored block, synchronously, inside the event call (the snapshot is valid
 * only during that call, and the view copies what it needs).
 *
 * @param opts - Channel + writer.
 * @returns Handle whose `dispose()` unsubscribes.
 */
export function attachRequestDumpRenderer(opts: RequestDumpRenderOptions): RequestDumpRenderHandle {
  const off = opts.inspector.subscribe((event) => {
    const enabled = opts.verbose?.() ?? false
    const view = dumpView(event.request, { lines: enabled, ts: event.ts })
    const wrapWidth = opts.wrapWidth?.()
    const verbose = {
      enabled,
      ...(opts.origins === undefined ? {} : { origins: opts.origins }),
      ...(wrapWidth === undefined ? {} : { wrapWidth }),
    }
    opts.write(`${renderDumpBlock(view, opts.width?.(), verbose).join("\n")}\n`)
  })
  return { dispose: off }
}
