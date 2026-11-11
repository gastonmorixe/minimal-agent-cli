/**
 * Tests for the final `result` line (SPEC-ONESHOT R11): the pure builder,
 * and the json / stream-json route with `--output-schema` (R10).
 *
 * @module oneshot/result-line.test
 */

import { beforeEach, describe, expect, it } from "bun:test"
import { createRuntime, type Session } from "@minimal-agent/core"
import type { AuthResult } from "@minimal-agent/core/host/auth"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"
import type {
  ToolDefinition,
  ToolExecResult,
  ToolExecutor,
  ToolRegistry,
} from "@minimal-agent/core/sdk/ports"
import type { ReplAgentLike } from "../repl.ts"
import {
  canArmRunOutputSchema,
  type RunNonInteractivePromptInput,
  runNonInteractivePrompt,
} from "../startup/run-non-interactive.ts"
import { resetStreamJsonWriterForTests } from "../startup/stream-json-writer.ts"
import type { TestSendResult as StreamedResponse } from "../test-utils/transport-types.ts"
import {
  accumulateResultEvent,
  buildResultLine,
  checkResultOutput,
  createResultAccumulator,
  resultText,
} from "./result-line.ts"

function fold(events: AgentEvent[]) {
  const acc = createResultAccumulator()
  for (const e of events) accumulateResultEvent(acc, e)
  return acc
}

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
}

describe("result line: accumulate", () => {
  it("sums usage over two turn_completed events and keeps the last stop reason", () => {
    const acc = fold([
      { type: "turn_started", turn: 1 },
      {
        type: "turn_completed",
        turn: 1,
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 },
      },
      { type: "turn_started", turn: 2 },
      { type: "item_completed", itemType: "text", id: "2:0", text: "done" },
      {
        type: "turn_completed",
        turn: 2,
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 7 },
      },
      { type: "run_finished", outcome: "completed" },
    ])
    const line = buildResultLine(acc, { model: "m", provider: "p", durationMs: 12.4 })
    expect(line).toEqual({
      type: "result",
      text: "done",
      usage: { inputTokens: 30, outputTokens: 5, cacheReadTokens: 5, cacheWriteTokens: 7 },
      stopReason: "end_turn",
      outcome: "completed",
      model: "m",
      provider: "p",
      durationMs: 12,
    })
  })

  it("leaves cache counters out when no turn reported them", () => {
    const acc = fold([
      {
        type: "turn_completed",
        turn: 1,
        stopReason: null,
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ])
    expect(buildResultLine(acc, { durationMs: 0 }).usage).toEqual({
      inputTokens: 1,
      outputTokens: 1,
    })
  })

  it("text is the last model response only (a new turn_started clears it)", () => {
    const acc = fold([
      { type: "turn_started", turn: 1 },
      { type: "item_completed", itemType: "text", id: "1:0", text: "thinking aloud" },
      { type: "item_completed", itemType: "tool_use", id: "c1", text: "Tool" },
      { type: "turn_started", turn: 2 },
      { type: "item_completed", itemType: "text", id: "2:0", text: "a" },
      { type: "item_completed", itemType: "thinking", id: "2:1", text: "hidden" },
      { type: "item_completed", itemType: "text", id: "2:2", text: "b" },
    ])
    expect(resultText(acc)).toBe("ab")
  })

  it("outcome defaults to failed and model/provider to null when unknown", () => {
    const line = buildResultLine(createResultAccumulator(), { durationMs: -3 })
    expect(line.outcome).toBe("failed")
    expect(line.model).toBeNull()
    expect(line.provider).toBeNull()
    expect(line.stopReason).toBeNull()
    expect(line.durationMs).toBe(0)
    expect("output" in line).toBe(false)
    expect("outputError" in line).toBe(false)
  })
})

