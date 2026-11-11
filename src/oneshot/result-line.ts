/**
 * The final `result` line of the `json` and `stream-json` routes
 * (SPEC-ONESHOT R11). Pure: no stdout, no clock, no process.
 *
 * The host feeds every event of the run to {@link accumulateResultEvent},
 * then calls {@link buildResultLine} once, after the last event line. The
 * line is additive: no existing event line changes.
 *
 * Keys in wire order: `type` ("result"), `text`, `output` (only with a
 * schema and a valid answer), `outputError` (only with a schema and a
 * failed check), `usage`, `stopReason`, `outcome`, `model`, `provider`,
 * `durationMs`. See {@link ResultLine}.
 *
 * There is no `cost` key. No event and no turn result carries a cost, so
 * the host cannot get one cheaply.
 *
 * @module oneshot/result-line
 */

import type { AgentEvent } from "@minimal-agent/core/sdk/events"
import { enforceOutputSchema } from "../print-output.ts"

/** Token usage summed over every `turn_completed` event of the run. */
export interface ResultUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  /** Set only when some turn reported it. */
  readonly cacheReadTokens?: number
  /** Set only when some turn reported it (core `cacheCreationTokens`). */
  readonly cacheWriteTokens?: number
}

/** The schema check failed. `message` holds the check diagnostics. */
export interface ResultOutputError {
  readonly message: string
}

/** The final `result` line body (no stream-json envelope). */
export interface ResultLine {
  readonly type: "result"
  /** The assistant text of the last model response. */
  readonly text: string
  /** The parsed answer, when a schema is set and the answer is valid. */
  readonly output?: unknown
  /** Set when a schema is set and the check failed. */
  readonly outputError?: ResultOutputError
  readonly usage: ResultUsage
  /** Stop reason of the last `turn_completed`, or null. */
  readonly stopReason: string | null
  /** The run outcome (`run_finished`), or `failed` when none was seen. */
  readonly outcome: string
  readonly model: string | null
  readonly provider: string | null
  readonly durationMs: number
}

/** What the host collects from the events of a run. */
export interface ResultAccumulator {
  /** The text items of the current (last) model response. */
  texts: string[]
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number | undefined
  cacheWriteTokens: number | undefined
  stopReason: string | null
  outcome: string | undefined
}

/** A new, empty {@link ResultAccumulator}. */
export function createResultAccumulator(): ResultAccumulator {
  return {
    texts: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    stopReason: null,
    outcome: undefined,
  }
}

/** Add an optional counter to an optional sum. Unset stays unset. */
function addOptional(sum: number | undefined, value: number | undefined): number | undefined {
  if (value === undefined) return sum
  return (sum ?? 0) + value
}

/**
 * Fold one event into `acc`. A `turn_started` starts a new model response,
 * so the text of an earlier response (for example the text before a tool
 * call) is dropped. Other kinds are ignored.
 */
export function accumulateResultEvent(acc: ResultAccumulator, event: AgentEvent): void {
  switch (event.type) {
    case "turn_started":
      acc.texts = []
      break
    case "item_completed":
      if (event.itemType === "text" && typeof event.text === "string") acc.texts.push(event.text)
      break
    case "turn_completed":
      acc.inputTokens += event.usage.inputTokens
      acc.outputTokens += event.usage.outputTokens
      acc.cacheReadTokens = addOptional(acc.cacheReadTokens, event.usage.cacheReadTokens)
      acc.cacheWriteTokens = addOptional(acc.cacheWriteTokens, event.usage.cacheCreationTokens)
      acc.stopReason = event.stopReason
      break
    case "run_finished":
      acc.outcome = event.outcome
      break
    default:
      break
  }
}

/** The final assistant text collected so far. */
export function resultText(acc: ResultAccumulator): string {
  return acc.texts.join("")
}

/** The schema part of the line: `output` when valid, else `outputError`. */
export type SchemaOutcome =
  | { readonly ok: true; readonly output: unknown; readonly diagnostics: readonly string[] }
  | {
      readonly ok: false
      readonly outputError: ResultOutputError
      readonly diagnostics: string[]
      /** The plugin-style reason, for a `--schema-retries` corrective prompt. */
      readonly reason: string
    }

/**
 * Check `text` against `schema` with the same rule as the text route
 * ({@link enforceOutputSchema}). `diagnostics` are the stderr lines.
 */
export function checkResultOutput(text: string, schema: object): SchemaOutcome {
  const enforcement = enforceOutputSchema(text, schema)
  if (!enforcement.ok) {
    const [head, ...errors] = enforcement.diagnostics
    const message = errors.length > 0 ? `${head}: ${errors.join("; ")}` : (head ?? "")
    return {
      ok: false,
      outputError: { message },
      diagnostics: enforcement.diagnostics,
      reason: enforcement.reason ?? message,
    }
  }
  return { ok: true, output: JSON.parse(text) as unknown, diagnostics: [] }
}

/** Inputs of {@link buildResultLine} that do not come from the events. */
export interface ResultLineContext {
  readonly model?: string | null
  readonly provider?: string | null
  readonly durationMs: number
  /** The schema check, when a schema is set and it ran. */
  readonly schema?: SchemaOutcome
}

/** Build the final `result` line body from `acc` and `ctx`. */
export function buildResultLine(acc: ResultAccumulator, ctx: ResultLineContext): ResultLine {
  const usage: ResultUsage = {
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    ...(acc.cacheReadTokens !== undefined ? { cacheReadTokens: acc.cacheReadTokens } : {}),
    ...(acc.cacheWriteTokens !== undefined ? { cacheWriteTokens: acc.cacheWriteTokens } : {}),
  }
  const schema = ctx.schema
  return {
    type: "result",
    text: resultText(acc),
    ...(schema?.ok === true ? { output: schema.output } : {}),
    ...(schema?.ok === false ? { outputError: schema.outputError } : {}),
    usage,
    stopReason: acc.stopReason,
    outcome: acc.outcome ?? "failed",
    model: ctx.model ?? null,
    provider: ctx.provider ?? null,
    durationMs: Math.max(0, Math.round(ctx.durationMs)),
  }
}
