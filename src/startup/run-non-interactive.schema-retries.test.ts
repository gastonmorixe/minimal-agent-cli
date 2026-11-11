/**
 * `--schema-retries <n>` (SPEC-ONESHOT R12) on both one-shot routes.
 *
 * - Event route (json / stream-json, needs the D1 setter of the local
 *   core): each attempt streams its own events, usage is summed over all
 *   attempts, and the final `result` line reflects the last attempt.
 * - Buffered route (text, and json on the pinned core): only the answer of
 *   the last attempt is printed.
 *
 * Exit 1 only after the last attempt fails. Retries 0 is today's behavior.
 *
 * @module host/startup/run-non-interactive.schema-retries.test
 */

import { beforeEach, describe, expect, it } from "bun:test"
import type { Session } from "@minimal-agent/core"
import { createRuntime } from "@minimal-agent/core"
import type { AuthResult } from "@minimal-agent/core/host/auth"
import type { ToolExecResult, ToolExecutor, ToolRegistry } from "@minimal-agent/core/sdk/ports"
import type { ReplAgentLike } from "../repl.ts"
import type { TestSendResult as StreamedResponse } from "../test-utils/transport-types.ts"

import {
  canArmRunOutputSchema,
  type RunNonInteractivePromptInput,
  runNonInteractivePrompt,
} from "./run-non-interactive.ts"
import { resetStreamJsonWriterForTests } from "./stream-json-writer.ts"

beforeEach(() => resetStreamJsonWriterForTests())

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
}
const GOOD = '{"answer":"ok"}'
const CORRECTIVE = "Your previous reply was rejected: "

class StubExecutor implements ToolExecutor {
  async execute(): Promise<ToolExecResult> {
    return { content: "", isError: false }
  }
}

/** A real Session whose model gives `answers` in order (last one repeats). */
function openSession(answers: string[], prompts: string[]): Session {
  let call = 0
  const sendFn = async function* (
    req?: unknown,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    prompts.push(lastUserText(req))
    const text = answers[Math.min(call, answers.length - 1)] as string
    call++
    yield text
    return {
      blocks: [{ type: "text" as const, text }],
      text,
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2 },
    } as StreamedResponse
  }
  const toolRegistry: ToolRegistry = { list: () => [] }
  return createRuntime().openSession({
    auth: AUTH,
    model: "test-model",
    toolRegistry,
    toolExecutor: new StubExecutor(),
    sendFn,
    id: "sid-retry",
  })
}

/** The text of the last user message in a send request, else "". */
function lastUserText(req: unknown): string {
  const messages = (req as { messages?: unknown } | undefined)?.messages
  if (!Array.isArray(messages)) return ""
  const user = [...messages].reverse().find((m) => (m as { role?: string }).role === "user") as
    | { content?: unknown }
    | undefined
  const content = user?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((b) => (b as { text?: string }).text ?? "").join("")
  }
  return ""
}

/** A legacy agent that answers with `answers` in order and records each prompt. */
function sequenceAgent(answers: string[]): { agent: ReplAgentLike; prompts: string[] } {
  const prompts: string[] = []
  const agent = {
    run(prompt: string): AsyncGenerator<string, StreamedResponse, undefined> {
      const text = answers[Math.min(prompts.length, answers.length - 1)] as string
      prompts.push(prompt)
      return (async function* () {
        yield text
        return {
          blocks: [{ type: "text" as const, text }],
          text,
          stopReason: "end_turn",
        } as StreamedResponse
      })()
    },
  } as unknown as ReplAgentLike
  return { agent, prompts }
}

function neverAgent(): ReplAgentLike {
  return {
    run(): never {
      throw new Error("legacy agent.run must not be called on the event route")
    },
  } as unknown as ReplAgentLike
}

function baseInput(over: Partial<RunNonInteractivePromptInput>): RunNonInteractivePromptInput {
  return {
    agent: neverAgent(),
    prompt: "go",
    formatterCmd: undefined,
    showHeader: false,
    wantJsonOutput: false,
    outputSchema: SCHEMA,
    loader: null,
    cwd: process.cwd(),
    ...over,
  }
}

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

async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const orig = process.stderr.write.bind(process.stderr)
  let buf = ""
  ;(process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
    buf += String(c)
    return true
  }
  try {
    await fn()
  } finally {
    ;(process.stderr as unknown as { write: typeof orig }).write = orig
  }
  return buf
}

