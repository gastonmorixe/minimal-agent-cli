/**
 * `--output-format open-responses` (SPEC-ONESHOT R16): encode the events of
 * one run as Open Responses (OR) output. Pure: the caller gives the write
 * function and the clock. No stdout, no process.
 *
 * Framing (`research/spec-oneshot/R14-open-responses.md` section 3):
 *
 * - stream: SSE frames `event: <type>\ndata: <json>\n\n`. Every event has a
 *   `sequence_number`, from 0, plus 1 per event. No `data: [DONE]` line (the
 *   spec makes it optional).
 * - no stream: one `ResponseResource` JSON object and a newline, at the end.
 *
 * Event order for a run with text (stream):
 * `response.created`, `response.in_progress`, `response.output_item.added`
 * (message), `response.content_part.added`, `response.output_text.delta`
 * (1..n), `response.output_text.done`, `response.content_part.done`,
 * `response.output_item.done`, then one terminal event:
 * `response.completed`, `response.incomplete`, or `error` +
 * `response.failed`.
 *
 * Rules:
 *
 * - One assistant message item holds all assistant text of the run. Text
 *   blocks after the first are joined with a blank line. Tool calls,
 *   tool results, and thinking are hidden: the CLI runs its own tools, and
 *   a `function_call` item would tell the client to run a tool.
 * - Buffered mode (a schema run): no live deltas. At the end the message
 *   text is the final answer (the last model response of the last
 *   attempt), sent as one delta.
 * - Status: run outcome `completed` gives `completed`, unless the last stop
 *   reason is `max_tokens` (`incomplete`, reason `max_output_tokens`) or
 *   `content_filter` / `refusal` (`incomplete`, reason `content_filter`).
 *   Outcome `truncated` gives `incomplete` (`max_output_tokens` or
 *   `interrupted`). Any other outcome gives `failed` with `error` from the
 *   last core `error` event.
 * - A failed schema check (after all retries) keeps the status and the
 *   text. The check message goes in `metadata.output_error` (OR
 *   `MetadataParam`: string values, max 512 chars). The client validates
 *   the JSON itself. The host exits 1 after the output.
 * - Usage: core `inputTokens` excludes cache tokens, OR `input_tokens`
 *   includes them. So `input_tokens` = input + cache read + cache write.
 *   `cached_tokens` = cache read. `cache_write_tokens` (a vendor field the
 *   AI SDK reads) is set when the core reported cache writes.
 *
 * @module oneshot/or-output
 */

import type { AgentEvent } from "@minimal-agent/core/sdk/events"
import { errorEventText } from "../startup/core-text.ts"
import type { ResultAccumulator, SchemaOutcome } from "./result-line.ts"
import { resultText } from "./result-line.ts"

/** Max length of an OR metadata value (`MetadataParam`). */
const METADATA_VALUE_MAX = 512

/** Separator between two text blocks of one run. */
const BLOCK_SEPARATOR = "\n\n"

/** OR `Error`: `{code, message}`. */
export interface OrError {
  readonly code: string
  readonly message: string
}

/** OR `Usage`, plus the vendor field `cache_write_tokens`. */
export interface OrUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly total_tokens: number
  readonly input_tokens_details: {
    readonly cached_tokens: number
    readonly cache_write_tokens?: number
  }
  readonly output_tokens_details: { readonly reasoning_tokens: number }
}

/** OR `OutputTextContent`. */
export interface OrTextPart {
  readonly type: "output_text"
  readonly text: string
  readonly annotations: readonly unknown[]
  readonly logprobs: readonly unknown[]
}

/** OR `Message` output item (assistant). */
export interface OrMessageItem {
  readonly type: "message"
  readonly id: string
  readonly status: "in_progress" | "completed" | "incomplete"
  readonly role: "assistant"
  readonly content: readonly OrTextPart[]
}

