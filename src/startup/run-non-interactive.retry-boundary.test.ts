/**
 * S14.4 proofs for the retry boundary in the non-interactive router:
 * - print/text path (no `emitDeltas`): stdout and the final text hold no marker.
 * - stream-json: a `retry-boundary` event becomes ONE `text_delta` line that
 *   carries the old marker bytes, with the usual envelope.
 *
 * @module startup/run-non-interactive.retry-boundary.test
 */

import { beforeEach, describe, expect, it } from "bun:test"
import { createRuntime } from "@minimal-agent/core"
import type { AuthResult } from "@minimal-agent/core/host/auth"
import { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import type { ToolExecResult, ToolExecutor, ToolRegistry } from "@minimal-agent/core/sdk/ports"
import { retryBoundaryText } from "../logging/retry-boundary-text.ts"
import type { ReplAgentLike } from "../repl.ts"
import type { TestSendResult as StreamedResponse } from "../test-utils/transport-types.ts"
import { runNonInteractivePrompt } from "./run-non-interactive.ts"
import { resetStreamJsonWriterForTests } from "./stream-json-writer.ts"

beforeEach(() => resetStreamJsonWriterForTests())

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const REGISTRY: ToolRegistry = { list: () => [] }
const CLOCK = { now: () => 0, sleep: async () => {} }

class StubExecutor implements ToolExecutor {
  async execute(): Promise<ToolExecResult> {
    return { content: "", isError: false }
  }
}

/** The old marker bytes, written out here on purpose (a test-only copy). */
const OLD_MARKER = "\n↳ stream stalled — retrying (attempt 2)…\n"

/** Stall after "partial", then answer "done" on the second attempt. */
function stallThenRetry(): () => AsyncGenerator<string, StreamedResponse, undefined> {
  let calls = 0
  return async function* () {
    calls++
    if (calls === 1) {
      yield "partial"
      throw Object.assign(new Error("stall"), { errorClass: "transient" })
    }
    yield "done"
    return {
      blocks: [{ type: "text" as const, text: "done" }],
      text: "done",
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    } as StreamedResponse
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

describe("print mode: a stall then retry shows no marker (S14.4 accepted change a, b)", () => {
  it("stdout, the text of every chunk and the final text hold no marker", async () => {
    const core = new AgentCore({
      auth: AUTH,
      model: "test-model",
      systemPrompt: "",
      maxTokens: 4096,
      toolRegistry: REGISTRY,
      toolExecutor: new StubExecutor(),
      sendFn: stallThenRetry(),
      retry: { clock: CLOCK, random: () => 0 },
    })
    // The text route runs the agent with no emitDeltas (print mode).
    const agent = core as unknown as ReplAgentLike
    const captured = await captureStdout(() =>
      runNonInteractivePrompt({
        agent,
        prompt: "go",
        formatterCmd: undefined,
        showHeader: false,
        wantJsonOutput: false,
        outputSchema: undefined,
        loader: null,
        cwd: process.cwd(),
        outputFormat: "text",
      }),
    )
    expect(captured).not.toContain("stalled")
    expect(captured).not.toContain(OLD_MARKER)
    expect(captured).toContain("partialdone")
  })

  it("the agent text channel holds no marker (finalText input)", async () => {
    const core = new AgentCore({
      auth: AUTH,
      model: "test-model",
      systemPrompt: "",
      maxTokens: 4096,
      toolRegistry: REGISTRY,
      toolExecutor: new StubExecutor(),
      sendFn: stallThenRetry(),
      retry: { clock: CLOCK, random: () => 0 },
    })
    const gen = core.run("go")
    let text = ""
    while (true) {
      const r = await gen.next()
      if (r.done) break
      text += r.value
    }
    expect(text).toBe("partialdone")
    expect(text).not.toContain("stalled")
  })

  it("negative control: the old marker as a text chunk WOULD trip the assertion", () => {
    const oldBehavior = `partial${OLD_MARKER}done`
    expect(() => expect(oldBehavior).not.toContain("stalled")).toThrow()
    expect(() => expect(oldBehavior).not.toContain(OLD_MARKER)).toThrow()
  })
})

describe("stream-json: retry-boundary becomes one text_delta line with the old bytes", () => {
  it("writes {type,id,text} in that key order plus the envelope, seq advances by one", async () => {
    const out: string[] = []
    const session = createRuntime().openSession({
      auth: AUTH,
      model: "test-model",
      toolRegistry: REGISTRY,
      toolExecutor: new StubExecutor(),
      sendFn: stallThenRetry(),
      retry: { clock: CLOCK, random: () => 0 },
    })
    await runNonInteractivePrompt({
      agent: {
        run: () => {
          throw new Error("legacy path")
        },
      } as unknown as ReplAgentLike,
      prompt: "go",
      formatterCmd: undefined,
      showHeader: false,
      wantJsonOutput: false,
      outputSchema: undefined,
      loader: null,
      cwd: process.cwd(),
      outputFormat: "stream-json",
      openEventStreamSession: () => Promise.resolve(session),
      stdout: (s) => out.push(s),
      exit: (() => {}) as unknown as (code: number) => never,
    })
    const lines = out
      .join("")
      .split("\n")
      .filter((l) => l.length > 0)
    const idx = lines.findIndex((l) => l.includes("stream stalled"))
    expect(idx).toBeGreaterThan(0)
    const parsed = JSON.parse(lines[idx] as string) as Record<string, unknown>
    expect(parsed.type).toBe("text_delta")
    expect(parsed.text).toBe(retryBoundaryText({ attempt: 2 }))
    expect(parsed.text).toBe(OLD_MARKER)
    expect(parsed.id).toBe("1:text")
    expect(typeof parsed.sessionId).toBe("string")
    expect(typeof parsed.ts).toBe("number")
    const keys = Object.keys(parsed)
    expect(keys.indexOf("type")).toBeLessThan(keys.indexOf("id"))
    expect(keys.indexOf("id")).toBeLessThan(keys.indexOf("text"))
    // Exactly one such line. seq advances by one against both neighbours.
    expect(lines.filter((l) => l.includes("stream stalled")).length).toBe(1)
    const prev = JSON.parse(lines[idx - 1] as string) as { seq: number }
    const next = JSON.parse(lines[idx + 1] as string) as { seq: number }
    expect(parsed.seq).toBe(prev.seq + 1)
    expect(next.seq).toBe((parsed.seq as number) + 1)
  })
})