function parseLines(out: readonly string[]): Array<Record<string, unknown>> {
  return out
    .join("")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe("--schema-retries: event route (json / stream-json)", () => {
  const r10 = canArmRunOutputSchema() ? it : it.skip

  async function runEvent(
    format: "json" | "stream-json",
    answers: string[],
    retries: number,
  ): Promise<{
    lines: Array<Record<string, unknown>>
    prompts: string[]
    stderr: string
    exits: number[]
  }> {
    const out: string[] = []
    const prompts: string[] = []
    const exits: number[] = []
    let stderr = ""
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: format,
        oneShotRunOptions: retries > 0 ? { schemaRetries: retries } : {},
        openEventStreamSession: () => Promise.resolve(openSession(answers, prompts)),
        stdout: (s) => out.push(s),
        stderr: (s) => {
          stderr += s
        },
        exit: ((code: number) => {
          exits.push(code)
        }) as (code: number) => never,
      }),
    )
    return { lines: parseLines(out), prompts, stderr, exits }
  }

  r10("retry then success: result has output, usage summed, exit 0", async () => {
    const { lines, prompts, stderr, exits } = await runEvent("json", ["not json", GOOD], 2)
    expect(prompts.length).toBe(2)
    expect(prompts[1]).toStartWith(`${CORRECTIVE}the reply is not valid JSON`)
    // Both attempts stream: two turn_started / turn_completed pairs.
    expect(lines.filter((l) => l.type === "turn_started").length).toBe(2)
    expect(lines.filter((l) => l.type === "turn_completed").length).toBe(2)
    const last = lines.at(-1) as Record<string, unknown>
    expect(last).toMatchObject({
      type: "result",
      text: GOOD,
      output: { answer: "ok" },
      usage: { inputTokens: 20, outputTokens: 4 },
      outcome: "completed",
    })
    expect("outputError" in last).toBe(false)
    expect(stderr).toBe("")
    expect(exits).toEqual([])
  })

  r10("stream-json: each attempt is one run (turn 1 again, own run_finished)", async () => {
    const { lines, exits } = await runEvent("stream-json", ['{"nope":1}', GOOD], 1)
    // Core counts `turn` per run, so every attempt starts at turn 1 and
    // ends with its own run_finished line.
    const turns = lines.filter((l) => l.type === "turn_started").map((l) => l.turn)
    expect(turns).toEqual([1, 1])
    expect(lines.filter((l) => l.type === "run_finished").length).toBe(2)
    expect(lines.at(-1)).toMatchObject({ type: "result", output: { answer: "ok" } })
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i))
    expect(exits).toEqual([])
  })

  r10("retries exhausted: outputError on the last line, exit 1 once", async () => {
    const { lines, prompts, stderr, exits } = await runEvent("json", ["nope"], 2)
    expect(prompts.length).toBe(3)
    const last = lines.at(-1) as Record<string, unknown>
    expect(last.type).toBe("result")
    expect("output" in last).toBe(false)
    expect((last.outputError as { message: string }).message).toContain("not valid JSON")
    expect(last.usage).toEqual({ inputTokens: 30, outputTokens: 6 })
    expect(stderr).toStartWith("--output-schema: final answer does not match schema\n")
    expect(exits).toEqual([1])
  })

  r10("retries 0: one attempt, today's behavior", async () => {
    const { lines, prompts, exits } = await runEvent("json", ["nope", GOOD], 0)
    expect(prompts.length).toBe(1)
    expect(lines.filter((l) => l.type === "turn_started").length).toBe(1)
    expect(lines.at(-1)).toMatchObject({ type: "result", outputError: expect.any(Object) })
    expect(exits).toEqual([1])
  })
})

describe("--schema-retries: buffered route (text)", () => {
  async function runText(
    answers: string[],
    retries: number,
  ): Promise<{ stdout: string; stderr: string; prompts: string[]; exits: number[] }> {
    const seq = sequenceAgent(answers)
    const exits: number[] = []
    let stdout = ""
    const stderr = await captureStderr(async () => {
      stdout = await captureStdout(async () => {
        try {
          await runNonInteractivePrompt(
            baseInput({
              agent: seq.agent,
              outputFormat: "text",
              oneShotRunOptions: retries > 0 ? { schemaRetries: retries } : {},
              exit: ((code: number) => {
                exits.push(code)
                throw new Error(`exit ${code}`)
              }) as (code: number) => never,
            }),
          )
        } catch (err) {
          if (!(err instanceof Error && err.message.startsWith("exit "))) throw err
        }
      })
    })
    return { stdout, stderr, prompts: seq.prompts, exits }
  }

  it("retry then success: only the final answer is printed, exit 0", async () => {
    const r = await runText(["not json", GOOD], 3)
    expect(r.prompts.length).toBe(2)
    expect(r.prompts[1]).toStartWith(`${CORRECTIVE}the reply is not valid JSON`)
    expect(r.stdout).toBe(`${GOOD}\n`)
    expect(r.stderr).toBe("")
    expect(r.exits).toEqual([])
  })

  it("retries exhausted: diagnostics on stderr, nothing on stdout, exit 1", async () => {
    const r = await runText(['{"nope":1}'], 1)
    expect(r.prompts.length).toBe(2)
    expect(r.prompts[1]).toBe(
      `${CORRECTIVE}the reply does not match the schema: $: missing required property "answer". Reply again with only one JSON value that matches the required JSON Schema. No other text, no code fence.`,
    )
    expect(r.stdout).toBe("")
    expect(r.stderr).toBe(
      '--output-schema: final answer does not match schema\n$: missing required property "answer"\n',
    )
    expect(r.exits).toEqual([1])
  })

  it("retries 0: one attempt, today's behavior", async () => {
    const r = await runText(["nope", GOOD], 0)
    expect(r.prompts.length).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.exits).toEqual([1])
  })

  it("a valid first answer: no retry", async () => {
    const r = await runText([GOOD], 2)
    expect(r.prompts.length).toBe(1)
    expect(r.stdout).toBe(`${GOOD}\n`)
    expect(r.exits).toEqual([])
  })
})
