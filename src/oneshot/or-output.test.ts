/**
 * Tests for the Open Responses output encoder (SPEC-ONESHOT R16).
 *
 * @module oneshot/or-output.test
 */

import { describe, expect, it } from "bun:test"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"
import { type OrOutputOptions, OrOutputWriter, orStatus, orUsage } from "./or-output.ts"
import {
  accumulateResultEvent,
  checkResultOutput,
  createResultAccumulator,
  type ResultAccumulator,
  resultText,
} from "./result-line.ts"

const BASE: OrOutputOptions = {
  stream: true,
  buffered: false,
  responseId: "resp_sid1",
  model: "test-model",
  nowSeconds: () => 1000,
}

/** A run: turn 1 has text, a tool call, more text. Turn 2 has the answer. */
function toolRunEvents(withDeltas: boolean): AgentEvent[] {
  const d = (text: string): AgentEvent[] =>
    withDeltas ? [{ type: "text_delta", id: "x:text", text }] : []
  return [
    { type: "turn_started", turn: 1 },
    ...(withDeltas
      ? [{ type: "block_started", itemType: "text", id: "1:text" } as AgentEvent]
      : []),
    ...d("Let me "),
    ...d("look."),
    { type: "item_started", itemType: "text", id: "t0" },
    { type: "item_completed", itemType: "text", id: "t0", text: "Let me look." },
    { type: "item_started", itemType: "tool_use", id: "call_1", toolName: "Read", input: {} },
    { type: "item_completed", itemType: "tool_use", id: "call_1", text: "Read" },
    {
      type: "turn_completed",
      turn: 1,
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4 },
    },
    { type: "tool_call", callId: "call_1", toolName: "Read", input: {}, inputSummary: "x" },
    { type: "tool_result", id: "call_1", name: "Read", isError: false },
    { type: "turn_started", turn: 2 },
    ...(withDeltas
      ? [{ type: "block_started", itemType: "text", id: "2:text" } as AgentEvent]
      : []),
    ...d("Done."),
    { type: "item_started", itemType: "text", id: "t1" },
    { type: "item_completed", itemType: "text", id: "t1", text: "Done." },
    {
      type: "turn_completed",
      turn: 2,
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 2, cacheCreationTokens: 6 },
    },
    { type: "run_finished", outcome: "completed" },
  ]
}

interface Frame {
  readonly event: string
  readonly data: Record<string, unknown>
}

function parseSse(out: string): Frame[] {
  return out
    .split("\n\n")
    .filter((b) => b.length > 0)
    .map((block) => {
      const [ev, data] = block.split("\n")
      expect(ev).toStartWith("event: ")
      expect(data).toStartWith("data: ")
      return {
        event: (ev as string).slice(7),
        data: JSON.parse((data as string).slice(6)) as Record<string, unknown>,
      }
    })
}

function run(
  opts: Partial<OrOutputOptions>,
  events: AgentEvent[],
  extra: (acc: ResultAccumulator) => Parameters<OrOutputWriter["end"]>[0] = (acc) => ({ acc }),
): { out: string; acc: ResultAccumulator } {
  let out = ""
  const w = new OrOutputWriter({ ...BASE, ...opts }, (c) => {
    out += c
  })
  const acc = createResultAccumulator()
  w.begin()
  for (const e of events) {
    accumulateResultEvent(acc, e)
    w.event(e)
  }
  w.end(extra(acc))
  return { out, acc }
}

