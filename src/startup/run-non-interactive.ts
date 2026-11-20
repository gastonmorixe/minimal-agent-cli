/**
 * Non-interactive (`--prompt` / `-` / bare-positional) agent run.
 *
 * Owns the one-shot output path. Two routes:
 *
 *   - **Legacy / human + `--output-schema`**: formatter spin-up, `--json` vs
 *     human vs `--output-schema` routing (via {@link PrintOutput}), streaming
 *     the agent's chunks through the plugin stream, and the schema
 *     validate-and-exit gate. Behavior here is UNCHANGED — `text` mode is
 *     byte-identical to before this module grew the event-stream branch.
 *   - **Structured event stream (`--output-format json` / `stream-json`)**:
 *     when the host injects a
 *     {@link RunNonInteractivePromptInput.openEventStreamSession} factory and
 *     the format is `json`/`stream-json` (and no `--output-schema`), the run
 *     drives a `createRuntime`/`Session` turn (`session.run()`) and
 *     serializes every {@link SessionEntry} whose `data.kind` is kept to
 *     one JSONL line on stdout, in the exact wire format
 *     {@link serializeEvent} produces. `json` keeps
 *     {@link LEGACY_EVENT_KINDS}. `stream-json` keeps
 *     {@link STREAM_JSON_EVENT_KINDS}, so its last line is `run_finished`.
 *     Each stream-json line also carries `sessionId`, `seq`, and `ts` after
 *     the event keys (see {@link serializeStreamJsonLine}). json lines do not.
 *     When the host passes {@link RunNonInteractivePromptInput.streamInfo},
 *     the first stream-json line is `session_started`, written before the
 *     session opens.
 *     All stream-json lines go through one writer
 *     (`host/startup/stream-json-writer.ts`), which owns `seq`. A failure
 *     after argv parse still ends stdout with an `error` line and a
 *     `run_finished` line with outcome `failed`: the core writes them for a
 *     failure inside the run, and the host writes them for a failure outside
 *     it (a failed session open, a resume failure, a `turn.willStart` halt).
 *     Argv and flag errors give no JSON. They go to stderr only.
 *     The events ARE the output; the yielded text channel is drained and
 *     discarded (the `item_completed` events already carry the assistant
 *     text).
 *
 * `Session`'s own event log always captures every `AgentEvent` kind — that is
 * its whole point, a complete trace (agent E's S48 design) — so this module
 * does NOT ask it to log anything less. It filters at its OWN subscription
 * boundary instead. The `json` route keeps the frozen `LEGACY_EVENT_KINDS`
 * wire format it has always shipped (`events-jsonl.integration.test.ts`).
 * The `stream-json` route also keeps the closing `run_finished` line.
 *
 * The `Session` is built by an INJECTED factory, not constructed here: the
 * host (index.ts) closes over its collaborators and calls the
 * `openAgentCoreSession(deps)` seam (core `src/loops/assemble.ts`)
 * — the same host collaborators `buildAgentCore` wires, handed to
 * `createRuntime().openSession(...)` instead of `new AgentCore(...)`. That
 * keeps this file free of the core `src/adapters/` lane and lets `json`/
 * `stream-json` fall back to the legacy path until the factory is wired, so no
 * path regresses before integration.
 *
 * **Stdio guard (S38).** The JSON route installs a stdout guard
 * ({@link installJsonStdioGuard}). Only the guard's own writer (the tagged
 * writer of the JSON event lines) reaches stdout. Every other stdout write
 * and every stdout `console` call is dropped and counted. A run with a dropped write
 * fails with exit code 1, so a stray human line can never pass unseen.
 *
 * **`--diagnostics` (S39).** On the `json` route the flag writes each kept
 * entry with {@link serializeEntry}: `{v:1, seq, ts, sessionId, ch, data}`.
 * `ch:"event"` lines hold the same kept events. `ch:"diag"` lines hold every
 * session diagnostic. Without the flag, stdout matches the golden byte for
 * byte. The `stream-json` route ignores the flag (it has its own envelope).
 *
 * **`--output-format open-responses` (SPEC-ONESHOT R16).** The same event
 * route, with a different writer: {@link OrOutputWriter} turns the events
 * into Open Responses SSE events (`orStream`) or one `response` object.
 * stdout carries only that output (no event lines, no result line). A
 * schema run is buffered: the final answer is written at the end. A failed
 * schema check keeps the text, puts the message in `metadata.output_error`,
 * and exits 1 after the output.
 *
 * Split out of `src/index.ts` to keep the entry point under the `max-lines`
 * lint budget.
 *
 * @module host/startup/run-non-interactive
 */