/** OR `ResponseResource` (all 31 fields). */
export interface OrResponse {
  readonly id: string
  readonly object: "response"
  readonly created_at: number
  readonly completed_at: number | null
  readonly status: "in_progress" | "completed" | "incomplete" | "failed"
  readonly incomplete_details: { readonly reason: string } | null
  readonly model: string
  readonly previous_response_id: null
  readonly instructions: null
  readonly output: readonly OrMessageItem[]
  readonly error: OrError | null
  readonly tools: readonly unknown[]
  readonly tool_choice: "auto"
  readonly truncation: "disabled"
  readonly parallel_tool_calls: false
  readonly text: { readonly format: Record<string, unknown> }
  readonly top_p: number
  readonly presence_penalty: number
  readonly frequency_penalty: number
  readonly top_logprobs: number
  readonly temperature: number
  readonly reasoning: null
  readonly usage: OrUsage | null
  readonly max_output_tokens: null
  readonly max_tool_calls: null
  readonly store: false
  readonly background: false
  readonly service_tier: "default"
  readonly metadata: Record<string, string>
  readonly safety_identifier: null
  readonly prompt_cache_key: null
}

/** Options of one {@link OrOutputWriter}. */
export interface OrOutputOptions {
  /** SSE events (the request had `stream: true`), else one JSON object. */
  readonly stream: boolean
  /** Hold all text until {@link OrOutputWriter.end} (schema runs). */
  readonly buffered: boolean
  /** The response id, for example `resp_<session id>`. */
  readonly responseId: string
  /** The model id of the run. */
  readonly model: string
  /** Unix seconds now. Defaults to the system clock. */
  readonly nowSeconds?: () => number
  /** Echoed in the response object. Defaults to 1. */
  readonly temperature?: number
  /** Echoed in `text.format` as `json_schema`. */
  readonly outputSchema?: object
  /** Echoed as `text.format.strict`. */
  readonly strict?: boolean
}

/** What {@link OrOutputWriter.end} needs that the events do not carry. */
export interface OrFinal {
  /** The result accumulator of the run (usage, stop reason, outcome, text). */
  readonly acc: ResultAccumulator
  /** The schema check, when a schema is set and the run did not fail. */
  readonly schema?: SchemaOutcome
  /** A host failure that the events do not show (for example a blocked turn). */
  readonly failure?: OrError
}

/** Status fields of the response object. */
export interface OrStatus {
  readonly status: "completed" | "incomplete" | "failed"
  readonly incomplete_details: { readonly reason: string } | null
  readonly error: OrError | null
}

/** Map the run outcome and the last stop reason to the OR status fields. */
export function orStatus(
  outcome: string | undefined,
  stopReason: string | null,
  lastError: OrError | undefined,
): OrStatus {
  if (outcome === "completed") {
    if (stopReason === "max_tokens") return incomplete("max_output_tokens")
    if (stopReason === "content_filter" || stopReason === "refusal") {
      return incomplete("content_filter")
    }
    return { status: "completed", incomplete_details: null, error: null }
  }
  if (outcome === "truncated") {
    return incomplete(stopReason === "max_tokens" ? "max_output_tokens" : "interrupted")
  }
  const fallback: OrError =
    outcome === "aborted"
      ? { code: "aborted", message: "the run was aborted" }
      : outcome === "waiting"
        ? { code: "run_paused", message: "the run paused on an error and no one can answer it" }
        : { code: "run_failed", message: "the run failed" }
  return { status: "failed", incomplete_details: null, error: lastError ?? fallback }
}

function incomplete(reason: string): OrStatus {
  return { status: "incomplete", incomplete_details: { reason }, error: null }
}

/** Map the accumulated core usage to OR usage. */
export function orUsage(acc: ResultAccumulator): OrUsage {
  const cacheRead = acc.cacheReadTokens ?? 0
  const cacheWrite = acc.cacheWriteTokens ?? 0
  const input = acc.inputTokens + cacheRead + cacheWrite
  return {
    input_tokens: input,
    output_tokens: acc.outputTokens,
    total_tokens: input + acc.outputTokens,
    input_tokens_details: {
      cached_tokens: cacheRead,
      ...(acc.cacheWriteTokens !== undefined ? { cache_write_tokens: acc.cacheWriteTokens } : {}),
    },
    output_tokens_details: { reasoning_tokens: 0 },
  }
}

