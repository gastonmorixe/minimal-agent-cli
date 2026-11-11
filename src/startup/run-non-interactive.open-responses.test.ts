/**
 * `--output-format open-responses` (SPEC-ONESHOT R16) on the event route,
 * with a real `Session` and a scripted model. stdout must carry only Open
 * Responses output: SSE frames (`orStream`) or one `response` object.
 *
 * @module host/startup/run-non-interactive.open-responses.test
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

class StubExecutor implements ToolExecutor {
  async execute(): Promise<ToolExecResult> {
    return { content: "", isError: false }
  }
}

/** A real Session whose model gives `answers` in order (last one repeats). */
function openSession(answers: string[]): Session {
  let call = 0
  const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
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
    id: "sid-or",
  })
}

function neverAgent(): ReplAgentLike {
  return {
    run(): never {
      throw new Error("legacy agent.run must not be called on the event route")
    },
  } as unknown as ReplAgentLike
}

async function runOr(
  over: Partial<RunNonInteractivePromptInput>,
  answers: string[],
): Promise<{ out: string; stderr: string; exits: number[] }> {
  let out = ""
  let stderr = ""
  const exits: number[] = []
  await runNonInteractivePrompt({
    agent: neverAgent(),
    prompt: "go",
    formatterCmd: undefined,
    showHeader: false,
    wantJsonOutput: false,
    outputSchema: undefined,
    loader: null,
    cwd: process.cwd(),
    outputFormat: "open-responses",
    openEventStreamSession: () => Promise.resolve(openSession(answers)),
    stdout: (s) => {
      out += s
    },
    stderr: (s) => {
      stderr += s
    },
    exit: ((code: number) => {
      exits.push(code)
    }) as (code: number) => never,
    ...over,
  })
  return { out, stderr, exits }
}

function frames(out: string): Array<Record<string, unknown>> {
  return out
    .split("\n\n")
    .filter((b) => b.length > 0)
    .map((b) => {
      const lines = b.split("\n")
      expect(lines.length).toBe(2)
      const data = JSON.parse((lines[1] as string).slice(6)) as Record<string, unknown>
      expect(lines[0]).toBe(`event: ${data.type as string}`)
      return data
    })
}

describe("open-responses route", () => {
  it("no stream: stdout is exactly one response object", async () => {
    const { out, exits } = await runOr({}, ["Hello there."])
    const lines = out.split("\n").filter((l) => l.length > 0)
    expect(lines.length).toBe(1)
    const resp = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(resp).toMatchObject({ object: "response", id: "resp_sid-or", status: "completed" })
    const output = resp.output as Array<{ content: Array<{ text: string }> }>
    expect(output[0]?.content[0]?.text).toBe("Hello there.")
    expect(resp.usage).toMatchObject({ input_tokens: 10, output_tokens: 2, total_tokens: 12 })
    expect(out).not.toContain('"type":"result"')
    expect(exits).toEqual([])
  })

  it("stream: SSE frames only, live delta, terminal response.completed", async () => {
    const { out, exits } = await runOr({ orStream: true }, ["Hi."])
    const fs = frames(out)
    expect(fs.map((f) => f.sequence_number)).toEqual(fs.map((_, i) => i))
    const types = fs.map((f) => f.type)
    expect(types[0]).toBe("response.created")
    expect(types).toContain("response.output_item.added")
    expect(types.at(-1)).toBe("response.completed")
    const text = fs
      .filter((f) => f.type === "response.output_text.delta")
      .map((f) => f.delta)
      .join("")
    expect(text).toBe("Hi.")
    expect(exits).toEqual([])
  })

  it("stream via oneShotRunOptions.orStream (the entry-point path): SSE frames", async () => {
    const { out, exits } = await runOr({ oneShotRunOptions: { orStream: true } }, ["Hi."])
    const types = frames(out).map((f) => f.type)
    expect(types[0]).toBe("response.created")
    expect(types).toContain("response.output_text.delta")
    expect(types.at(-1)).toBe("response.completed")
    expect(exits).toEqual([])
  })

  const r10 = canArmRunOutputSchema() ? it : it.skip
  r10("schema run, failed check: output written, metadata.output_error, exit 1", async () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] }
    const { out, stderr, exits } = await runOr({ outputSchema: schema }, ['{"b":1}'])
    const resp = JSON.parse(out) as Record<string, unknown>
    expect(resp.status).toBe("completed")
    expect((resp.metadata as Record<string, string>).output_error).toContain("missing required")
    expect(stderr).toStartWith("--output-schema: final answer does not match schema\n")
    expect(exits).toEqual([1])
  })

  it("turn blocked: a failed OR output, exit 1", async () => {
    let out = ""
    const exits: number[] = []
    const loader = {
      hooks: () => ({ emitChain: async () => ({ halted: true, payload: { text: "go" } }) }),
    }
    const origErr = process.stderr.write.bind(process.stderr)
    ;(process.stderr as unknown as { write: () => boolean }).write = () => true
    try {
      await runNonInteractivePrompt({
        agent: neverAgent(),
        prompt: "go",
        formatterCmd: undefined,
        showHeader: false,
        wantJsonOutput: false,
        outputSchema: undefined,
        loader: loader as unknown as RunNonInteractivePromptInput["loader"],
        cwd: process.cwd(),
        outputFormat: "open-responses",
        stdout: (s) => {
          out += s
        },
        exit: ((code: number) => {
          exits.push(code)
          throw new Error("exit")
        }) as (code: number) => never,
      }).catch(() => undefined)
    } finally {
      ;(process.stderr as unknown as { write: typeof origErr }).write = origErr
    }
    expect(exits).toEqual([1])
    const resp = JSON.parse(out) as Record<string, unknown>
    expect(resp.status).toBe("failed")
    expect((resp.error as { code: string }).code).toBe("turn.blocked")
  })
})