describe("stream: event order and sequence numbers", () => {
  it("writes the full spec event set in order, seq from 0", () => {
    const { out } = run({}, toolRunEvents(true))
    const frames = parseSse(out)
    for (const f of frames) expect(f.data.type).toBe(f.event)
    expect(frames.map((f) => f.data.sequence_number)).toEqual(frames.map((_, i) => i))
    expect(frames.map((f) => f.event)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ])
    const deltas = frames.filter((f) => f.event === "response.output_text.delta")
    expect(deltas.map((f) => f.data.delta)).toEqual(["Let me ", "look.", "\n\nDone."])
    for (const f of deltas) expect(f.data.item_id).toBe("msg_sid1")
    const added = frames[2]?.data.item as Record<string, unknown>
    expect(added).toEqual({
      type: "message",
      id: "msg_sid1",
      status: "in_progress",
      role: "assistant",
      content: [],
    })
    const done = frames[9]?.data.item as Record<string, unknown>
    expect(done.status).toBe("completed")
    expect(done.content).toEqual([
      { type: "output_text", text: "Let me look.\n\nDone.", annotations: [], logprobs: [] },
    ])
    const completed = frames[10]?.data.response as Record<string, unknown>
    expect(completed.status).toBe("completed")
    expect(completed.incomplete_details).toBeNull()
    expect(completed.output).toEqual([done])
  })

  it("hides tool calls: no function_call item anywhere", () => {
    const { out } = run({}, toolRunEvents(true))
    expect(out).not.toContain("function_call")
    expect(out).not.toContain("call_1")
  })

  it("a provider with no deltas: the turn text is streamed at turn_completed", () => {
    const { out } = run({}, toolRunEvents(false))
    const deltas = parseSse(out).filter((f) => f.event === "response.output_text.delta")
    expect(deltas.map((f) => f.data.delta)).toEqual(["Let me look.", "\n\nDone."])
  })

  it("failure: error then response.failed, with error on the response", () => {
    const events: AgentEvent[] = [
      { type: "turn_started", turn: 1 },
      { type: "error", message: "model exploded", code: "boom" },
      { type: "run_finished", outcome: "failed" },
    ]
    const frames = parseSse(run({}, events).out)
    expect(frames.map((f) => f.event)).toEqual([
      "response.created",
      "response.in_progress",
      "error",
      "response.failed",
    ])
    expect(frames[2]?.data.error).toEqual({
      type: "server_error",
      code: "boom",
      message: "model exploded",
      param: null,
    })
    const resp = frames[3]?.data.response as Record<string, unknown>
    expect(resp.status).toBe("failed")
    expect(resp.error).toEqual({ code: "boom", message: "model exploded" })
    expect(resp.output).toEqual([])
  })

  it("max_tokens: response.incomplete with reason max_output_tokens", () => {
    const events: AgentEvent[] = [
      { type: "turn_started", turn: 1 },
      { type: "text_delta", id: "1:text", text: "partial" },
      {
        type: "turn_completed",
        turn: 1,
        stopReason: "max_tokens",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      { type: "run_finished", outcome: "truncated" },
    ]
    const frames = parseSse(run({}, events).out)
    const last = frames.at(-1) as Frame
    expect(last.event).toBe("response.incomplete")
    const resp = last.data.response as Record<string, unknown>
    expect(resp.incomplete_details).toEqual({ reason: "max_output_tokens" })
    const itemDone = frames.at(-2) as Frame
    expect((itemDone.data.item as Record<string, unknown>).status).toBe("incomplete")
  })
})

describe("no stream: one response object", () => {
  it("writes exactly one JSON line with all 31 fields", () => {
    const { out } = run({ stream: false }, toolRunEvents(false))
    const lines = out.split("\n").filter((l) => l.length > 0)
    expect(lines.length).toBe(1)
    const resp = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(Object.keys(resp).length).toBe(31)
    expect(resp).toMatchObject({
      id: "resp_sid1",
      object: "response",
      created_at: 1000,
      completed_at: 1000,
      status: "completed",
      incomplete_details: null,
      model: "test-model",
      error: null,
      text: { format: { type: "text" } },
      metadata: {},
    })
    expect(resp.output).toEqual([
      {
        type: "message",
        id: "msg_sid1",
        status: "completed",
        role: "assistant",
        content: [
          { type: "output_text", text: "Let me look.\n\nDone.", annotations: [], logprobs: [] },
        ],
      },
    ])
    expect(out).not.toContain("function_call")
  })

  it("failure: status failed, error set, output empty", () => {
    const events: AgentEvent[] = [
      { type: "error", message: "nope", code: "auth" },
      { type: "run_finished", outcome: "failed" },
    ]
    const resp = JSON.parse(run({ stream: false }, events).out) as Record<string, unknown>
    expect(resp.status).toBe("failed")
    expect(resp.error).toEqual({ code: "auth", message: "nope" })
    expect(resp.output).toEqual([])
  })

  it("a host failure: status failed with the given error", () => {
    const { out } = run({ stream: false }, [], (acc) => ({
      acc,
      failure: { code: "turn.blocked", message: "blocked" },
    }))
    const resp = JSON.parse(out) as Record<string, unknown>
    expect(resp.status).toBe("failed")
    expect(resp.error).toEqual({ code: "turn.blocked", message: "blocked" })
  })
})