import { type Session, serializeEntry } from "@minimal-agent/core"
import { fatalErrorFields } from "@minimal-agent/core/host/error-hint"
import { getSessionId } from "@minimal-agent/core/host/session-id"
import type { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { PluginStream } from "@minimal-agent/core/host-kit/plugin-stream"
import { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import {
  type AgentEvent,
  LEGACY_EVENT_KINDS,
  STREAM_JSON_EVENT_KINDS,
  serializeEvent,
} from "@minimal-agent/core/sdk/events"
import type { HookContextEntry } from "@minimal-agent/core/sdk/lifecycle"
import { extractPromptFromArgs } from "../cli/extract-prompt.ts"
import { type OutputFormat, resolveStdioMode, type StdioMode } from "../cli/output-format.ts"
import { retryBoundaryText } from "../logging/retry-boundary-text.ts"
import { agentCoreOf, armOneShotRun, type OneShotRunOptions } from "../oneshot/arm-run.ts"
import { correctivePrompt } from "../oneshot/json-schema-check.ts"
import { type OrError, OrOutputWriter } from "../oneshot/or-output.ts"
import {
  accumulateResultEvent,
  buildResultLine,
  checkResultOutput,
  createResultAccumulator,
  type ResultAccumulator,
  type ResultLine,
  resultText,
  type SchemaOutcome,
} from "../oneshot/result-line.ts"
import { enforceOutputSchema, PrintOutput, resolvePrintModeOptions } from "../print-output.ts"
import type { ReplAgentLike } from "../repl.ts"
import { applyTurnWillStart } from "../repl-editor-hooks.ts"
import { Formatter } from "../ui/formatter/formatter.ts"
import { DRY_RUN_DONE_MESSAGE, isDryRunHalt } from "./dry-run.ts"
import {
  type HeadlessWrapUp,
  type HeadlessWrapUpOptions,
  installHeadlessWrapUp,
  SIGTERM_EXIT_CODE,
  wantsHeadlessWrapUp,
} from "./headless-wrap-up.ts"
import { isHostModeRun } from "./resume-mode.ts"
import {
  type StreamInfo,
  setStreamJsonWrite,
  writeStreamJsonEvent,
  writeStreamJsonFailure,
  writeStreamJsonSessionStarted,
} from "./stream-json-writer.ts"

export type { StreamInfo } from "./stream-json-writer.ts"

/** The stderr text of a `turn.willStart` halt. */
const TURN_BLOCKED_MESSAGE = "turn.willStart: prompt blocked by lifecycle policy hook."

/**
 * The error for a prompt that a `turn.willStart` hook halted. Every host
 * route that runs the hook (this one-shot run, `run-host-mode.ts`) uses it,
 * so the failure has one message and one `code` ("turn.blocked").
 */
export function turnBlockedError(): Error & { code: "turn.blocked" } {
  return Object.assign(new Error(TURN_BLOCKED_MESSAGE), { code: "turn.blocked" as const })
}

/** The stdout guard of the JSON route. See {@link installJsonStdioGuard}. */
export interface JsonStdioGuard {
  /** The tagged writer: the one path to the real stdout. */
  readonly write: (chunk: string) => void
  /** How many stray writes (stdout or a stdout `console` call) the guard dropped. */
  readonly strays: () => number
  /** Put back `process.stdout.write` and the stdout `console` calls. */
  readonly restore: () => void
}

let activeGuard: JsonStdioGuard | null = null

/**
 * Install the JSON-route stdout guard (S38), or return the one already
 * installed. The guard replaces `process.stdout.write`, `console.log`,
 * `console.info`, and `console.debug`.
 * Only {@link JsonStdioGuard.write} reaches the real stdout. Any other write
 * is dropped and counted. The guard also becomes the stream-json writer, so
 * the host's failure lines pass it.
 */
export function installJsonStdioGuard(): JsonStdioGuard {
  if (activeGuard !== null) return activeGuard
  const stdout = process.stdout
  const realWrite = stdout.write.bind(stdout)
  // console.log, console.info, and console.debug all write to stdout.
  const originalConsole = { log: console.log, info: console.info, debug: console.debug }
  let strays = 0
  stdout.write = ((...args: unknown[]) => {
    strays++
    const cb = args.find((a): a is (err?: Error) => void => typeof a === "function")
    cb?.()
    return true
  }) as typeof stdout.write
  const dropConsole = (): void => {
    strays++
  }
  console.log = dropConsole
  console.info = dropConsole
  console.debug = dropConsole
  const guard: JsonStdioGuard = {
    write: (chunk) => void realWrite(chunk),
    strays: () => strays,
    restore: () => {
      stdout.write = realWrite
      console.log = originalConsole.log
      console.info = originalConsole.info
      console.debug = originalConsole.debug
      if (activeGuard === guard) activeGuard = null
    },
  }
  activeGuard = guard
  setStreamJsonWrite(guard.write)
  return guard
}

/**
 * Pick the {@link StdioMode} at boot, after subcommand dispatch (S38). On the
 * JSON event route (`json` / `stream-json`, a prompt, no `--output-schema`)
 * it also installs the stdout guard, so a stray write from any later boot
 * step fails the run. `--host-mode` installs its own guard.
 */
export function selectStdioMode(
  args: readonly string[],
  command: string,
  opts: { readonly outputFormat: OutputFormat; readonly outputSchemaPath: string | undefined },
): StdioMode {
  const hostMode = isHostModeRun(command)
  const mode = resolveStdioMode({
    outputFormat: opts.outputFormat,
    hostMode,
    hasPrompt: extractPromptFromArgs(args).kind !== "none",
  })
  if (mode === "protocol" && !hostMode && opts.outputSchemaPath === undefined) {
    installJsonStdioGuard()
  }
  return mode
}

/** `LEGACY_EVENT_KINDS`, as a `Set` for an O(1) membership check per entry. */
const LEGACY_EVENT_KIND_SET: ReadonlySet<string> = new Set(LEGACY_EVENT_KINDS)

/** `STREAM_JSON_EVENT_KINDS`, as a `Set`. It adds `run_finished` to the legacy nine. */
const STREAM_JSON_EVENT_KIND_SET: ReadonlySet<string> = new Set(STREAM_JSON_EVENT_KINDS)

/** Inputs for {@link runNonInteractivePrompt}. */
export interface RunNonInteractivePromptInput {
  /** The initialized agent / InteractiveSession to drive. */
  readonly agent: ReplAgentLike
  /** The resolved one-shot prompt text. */
  readonly prompt: string
  /** Resolved formatter argv, or undefined when none. */
  readonly formatterCmd: string[] | undefined
  /** Whether the startup header was shown (drives the leading blank line). */
  readonly showHeader: boolean
  /** `--json` output-mode flag. */
  readonly wantJsonOutput: boolean
  /**
   * The resolved output format (`text` | `json` | `stream-json`). Optional so
   * the entry point can adopt it incrementally: when omitted the run behaves
   * exactly as the `--json` boolean dictates (legacy path). When it is
   * `json`/`stream-json` AND {@link openEventStreamSession} is provided (and
   * no `outputSchema`), the structured event-stream path runs instead.
   */
  readonly outputFormat?: OutputFormat
  /** Parsed `--output-schema`, or undefined. */
  readonly outputSchema: object | undefined
  /**
   * One-shot values (`--temperature`, `--strict`, SPEC-ONESHOT R6/R9) armed
   * on the core right before the prompt run, on both routes. A setter the
   * core lacks is skipped.
   */
  readonly oneShotRunOptions?: OneShotRunOptions
  /** The active plugin loader when plugins loaded, else null. */
  readonly loader: PluginLoader | null
  /** Working directory for the plugin stream. */
  readonly cwd: string
  /**
   * Injected `Session` factory for the structured event-stream path. The host
   * closes over its collaborators and calls the `openAgentCoreSession(deps)`
   * seam (core `src/loops/assemble.ts`) — the same host
   * collaborators `buildAgentCore` wires, over `createRuntime().openSession`
   * instead of `new AgentCore(...)`. Absent until the entry point wires it,
   * in which case `json`/`stream-json` fall back to the legacy path so
   * nothing regresses.
   *
   * Returns a promise: the real `openAgentCoreSession(deps)` awaits the
   * plugin prompt block asynchronously at construction (for G1 byte-parity),
   * so the factory is awaited here.
   */
  readonly openEventStreamSession?: () => Promise<Session>
  /**
   * Session info for the first stream-json line (`session_started`). When it
   * is set and the format is `stream-json`, that line is written at seq 0,
   * before the session opens. When it is unset, no such line is written and
   * events start at seq 0. The json route ignores it. Never put auth,
   * tokens, credential names, or env values here.
   */
  readonly streamInfo?: StreamInfo
  /**
   * Where JSONL event lines go in the structured path. Injected for testing;
   * defaults to `process.stdout`. Only consulted on the event-stream route.
   */
  readonly stdout?: (chunk: string) => void
  /** Exit hook for tests. Defaults to `process.exit`. */
  readonly exit?: (code: number) => never
  /**
   * `--diagnostics` (S39): on the `json` route, write session log entries
   * (`ch:"event"` and `ch:"diag"`) instead of bare events.
   */
  readonly diagnostics?: boolean
  /** Where the guard's failure note goes. Defaults to `process.stderr`. */
  readonly stderr?: (chunk: string) => void
  /**
   * `--output-format open-responses`: the request had `stream: true`, so
   * write SSE events. Else one `response` JSON object. Default false.
   * The entry point sets it as `oneShotRunOptions.orStream` (or-input.ts
   * `withAppend`, then `setupOneShot`). Either one set to true is enough.
   */
  readonly orStream?: boolean
  /**
   * `--dry-run`: the dry-run plugin halts the send (`LifecycleDeniedError`).
   * That halt is the expected end, so the run exits 0 with one stderr line.
   * Default false: the halt is a failure, as before.
   */
  readonly dryRun?: boolean
  /**
   * The SIGTERM wrap-up of the event-stream route (`headless-wrap-up.ts`).
   * It is installed only for a sub-agent worker (a non-empty
   * `MINIMAL_AGENT_WRAP_UP_TOOLS` in `wrapUp.env`, default `process.env`).
   * Injectable for tests (a fake signal source, no real exit). Default:
   * the real process.
   */
  readonly wrapUp?: HeadlessWrapUpOptions
}

/**
 * True when `err` is the expected send halt of a `--dry-run` run. Writes
 * the done line to stderr in that case.
 */
function endsDryRun(input: RunNonInteractivePromptInput, err: unknown): boolean {
  if (input.dryRun !== true || !isDryRunHalt(err)) return false
  const stderr = input.stderr ?? ((chunk: string) => void process.stderr.write(chunk))
  stderr(`${DRY_RUN_DONE_MESSAGE}\n`)
  return true
}

/** The request asked for an SSE stream (`orStream` or `oneShotRunOptions.orStream`). */
function wantsOrStream(input: RunNonInteractivePromptInput): boolean {
  return input.orStream === true || input.oneShotRunOptions?.orStream === true
}

/**
 * Whether the core in use can arm a one-shot `outputSchema` on a `Session`
 * run (D1 setter, risk K1). The pinned core lacks it: then `--output-schema`
 * with json / stream-json stays on the buffered legacy path, as before.
 */
export function canArmRunOutputSchema(): boolean {
  const proto = AgentCore.prototype as unknown as { setNextRunOutputSchema?: unknown }
  return typeof proto.setNextRunOutputSchema === "function"
}

/**
 * Whether this run should take the structured event-stream route: a
 * `json`/`stream-json` format and an injected session factory. With
 * `--output-schema` (R10) the event stream stays on when the core can arm
 * the schema on the run. Else schema enforcement stays on the buffered
 * legacy path.
 */
function wantsEventStream(input: RunNonInteractivePromptInput): boolean {
  const fmt = input.outputFormat
  if (fmt === "open-responses") return input.openEventStreamSession !== undefined
  if (fmt !== "json" && fmt !== "stream-json") return false
  if (input.openEventStreamSession === undefined) return false
  if (input.outputSchema !== undefined && !canArmRunOutputSchema()) return false
  return true
}

/** Arm the `--output-schema` on the session core for its next run (D1). */
function armRunOutputSchema(session: Session, schema: object): void {
  const core = agentCoreOf(session) as { setNextRunOutputSchema?: (s: object) => void } | undefined
  if (typeof core?.setNextRunOutputSchema === "function") core.setNextRunOutputSchema(schema)
}

/**
 * Drive a `Session` turn (`session.run()`) and emit its kept entries as
 * JSONL to stdout. Used for `--output-format json` / `stream-json`. `json`
 * keeps `LEGACY_EVENT_KINDS`. `stream-json` keeps `STREAM_JSON_EVENT_KINDS`,
 * which adds the closing `run_finished` line. That line is written before
 * any `exit` call, because `Session` drains its queue first. Each stream-json
 * line gets the envelope keys `sessionId` (the entry's session id), `seq` (a
 * count of lines on this stdout, from 0), and `ts` (the entry's epoch ms).
 * json lines stay byte-identical to `serializeEvent(entry.data)`.
 *
 * `Session`'s own event log always captures every `AgentEvent` kind (its
 * whole point, a complete trace) — this function filters AT THIS
 * SUBSCRIPTION BOUNDARY instead of asking it to log anything less, so the
 * line written for each kept entry is `serializeEvent(entry.data)`, the
 * exact same bytes `JsonlEventSink` would have written for that same event.
 * Each kept entry is written the instant `session.run()` yields it, so
 * `stream-json` is live by construction; `json` sees the same events (it
 * does not opt into deltas, so none are ever kept for it). The yielded text
 * channel is drained and discarded: the `item_completed` events already
 * carry the assistant text, matching the frozen SDK wire contract
 * (`events-jsonl.integration.test.ts`).
 */
async function runCoreEventStream(
  input: RunNonInteractivePromptInput,
  turnContext: readonly HookContextEntry[] = [],
): Promise<void> {
  // The host may install the guard at boot. Otherwise this run installs it
  // and removes it at the end.
  const ownGuard = activeGuard === null
  const guard = installJsonStdioGuard()
  try {
    await runGuardedEventStream(input, guard, turnContext)
  } finally {
    if (ownGuard) guard.restore()
  }
}

/** {@link runCoreEventStream} with the stdout guard in place. */
async function runGuardedEventStream(
  input: RunNonInteractivePromptInput,
  guard: JsonStdioGuard,
  turnContext: readonly HookContextEntry[],
): Promise<void> {
  const write = input.stdout ?? guard.write
  // Never call process.exit after writing the stream. On a slow pipe reader,
  // process.exit can drop the queued tail (measured: 1 MB and up, Bun 1.4.x).
  // So the default only sets the exit code, and the caller returns. The
  // process then ends by itself once stdout drains. An injected `exit` (tests)
  // keeps its old behavior.
  // The last code that `fail` set (for the end after a wrap-up).
  let exitCode = 0
  const fail = (code: number): void => {
    exitCode = code
    if (input.exit) input.exit(code)
    else process.exitCode = code
  }
  // Non-null: wantsEventStream() already verified openEventStreamSession is
  // present. It returns a promise (the real openAgentCoreSession awaits the
  // plugin prompt block), so await it before running.
  const openSession = input.openEventStreamSession as () => Promise<Session>

  // stream-json is the realtime surface: opt into token-level text_delta /
  // thinking_delta events. json stays buffered (no deltas) so its event stream
  // matches Phase 2 and the frozen SDK golden.
  const isStreamJson = input.outputFormat === "stream-json"
  // stream-json also keeps the closing run_finished line. json stays frozen.
  const keep = isStreamJson ? STREAM_JSON_EVENT_KIND_SET : LEGACY_EVENT_KIND_SET
  // --diagnostics: json lines become whole session log entries (S39).
  const entryLines = input.diagnostics === true && !isStreamJson
  // stream-json lines carry an envelope. The shared writer owns seq, which
  // counts the lines on this stdout from 0. It is not entry.seq, which counts
  // every logged entry. The json route does not use the writer.
  if (isStreamJson) setStreamJsonWrite(write)

  // The session_started line goes first, before the open, so a failed open
  // still leaves it on stdout. The open error then propagates as before, and
  // the host's main().catch writes the failure lines.
  if (isStreamJson && input.streamInfo !== undefined) {
    writeStreamJsonSessionStarted(input.streamInfo)
  }

  const session = await openSession()
  const startedAt = Date.now()
  const acc = createResultAccumulator()
  let runOk = true
  // open-responses: the OR writer is the only stdout writer (no event lines).
  const or = input.outputFormat === "open-responses" ? openOrWriter(input, session, write) : null
  if (or !== null) or.begin()

  // Only a sub-agent worker gets the SIGTERM wrap-up (headless-wrap-up.ts).
  let wrapUp: HeadlessWrapUp | undefined
  const out = {
    write,
    keep: or !== null ? EMPTY_KIND_SET : keep,
    entryLines: entryLines && or === null,
    isStreamJson,
    emitDeltas: isStreamJson || (or !== null && wantsOrStream(input)),
    acc,
    ...(or !== null ? { onEvent: (event: AgentEvent) => or.event(event) } : {}),
    isDryRunEnd: (err: unknown) => endsDryRun(input, err),
  }
  // A resumed session never continues an unfinished turn by itself: only
  // the REPL's `/continue` does. The prompt runs as a new turn.
  if (input.prompt.length > 0) {
    if (input.oneShotRunOptions !== undefined) {
      armOneShotRun(agentCoreOf(session), input.oneShotRunOptions)
    }
    if (input.outputSchema !== undefined) {
      armRunOutputSchema(session, input.outputSchema)
    }
    // A worker SIGTERM: one final short turn, then exit 143.
    if (wantsHeadlessWrapUp(input.wrapUp?.env ?? process.env)) {
      wrapUp = installHeadlessWrapUp(input.wrapUp)
    }
    try {
      const ok = await runEventStreamTurn(
        session,
        {
          text: input.prompt,
          additionalContext: turnContext,
          ...(wrapUp ? { signal: wrapUp.signal } : {}),
        },
        out,
      )
      if (!ok) {
        runOk = false
        fail(1)
      }
    } finally {
      wrapUp?.dispose()
    }
    // A SIGTERM after a completed run (before dispose) changes no exit code:
    // the run did its work. A wrap-up run ends `truncated` (or `aborted`).
    if (wrapUp?.started() === true && acc.outcome !== "completed") {
      runOk = false
      fail(SIGTERM_EXIT_CODE)
    }
  }
  // R11: one final `result` line after run_finished, then the exit code.
  // The schema check runs on a run that did not fail. A failed check
  // writes `outputError` on the line, the diagnostics to stderr, exit 1.
  const stderr = input.stderr ?? ((chunk: string) => void process.stderr.write(chunk))
  let schema: SchemaOutcome | undefined =
    runOk && input.outputSchema !== undefined
      ? checkResultOutput(resultText(acc), input.outputSchema)
      : undefined
  // R12 --schema-retries: a failed check on a completed turn runs one more
  // turn in the same session with a corrective user message. Each attempt
  // streams its own events (new turn numbers). `acc` sums the usage, and
  // its text is the text of the last attempt.
  // No retry turn after a SIGTERM (also a late one): the process must end.
  const maxRetries =
    runOk && wrapUp?.started() !== true ? (input.oneShotRunOptions?.schemaRetries ?? 0) : 0
  for (let used = 0; used < maxRetries; used++) {
    if (schema === undefined || schema.ok || acc.outcome !== "completed") break
    const outputSchema = input.outputSchema as object
    if (input.oneShotRunOptions !== undefined) {
      armOneShotRun(agentCoreOf(session), input.oneShotRunOptions)
    }
    armRunOutputSchema(session, outputSchema)
    const text = correctivePrompt(schema.reason)
    const ok = await runEventStreamTurn(session, { text }, out)
    if (!ok) {
      schema = undefined
      fail(1)
      break
    }
    schema = checkResultOutput(resultText(acc), outputSchema)
  }
  const line = buildResultLine(acc, {
    model: input.streamInfo?.model ?? null,
    provider: input.streamInfo?.provider ?? null,
    durationMs: Date.now() - startedAt,
    ...(schema !== undefined ? { schema } : {}),
  })
  if (or !== null) or.end({ acc, ...(schema !== undefined ? { schema } : {}) })
  else writeResultLine(line, { write, isStreamJson, sessionId: session.id })
  if (schema !== undefined && !schema.ok) {
    for (const d of schema.diagnostics) stderr(`${d}\n`)
    fail(1)
  }
  // A dropped stray write means some code tried to put a non-protocol line
  // on stdout. Fail the run so the bug cannot pass unseen.
  const strays = guard.strays()
  if (strays > 0) {
    stderr(`error: the JSON route dropped ${strays} stray stdout write(s)\n`)
    fail(1)
  }
  // After a SIGTERM, the process must end: a live handle cannot keep it.
  if (wrapUp?.started() === true) wrapUp.exitAfterRun(exitCode)
}

/** No event kind is kept as a line (the open-responses route). */
const EMPTY_KIND_SET: ReadonlySet<string> = new Set()

/** The OR writer for one run of the open-responses route. */
function openOrWriter(
  input: RunNonInteractivePromptInput,
  session: { readonly id: string },
  write: (chunk: string) => void,
): OrOutputWriter {
  if (input.outputSchema !== undefined && !canArmRunOutputSchema()) {
    const stderr = input.stderr ?? ((chunk: string) => void process.stderr.write(chunk))
    stderr(
      "[minimal-agent] warn: this core cannot send --output-schema to the model; the answer is only checked after the run\n",
    )
  }
  const run = input.oneShotRunOptions
  return new OrOutputWriter(
    {
      stream: wantsOrStream(input),
      buffered: input.outputSchema !== undefined,
      responseId: `resp_${session.id}`,
      model: input.streamInfo?.model ?? "unknown",
      ...(run?.temperature !== undefined ? { temperature: run.temperature } : {}),
      ...(input.outputSchema !== undefined ? { outputSchema: input.outputSchema } : {}),
      ...(run?.outputStrict === true ? { strict: true } : {}),
    },
    write,
  )
}

/**
 * Write a failed OR output for a failure outside the run (a blocked turn,
 * no session factory). stdout gets only OR output.
 */
function writeOrFailure(input: RunNonInteractivePromptInput, error: OrError): void {
  // The boot guard (if any) drops plain stdout writes, so use its writer.
  const write =
    input.stdout ?? activeGuard?.write ?? ((chunk: string) => void process.stdout.write(chunk))
  const or = openOrWriter(input, { id: input.streamInfo?.sessionId ?? getSessionId() }, write)
  or.begin()
  or.end({ acc: createResultAccumulator(), failure: error })
}

/**
 * Write the final `result` line. json: a plain JSONL line. stream-json: the
 * shared writer adds the envelope and the next `seq`. The writer takes an
 * event, and the result line is not an `AgentEvent` kind, so it is cast.
 * `serializeStreamJsonLine` changes only `item_started` records.
 */
function writeResultLine(
  line: ResultLine,
  out: { write: (chunk: string) => void; isStreamJson: boolean; sessionId: string },
): void {
  if (out.isStreamJson) {
    writeStreamJsonEvent(line as unknown as AgentEvent, {
      sessionId: out.sessionId,
      ts: Date.now(),
    })
  } else {
    out.write(`${JSON.stringify(line)}\n`)
  }
}

/**
 * Run one turn of the event-stream route and write its kept entries.
 * Returns false when the turn paused or failed (exit 1).
 */
async function runEventStreamTurn(
  session: Session,
  turn: {
    text: string
    additionalContext?: readonly HookContextEntry[]
    /** Aborts the run (the SIGTERM wrap-up signal). */
    signal?: AbortSignal
  },
  out: {
    write: (chunk: string) => void
    keep: ReadonlySet<string>
    entryLines: boolean
    isStreamJson: boolean
    /** Ask the core for live text deltas (stream-json, open-responses stream). */
    emitDeltas: boolean
    /** Collects the values of the final `result` line (all event kinds). */
    acc: ResultAccumulator
    /** Sees every event (the open-responses writer). */
    onEvent?: (event: AgentEvent) => void
    /** True for the expected send halt of a `--dry-run` run (not a failure). */
    isDryRunEnd?: (err: unknown) => boolean
  },
): Promise<boolean> {
  const { write, keep, entryLines, isStreamJson, acc } = out
  try {
    const run = session.run(turn.text, {
      emitDeltas: out.emitDeltas,
      ...(turn.signal !== undefined ? { signal: turn.signal } : {}),
      ...(turn.additionalContext !== undefined && turn.additionalContext.length > 0
        ? { additionalContext: [...turn.additionalContext] }
        : {}),
    })
    for await (const entry of run) {
      if (entry.ch === "event") {
        accumulateResultEvent(acc, entry.data)
        out.onEvent?.(entry.data)
      }
      // Text chunks are carried by the event stream (item_completed); the
      // raw yield channel is not written to stdout in structured mode. The
      // session's own log is the COMPLETE trace (every AgentEvent kind, by
      // design). THIS is the subscription boundary that filters it down to
      // the wire format of the route (LEGACY_EVENT_KINDS for json,
      // STREAM_JSON_EVENT_KINDS for stream-json). It does not change what
      // Session logs internally.
      if (entryLines && (entry.ch === "diag" || keep.has(entry.data.type))) {
        write(serializeEntry(entry))
      } else if (isStreamJson && entry.ch === "event" && entry.data.type === "retry-boundary") {
        // S14.4: the line stays a `text_delta` that carries the old marker text.
        writeStreamJsonEvent(
          { type: "text_delta", id: entry.data.id, text: retryBoundaryText(entry.data) },
          { sessionId: entry.sessionId, ts: entry.ts },
        )
      } else if (entry.ch === "event" && keep.has(entry.data.type)) {
        if (isStreamJson) {
          writeStreamJsonEvent(entry.data, { sessionId: entry.sessionId, ts: entry.ts })
        } else {
          write(serializeEvent(entry.data))
        }
      }
    }
    const result = await run.result
    // A paused run (permanent error) already emitted its `error` event.
    // Nobody can answer a one-shot run, so exit non-zero like a failure.
    return result.outcome !== "waiting"
  } catch (err) {
    // The core already surfaced the fatal error on the stream as an `error`
    // event (with code/hint). Keep stdout a clean JSONL document (no stack
    // trace), but exit non-zero so scripts see the failure. An abort is not
    // a failure of the run itself. A `--dry-run` send halt is the expected
    // end: the core error and run_finished lines stay, the exit code is 0.
    if (out.isDryRunEnd?.(err) === true) return true
    return !fatalErrorFields(err)
  }
}

/** Run a buffered retry turn to its end and return its text. */
async function drainRun(gen: ReturnType<ReplAgentLike["run"]>): Promise<string> {
  let text = ""
  while (true) {
    const { done, value } = await gen.next()
    if (done) return text
    text += value
  }
}

/** Write the stream-json failure lines for a `turn.willStart` halt. */
function writeTurnBlocked(input: RunNonInteractivePromptInput): void {
  if (input.stdout !== undefined) setStreamJsonWrite(input.stdout)
  const err = turnBlockedError()
  const info = input.streamInfo
  writeStreamJsonFailure(err, {
    // Never an empty id on the wire. Without streamInfo, use the CLI id.
    sessionId: info?.sessionId ?? getSessionId(),
    ...(info !== undefined ? { streamInfo: info } : {}),
  })
}

/**
 * Run one non-interactive prompt to completion and print its answer per the
 * selected output mode. Returns when the run is done; may call `exit(1)` on a
 * schema-validation failure.
 */
export async function runNonInteractivePrompt(input: RunNonInteractivePromptInput): Promise<void> {
  const { agent, formatterCmd, outputSchema, loader } = input
  const exit = input.exit ?? ((code: number): never => process.exit(code))

  // Parity with REPL: `turn.willStart` may rewrite or halt before the model.
  const turn =
    input.prompt.length > 0
      ? await applyTurnWillStart(loader, input.prompt, {
          agentMode: agent.getActiveMode?.()?.id ?? null,
        })
      : { text: "", halted: false, additionalContext: [] }
  if (turn.halted) {
    process.stderr.write(`${TURN_BLOCKED_MESSAGE}\n`)
    // stream-json still ends stdout with error and run_finished failed lines.
    if (input.outputFormat === "stream-json") writeTurnBlocked(input)
    if (input.outputFormat === "open-responses") {
      writeOrFailure(input, { code: "turn.blocked", message: TURN_BLOCKED_MESSAGE })
    }
    exit(1)
  }
  const prompt = turn.text
  // turn.willStart context, passed as the prompt run's additionalContext.
  const turnContext = turn.additionalContext

  // Structured event-stream route (`--output-format json` / `stream-json`).
  // Bypasses the formatter/plugin-stream/human-answer machinery entirely: the
  // JSONL event stream is the whole output.
  if (wantsEventStream(input)) {
    await runCoreEventStream({ ...input, prompt }, turnContext)
    return
  }
  // open-responses needs the event route. Without a session factory, write
  // a failed OR output (never human text on stdout).
  if (input.outputFormat === "open-responses") {
    const message = "--output-format open-responses needs the event-stream session"
    process.stderr.write(`${message}\n`)
    writeOrFailure(input, { code: "unsupported", message })
    exit(1)
    return
  }

  // Breathing room between the closed startup tree (stderr) and the streamed
  // response (stdout). Skipped when the header is suppressed (script-friendly).
  if (input.showHeader) process.stdout.write("\n")
  const formatter = formatterCmd ? new Formatter(formatterCmd, process.stdout) : null
  if (formatter) formatter.start()

  const stdoutIsTTY = process.stdout.isTTY === true
  // json / stream-json imply JSON output even when the `--json` boolean was
  // not passed, so `--output-format json` behaves as the documented `--json`
  // alias on the legacy path too (the full event stream is taken above via
  // wantsEventStream once a session factory is injected). `text` and an
  // absent outputFormat leave this exactly as `wantJsonOutput` dictates, so the
  // default text path stays byte-identical.
  const jsonFromFormat = input.outputFormat === "json" || input.outputFormat === "stream-json"
  const printOpts = resolvePrintModeOptions({
    jsonFlag: input.wantJsonOutput || jsonFromFormat,
    stdoutIsTTY,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
  })
  const printOut = new PrintOutput(printOpts, {
    stdout: process.stdout,
    stderr: process.stderr,
    stdoutIsTTY,
  })

  // Suppress live streaming when output is BUFFERED: json mode (events are the
  // only stdout) OR --output-schema (the answer must be validated before any
  // byte reaches stdout). Otherwise stream chunk-by-chunk (the live feel).
  const jsonMode = printOut.outputMode() === "json"
  const buffered = jsonMode || outputSchema !== undefined
  const baseSink = (s: string) => {
    if (buffered) return
    if (formatter) formatter.write(s)
    else process.stdout.write(s)
  }
  const pluginStream = loader ? new PluginStream(baseSink, loader, input.cwd) : null

  let finalText = ""
  try {
    const emit = async (value: string): Promise<void> => {
      if (pluginStream) {
        const p = pluginStream.feed(value)
        if (p) await p
      } else {
        baseSink(value)
      }
    }
    // A resumed session never continues an unfinished turn by itself: only
    // the REPL's `/continue` does. The prompt runs as a new turn.
    if (prompt.length > 0) {
      if (input.oneShotRunOptions !== undefined) {
        armOneShotRun(agentCoreOf(agent), input.oneShotRunOptions)
      }
      const gen = agent.run(
        prompt,
        turnContext.length > 0 ? { additionalContext: [...turnContext] } : undefined,
      )
      while (true) {
        const { done, value } = await gen.next()
        if (done) break
        finalText += value
        await emit(value)
      }
    }
    if (pluginStream) await pluginStream.end()
  } catch (err) {
    // `--dry-run`: the plugin halted the send on purpose. Exit 0, no `fatal:`.
    // The `finally` below still closes the formatter.
    if (!endsDryRun(input, err)) throw err
    return
  } finally {
    if (formatter) await formatter.end()
  }

  // --output-schema validate-and-exit: the final answer must be valid JSON
  // matching the schema, else a diagnostic to stderr + exit 1. Runs BEFORE any
  // stdout write so a failing run never leaks a non-conforming answer.
  if (outputSchema !== undefined) {
    let enforcement = enforceOutputSchema(finalText, outputSchema)
    // R12 --schema-retries: more turns in the same session with a corrective
    // user message. The schema run is buffered, so no attempt reaches stdout.
    // Only the answer of the last attempt is printed.
    const maxRetries = input.oneShotRunOptions?.schemaRetries ?? 0
    for (let used = 0; used < maxRetries && !enforcement.ok && prompt.length > 0; used++) {
      if (input.oneShotRunOptions !== undefined) {
        armOneShotRun(agentCoreOf(agent), input.oneShotRunOptions)
      }
      finalText = await drainRun(agent.run(correctivePrompt(enforcement.reason ?? "")))
      enforcement = enforceOutputSchema(finalText, outputSchema)
    }
    if (!enforcement.ok) {
      for (const line of enforcement.diagnostics) process.stderr.write(`${line}\n`)
      exit(1)
    }
  }

  if (jsonMode) {
    printOut.finish(finalText)
  } else if (outputSchema !== undefined) {
    process.stdout.write(finalText.endsWith("\n") ? finalText : `${finalText}\n`)
  } else {
    process.stdout.write("\n")
  }
}