/** One SSE frame. The `event` line matches the JSON `type`. */
export function sseFrame(event: { readonly type: string } & Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

function textPart(text: string): OrTextPart {
  return { type: "output_text", text, annotations: [], logprobs: [] }
}

/**
 * Encodes the events of one run as OR output. Call {@link begin} once
 * after the session opens, {@link event} for every core event, and
 * {@link end} once after the last attempt.
 */
export class OrOutputWriter {
  private readonly opts: OrOutputOptions
  private readonly write: (chunk: string) => void
  private readonly now: () => number
  private readonly createdAt: number
  private readonly messageId: string
  private seq = 0
  /** All text of the run, as written (or to be written) in the message. */
  private text = ""
  /** The message item was opened on the stream. */
  private itemOpen = false
  /** The next text chunk starts a new text block. */
  private newBlock = true
  /** Text of the `item_completed` text items of the current turn. */
  private turnTexts: string[] = []
  /** A delta for the current turn was written. */
  private turnStreamed = false
  private lastError: OrError | undefined

  constructor(opts: OrOutputOptions, write: (chunk: string) => void) {
    this.opts = opts
    this.write = write
    this.now = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
    this.createdAt = this.now()
    this.messageId = `msg_${opts.responseId.replace(/^resp_/, "")}`
  }

  /** Stream: write `response.created` and `response.in_progress`. */
  begin(): void {
    if (!this.opts.stream) return
    const response = this.response({ status: "in_progress", output: [], usage: null })
    this.emit({ type: "response.created", response })
    this.emit({ type: "response.in_progress", response })
  }

  /** Fold one core event. Writes text deltas when streaming live. */
  event(event: AgentEvent): void {
    switch (event.type) {
      case "turn_started":
        this.turnTexts = []
        this.turnStreamed = false
        break
      case "block_started":
        if (event.itemType === "text") this.newBlock = true
        break
      case "text_delta":
        if (this.live()) {
          this.turnStreamed = true
          this.addText(event.text)
        }
        break
      case "item_completed":
        if (event.itemType === "text" && typeof event.text === "string") {
          this.turnTexts.push(event.text)
          // No stream: each text item is one block of the message.
          if (!this.opts.stream && !this.opts.buffered) {
            this.newBlock = true
            this.addText(event.text)
          }
        } else {
          // A tool call or thinking item ends the current text block.
          this.newBlock = true
        }
        break
      case "turn_completed":
        // A provider that sent no deltas: stream the turn text now.
        if (this.live() && !this.turnStreamed) {
          for (const t of this.turnTexts) {
            this.newBlock = true
            this.addText(t)
          }
        }
        this.newBlock = true
        break
      case "error":
        this.lastError = { code: event.code ?? "agent_error", message: errorEventText(event) }
        break
      default:
        break
    }
  }

  /** Write the end of the output. Returns the final response object. */
  end(final: OrFinal): OrResponse {
    const { acc } = final
    const status = final.failure
      ? { status: "failed" as const, incomplete_details: null, error: final.failure }
      : orStatus(acc.outcome, acc.stopReason, this.lastError)
    if (this.opts.buffered && status.status !== "failed") {
      this.newBlock = false
      this.addText(resultText(acc))
    }
    const hasMessage = status.status !== "failed" || this.text !== ""
    if (hasMessage && this.opts.stream && !this.itemOpen) this.openItem()
    const itemStatus = status.status === "completed" ? "completed" : "incomplete"
    const item: OrMessageItem = {
      type: "message",
      id: this.messageId,
      status: itemStatus,
      role: "assistant",
      content: [textPart(this.text)],
    }
    const metadata: Record<string, string> =
      final.schema !== undefined && !final.schema.ok
        ? { output_error: final.schema.outputError.message.slice(0, METADATA_VALUE_MAX) }
        : {}
    const response = this.response({
      ...status,
      output: hasMessage ? [item] : [],
      usage: orUsage(acc),
      metadata,
    })
    if (!this.opts.stream) {
      this.write(`${JSON.stringify(response)}\n`)
      return response
    }
    if (this.itemOpen) this.closeItem(item)
    if (status.status === "failed") {
      const err = status.error ?? { code: "run_failed", message: "the run failed" }
      this.emit({
        type: "error",
        error: { type: "server_error", code: err.code, message: err.message, param: null },
      })
      this.emit({ type: "response.failed", response })
    } else if (status.status === "incomplete") {
      this.emit({ type: "response.incomplete", response })
    } else {
      this.emit({ type: "response.completed", response })
    }
    return response
  }

  /** Live deltas: a stream that is not buffered. */
  private live(): boolean {
    return this.opts.stream && !this.opts.buffered
  }

  private addText(chunk: string): void {
    if (chunk === "") return
    const delta = this.newBlock && this.text !== "" ? `${BLOCK_SEPARATOR}${chunk}` : chunk
    this.newBlock = false
    this.text += delta
    if (!this.opts.stream) return
    if (!this.itemOpen) this.openItem()
    this.emit({
      type: "response.output_text.delta",
      item_id: this.messageId,
      output_index: 0,
      content_index: 0,
      delta,
      logprobs: [],
    })
  }

  private openItem(): void {
    this.itemOpen = true
    this.emit({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: this.messageId,
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    })
    this.emit({
      type: "response.content_part.added",
      item_id: this.messageId,
      output_index: 0,
      content_index: 0,
      part: textPart(""),
    })
  }

  private closeItem(item: OrMessageItem): void {
    const where = { item_id: this.messageId, output_index: 0, content_index: 0 }
    this.emit({ type: "response.output_text.done", ...where, text: this.text, logprobs: [] })
    this.emit({ type: "response.content_part.done", ...where, part: textPart(this.text) })
    this.emit({ type: "response.output_item.done", output_index: 0, item })
    this.itemOpen = false
  }

  private emit(event: { readonly type: string } & Record<string, unknown>): void {
    const { type, ...rest } = event
    this.write(sseFrame({ type, sequence_number: this.seq++, ...rest }))
  }

  private response(
    part: Pick<OrResponse, "status" | "output" | "usage"> &
      Partial<Pick<OrResponse, "incomplete_details" | "error" | "metadata">>,
  ): OrResponse {
    const schema = this.opts.outputSchema
    const format: Record<string, unknown> =
      schema !== undefined
        ? {
            type: "json_schema",
            name: schemaName(schema),
            schema,
            strict: this.opts.strict === true,
          }
        : { type: "text" }
    const done = part.status === "completed" || part.status === "incomplete"
    return {
      id: this.opts.responseId,
      object: "response",
      created_at: this.createdAt,
      completed_at: done ? this.now() : null,
      status: part.status,
      incomplete_details: part.incomplete_details ?? null,
      model: this.opts.model,
      previous_response_id: null,
      instructions: null,
      output: part.output,
      error: part.error ?? null,
      tools: [],
      tool_choice: "auto",
      truncation: "disabled",
      parallel_tool_calls: false,
      text: { format },
      top_p: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_logprobs: 0,
      temperature: this.opts.temperature ?? 1,
      reasoning: null,
      usage: part.usage,
      max_output_tokens: null,
      max_tool_calls: null,
      store: false,
      background: false,
      service_tier: "default",
      metadata: part.metadata ?? {},
      safety_identifier: null,
      prompt_cache_key: null,
    }
  }
}

/** The schema `title` when it is a non-empty string, else `response` (AI SDK default). */
function schemaName(schema: object): string {
  const title = (schema as { title?: unknown }).title
  return typeof title === "string" && title !== "" ? title : "response"
}