describe("result line: schema output", () => {
  it("valid answer: output is the parsed JSON", () => {
    const schema = checkResultOutput('{"answer":"ok"}', SCHEMA)
    expect(schema.ok).toBe(true)
    const line = buildResultLine(createResultAccumulator(), { durationMs: 1, schema })
    expect(line.output).toEqual({ answer: "ok" })
    expect("outputError" in line).toBe(false)
  })

  it("invalid answer: outputError with a message, stderr diagnostics, no output", () => {
    const schema = checkResultOutput('{"nope":1}', SCHEMA)
    expect(schema.ok).toBe(false)
    expect(schema.diagnostics[0]).toBe("--output-schema: final answer does not match schema")
    const line = buildResultLine(createResultAccumulator(), { durationMs: 1, schema })
    expect("output" in line).toBe(false)
    expect(line.outputError?.message).toStartWith(
      "--output-schema: final answer does not match schema: ",
    )
  })

  it("non-JSON answer: outputError says it is not valid JSON", () => {
    const schema = checkResultOutput("hello", SCHEMA)
    expect(schema.ok).toBe(false)
    if (!schema.ok) expect(schema.outputError.message).toContain("not valid JSON")
  })

  it("key order: output and outputError sit between text and usage", () => {
    const ok = buildResultLine(createResultAccumulator(), {
      durationMs: 1,
      schema: checkResultOutput('{"answer":"x"}', SCHEMA),
    })
    expect(Object.keys(ok)).toEqual([
      "type",
      "text",
      "output",
      "usage",
      "stopReason",
      "outcome",
      "model",
      "provider",
      "durationMs",
    ])
  })
})

// ---------------------------------------------------------------------------
// Route tests: runNonInteractivePrompt with a real Session.
// ---------------------------------------------------------------------------

beforeEach(() => resetStreamJsonWriterForTests())

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

class StubExecutor implements ToolExecutor {
  async execute(): Promise<ToolExecResult> {
    return { content: "", isError: false }
  }
}

/** A real Session with one text turn `text`. */
function openSession(text: string, id?: string): Session {
  const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    yield text
    return {
      blocks: [{ type: "text" as const, text }],
      text,
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    } as StreamedResponse
  }
  const toolRegistry: ToolRegistry = { list: () => [] }
  return createRuntime().openSession({
    auth: AUTH,
    model: "test-model",
    toolRegistry,
    toolExecutor: new StubExecutor(),
    sendFn,
    ...(id !== undefined ? { id } : {}),
  })
}

/** A ReplAgentLike whose `run` throws: the legacy path must not run. */
function neverAgent(): ReplAgentLike {
  return {
    run(): never {
      throw new Error("legacy-path agent.run must not be called on the event-stream route")
    },
  } as unknown as ReplAgentLike
}

/** A ReplAgentLike that yields `chunks` once per run. */
function recordingAgent(chunks: string[]): { agent: ReplAgentLike } {
  const agent = {
    run(): AsyncGenerator<string, StreamedResponse, undefined> {
      return (async function* () {
        for (const c of chunks) yield c
        return {
          blocks: [{ type: "text" as const, text: chunks.join("") }],
          text: chunks.join(""),
          stopReason: "end_turn",
        } as StreamedResponse
      })()
    },
  } as unknown as ReplAgentLike
  return { agent }
}