describe("usage mapping", () => {
  it("input_tokens includes cache read and cache write, details split out", () => {
    const { acc } = run({ stream: false }, toolRunEvents(false))
    expect(orUsage(acc)).toEqual({
      input_tokens: 25,
      output_tokens: 5,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 4, cache_write_tokens: 6 },
      output_tokens_details: { reasoning_tokens: 0 },
    })
  })

  it("no cache counters: cached_tokens 0, no cache_write_tokens key", () => {
    const acc = createResultAccumulator()
    acc.inputTokens = 7
    acc.outputTokens = 2
    expect(orUsage(acc)).toEqual({
      input_tokens: 7,
      output_tokens: 2,
      total_tokens: 9,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    })
  })
})

describe("orStatus", () => {
  it("maps outcomes and stop reasons", () => {
    expect(orStatus("completed", "end_turn", undefined).status).toBe("completed")
    expect(orStatus("completed", "content_filter", undefined).incomplete_details).toEqual({
      reason: "content_filter",
    })
    expect(orStatus("truncated", "end_turn", undefined).incomplete_details).toEqual({
      reason: "interrupted",
    })
    expect(orStatus("aborted", null, undefined).error?.code).toBe("aborted")
    expect(orStatus("waiting", null, { code: "x", message: "y" }).error).toEqual({
      code: "x",
      message: "y",
    })
    expect(orStatus(undefined, null, undefined).status).toBe("failed")
  })
})

describe("schema run (buffered)", () => {
  const SCHEMA = {
    title: "weather",
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  }
  const answer = (text: string): AgentEvent[] => [
    { type: "turn_started", turn: 1 },
    { type: "text_delta", id: "1:text", text: text.slice(0, 3) },
    { type: "text_delta", id: "1:text", text: text.slice(3) },
    { type: "item_completed", itemType: "text", id: "t0", text },
    {
      type: "turn_completed",
      turn: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    { type: "run_finished", outcome: "completed" },
  ]

  it("valid answer: the JSON text in one delta at the end, text.format echoed", () => {
    const text = '{"city":"Madrid"}'
    const { out } = run(
      { buffered: true, outputSchema: SCHEMA, strict: true },
      answer(text),
      (acc) => ({
        acc,
        schema: checkResultOutput(resultText(acc), SCHEMA),
      }),
    )
    const frames = parseSse(out)
    const deltas = frames.filter((f) => f.event === "response.output_text.delta")
    expect(deltas.map((f) => f.data.delta)).toEqual([text])
    const resp = frames.at(-1)?.data.response as Record<string, unknown>
    expect(frames.at(-1)?.event).toBe("response.completed")
    expect(resp.text).toEqual({
      format: { type: "json_schema", name: "weather", schema: SCHEMA, strict: true },
    })
    expect(resp.metadata).toEqual({})
  })

  it("failed check: status completed, text kept, metadata.output_error set", () => {
    const text = '{"town":"x"}'
    const { out } = run(
      { stream: false, buffered: true, outputSchema: SCHEMA },
      answer(text),
      (acc) => ({
        acc,
        schema: checkResultOutput(resultText(acc), SCHEMA),
      }),
    )
    const resp = JSON.parse(out) as Record<string, unknown>
    expect(resp.status).toBe("completed")
    const output = resp.output as Array<{ content: Array<{ text: string }> }>
    expect(output[0]?.content[0]?.text).toBe(text)
    const meta = resp.metadata as Record<string, string>
    expect(meta.output_error).toContain('missing required property "city"')
    expect((meta.output_error as string).length).toBeLessThanOrEqual(512)
  })
})
