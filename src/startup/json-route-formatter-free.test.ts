/**
 * S36 check: the `--output-format json` route calls no CLI formatter.
 *
 * The JSON route renders nothing for a person. It writes the event lines
 * only. This test drives a tool turn with a notice through the same session
 * the JSON route opens (`openAgentCoreSession` + `withHostPorts`, as in
 * `main.ts`), and counts calls to every CLI formatter: the tool transcript
 * rows, the turn-notice banner, and the markdown formatter. Each count must
 * be zero. A negative control runs the same turn on the interactive route
 * and proves the counters see the tool-row calls there.
 */

import { afterEach, describe, expect, it, type Mock, spyOn } from "bun:test"

import type { AuthResult } from "@minimal-agent/core/host/auth"
import { openAgentCoreSession } from "@minimal-agent/core/host-kit/build-agent-core"
import { InteractiveSession } from "../interactive-session.ts"
import type { ReplAgentLike } from "../repl.ts"
import type {
  TestSendOptions as SendOptions,
  TestStreamedResponse as StreamedResponse,
} from "../test-utils/transport-types.ts"
import { Formatter } from "../ui/formatter/formatter.ts"
import * as TOOL_FORMAT from "../ui/tool-transcript/format.ts"
import * as TURN_NOTICE from "../ui/turn-notice.ts"
import { withHostPorts } from "./host-ports.ts"
import {
  type RunNonInteractivePromptInput,
  runNonInteractivePrompt,
} from "./run-non-interactive.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

/** Spy on every function export of a module namespace. */
function spyAll(ns: Record<string, unknown>): Array<Mock<(...args: unknown[]) => unknown>> {
  const spies: Array<Mock<(...args: unknown[]) => unknown>> = []
  for (const [name, value] of Object.entries(ns)) {
    if (typeof value !== "function") continue
    spies.push(spyOn(ns, name as never) as unknown as Mock<(...args: unknown[]) => unknown>)
  }
  return spies
}

/** Round 1: a tool call. Round 2: a cut response (a notice). Round 3: text. */
function toolTurnSendFn(): (opts: SendOptions) => AsyncGenerator<string, StreamedResponse> {
  let round = 0
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse> {
    round++
    await opts.onBlockEdge?.({ block: "text", edge: "start" })
    if (round === 1) {
      yield "Let me look."
      await opts.onBlockEdge?.({ block: "text", edge: "stop" })
      return {
        blocks: [
          { type: "text", text: "Let me look." },
          { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "package.json" } },
        ],
        text: "Let me look.",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    if (round === 2) return { blocks: [], text: "", stopReason: "max_tokens" } as StreamedResponse
    yield "**Done.**"
    await opts.onBlockEdge?.({ block: "text", edge: "stop" })
    return {
      blocks: [{ type: "text", text: "**Done.**" }],
      text: "**Done.**",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

describe("--output-format json route", () => {
  const spies: Array<{ mockRestore(): void }> = []
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
  })

  it("calls no CLI formatter for a tool turn with a notice", async () => {
    const toolSpies = spyAll(TOOL_FORMAT as unknown as Record<string, unknown>)
    const noticeSpies = spyAll(TURN_NOTICE as unknown as Record<string, unknown>)
    const startSpy = spyOn(Formatter.prototype, "start")
    const writeSpy = spyOn(Formatter.prototype, "write")
    spies.push(...toolSpies, ...noticeSpies, startSpy, writeSpy)
    expect(toolSpies.length).toBeGreaterThan(10)

    const out: string[] = []
    const input: RunNonInteractivePromptInput = {
      agent: {
        run(): never {
          throw new Error("the JSON route must not run the interactive agent")
        },
      } as unknown as ReplAgentLike,
      prompt: "read package.json",
      // A formatter command is set. The JSON route must still not start it.
      formatterCmd: ["cat"],
      showHeader: false,
      wantJsonOutput: false,
      outputFormat: "json",
      outputSchema: undefined,
      loader: null,
      cwd: process.cwd(),
      stdout: (s) => out.push(s),
      exit: (() => {}) as unknown as (code: number) => never,
      openEventStreamSession: () =>
        openAgentCoreSession(
          withHostPorts({
            auth: AUTH,
            model: "test-model",
            sendFn: toolTurnSendFn(),
            loader: null,
            modeManager: null,
            store: null,
            blobStore: null,
            saveEcho: null,
            turnAttachments: [],
          }),
        ),
    }
    await runNonInteractivePrompt(input)

    const types = out
      .join("")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => (JSON.parse(l) as { type: string }).type)
    // The turn really ran a tool and raised a notice.
    expect(types).toContain("tool_result")
    expect(types).toContain("notice")

    const called = [...toolSpies, ...noticeSpies].filter((s) => s.mock.calls.length > 0)
    expect(called).toEqual([])
    expect(startSpy).not.toHaveBeenCalled()
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it("counts the tool-row calls of the interactive route (negative control)", async () => {
    const toolSpies = spyAll(TOOL_FORMAT as unknown as Record<string, unknown>)
    spies.push(...toolSpies)
    const session = await InteractiveSession.create({
      auth: AUTH,
      model: "test-model",
      sendFn: toolTurnSendFn(),
      loader: null,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    })
    const rows: string[] = []
    const gen = session.run("read package.json", { onTranscriptLine: (l) => rows.push(l) })
    while (!(await gen.next()).done) {
      // drain
    }
    expect(rows.length).toBeGreaterThan(0)
    expect(toolSpies.some((s) => s.mock.calls.length > 0)).toBe(true)
  })
})