/** Run `fn` with `process.stdout.write` captured. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const orig = process.stdout.write.bind(process.stdout)
  let buf = ""
  ;(process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
    buf += String(c)
    return true
  }
  try {
    await fn()
  } finally {
    ;(process.stdout as unknown as { write: typeof orig }).write = orig
  }
  return buf
}

function parseLines(out: readonly string[]): unknown[] {
  return out
    .join("")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

function baseInput(over: Partial<RunNonInteractivePromptInput>): RunNonInteractivePromptInput {
  return {
    agent: neverAgent(),
    prompt: "go",
    formatterCmd: undefined,
    showHeader: false,
    wantJsonOutput: false,
    outputSchema: undefined,
    loader: null,
    cwd: process.cwd(),
    ...over,
  }
}

describe("route: SPEC-ONESHOT R10/R11 schema + final result line", () => {
  const SCHEMA = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  }
  // R10 needs the D1 setter (local core). The pinned core keeps the legacy
  // buffered path (pinned by the test above), so these tests skip there.
  const r10 = canArmRunOutputSchema() ? it : it.skip

  /** Run one schema case and capture stdout lines, stderr, and exit codes. */
  async function runSchema(
    format: "json" | "stream-json",
    text: string,
    schema: object | null = SCHEMA,
  ): Promise<{ lines: Array<Record<string, unknown>>; stderr: string; exits: number[] }> {
    const out: string[] = []
    let stderr = ""
    const exits: number[] = []
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: format,
        outputSchema: schema ?? undefined,
        streamInfo: {
          sessionId: "sid-r11",
          model: "test-model",
          provider: "test-provider",
          cwd: "/w",
        },
        openEventStreamSession: () => Promise.resolve(openSession(text, "sid-r11")),
        stdout: (s) => out.push(s),
        stderr: (s) => {
          stderr += s
        },
        exit: ((code: number) => {
          exits.push(code)
        }) as (code: number) => never,
      }),
    )
    return { lines: parseLines(out) as Array<Record<string, unknown>>, stderr, exits }
  }

  r10("schema + json: keeps the event stream and ends with result + parsed output", async () => {
    const { lines, stderr, exits } = await runSchema("json", '{"answer":"ok"}')
    expect(lines.map((l) => l.type)).toEqual([
      "turn_started",
      "item_started",
      "item_completed",
      "turn_completed",
      "result",
    ])
    expect(lines.at(-1)).toEqual({
      type: "result",
      text: '{"answer":"ok"}',
      output: { answer: "ok" },
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
      outcome: "completed",
      model: "test-model",
      provider: "test-provider",
      durationMs: expect.any(Number),
    })
    expect(stderr).toBe("")
    expect(exits).toEqual([])
  })

  r10(
    "schema + stream-json: same, result is last with the envelope after run_finished",
    async () => {
      const { lines, exits } = await runSchema("stream-json", '{"answer":"ok"}')
      expect(lines.at(-2)?.type).toBe("run_finished")
      const last = lines.at(-1) as Record<string, unknown>
      expect(last).toMatchObject({ type: "result", output: { answer: "ok" }, outcome: "completed" })
      expect(last.sessionId).toBe("sid-r11")
      expect(typeof last.ts).toBe("number")
      expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i))
      expect(Object.keys(last).slice(-3)).toEqual(["sessionId", "seq", "ts"])
      expect(exits).toEqual([])
    },
  )

  r10(
    "schema + json, invalid answer: result has outputError, stderr diagnostics, exit 1",
    async () => {
      const { lines, stderr, exits } = await runSchema("json", '{"nope":1}')
      const last = lines.at(-1) as Record<string, unknown>
      expect(last.type).toBe("result")
      expect("output" in last).toBe(false)
      expect((last.outputError as { message: string }).message).toContain(
        "--output-schema: final answer does not match schema",
      )
      expect(stderr).toStartWith("--output-schema: final answer does not match schema\n")
      expect(exits).toEqual([1])
    },
  )

  r10("schema + stream-json, invalid answer: outputError on the last line, exit 1", async () => {
    const { lines, exits } = await runSchema("stream-json", "not json")
    expect(lines.at(-2)?.type).toBe("run_finished")
    expect(lines.at(-1)).toMatchObject({ type: "result", outputError: expect.any(Object) })
    expect(exits).toEqual([1])
  })

  it("no schema: the result line has no output and no outputError", async () => {
    const { lines, exits } = await runSchema("json", '{"answer":"ok"}', null)
    const last = lines.at(-1) as Record<string, unknown>
    expect(last.type).toBe("result")
    expect("output" in last).toBe(false)
    expect("outputError" in last).toBe(false)
    expect(exits).toEqual([])
  })

  it("usage is summed over the 2 turn_completed events of a tool round", async () => {
    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        return {
          blocks: [{ type: "tool_use" as const, id: "c1", name: "DoThing", input: {} }],
          text: "",
          stopReason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 2 },
        } as StreamedResponse
      }
      yield "done"
      return {
        blocks: [{ type: "text" as const, text: "done" }],
        text: "done",
        stopReason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 3 },
      } as StreamedResponse
    }
    const session = createRuntime().openSession({
      auth: AUTH,
      model: "test-model",
      toolRegistry: {
        list: (): ToolDefinition[] => [{ name: "DoThing", description: "d", input_schema: {} }],
      },
      toolExecutor: new StubExecutor(),
      sendFn,
    })
    const out: string[] = []
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "json",
        openEventStreamSession: () => Promise.resolve(session),
        stdout: (s) => out.push(s),
      }),
    )
    const lines = parseLines(out) as Array<Record<string, unknown>>
    expect(lines.filter((l) => l.type === "turn_completed").length).toBe(2)
    expect(lines.at(-1)).toMatchObject({
      type: "result",
      text: "done",
      usage: { inputTokens: 30, outputTokens: 5 },
      stopReason: "end_turn",
    })
  })

  it("text + schema: unchanged (factory never opened, answer on stdout, no result line)", async () => {
    let opened = 0
    const rec = recordingAgent(['{"answer":"ok"}'])
    const captured = await captureStdout(() =>
      runNonInteractivePrompt(
        baseInput({
          agent: rec.agent,
          outputFormat: "text",
          outputSchema: SCHEMA,
          openEventStreamSession: () => {
            opened++
            return Promise.resolve(openSession("x"))
          },
        }),
      ),
    )
    expect(opened).toBe(0)
    expect(captured).toBe('{"answer":"ok"}\n')
  })
})
