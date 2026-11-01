/**
 * Route tests for the CLI over core's public construction contract.
 *
 * Each CLI route must open its session through `createRuntime` /
 * `Session` (see `src/architecture/core-public-contract.ts`). Each test
 * here drives one route with the production CLI modules and one test
 * transport. Each test then checks two things:
 *   - the route calls `Session.prototype.run` exactly once, with the prompt;
 *   - the route gives the correct outcome on its own output channel.
 *
 * Routes:
 *   - REPL: `InteractiveSession.create` + `run` (the `ReplAgentLike` the REPL drives).
 *   - `--prompt` text: `runNonInteractivePrompt` over an `InteractiveSession`.
 *   - `--output-format json` and `stream-json`: `runNonInteractivePrompt`
 *     with `openAgentCoreSession(withHostPorts(...))`, the same factory `main.ts` injects.
 *   - `--host-mode`: `runHostMode` and its `HostRuntime.openSession`.
 *
 * @module routes.test
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { EventEmitter } from "node:events"
import { Session, type SessionEntry } from "@minimal-agent/core"
import type { AuthResult } from "@minimal-agent/core/host/auth"
import {
  type BuildAgentCoreDeps,
  createLifecyclePort,
  openAgentCoreSession,
} from "@minimal-agent/core/host-kit/build-agent-core"
import type { HostModeContext, HostModeHandler } from "@minimal-agent/core/host-kit/host-mode"
import type { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { LEGACY_EVENT_KINDS } from "@minimal-agent/core/sdk/events"

import { InteractiveSession } from "./interactive-session.ts"
import { withHostPorts } from "./startup/host-ports.ts"
import { runHostMode } from "./startup/run-host-mode.ts"
import {
  type RunNonInteractivePromptInput,
  runNonInteractivePrompt,
} from "./startup/run-non-interactive.ts"
import { resetStreamJsonWriterForTests } from "./startup/stream-json-writer.ts"
import type {
  TestSendOptions as SendOptions,
  TestStreamedResponse as StreamedResponse,
} from "./test-utils/transport-types.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const PROMPT = "ping from the route test"
const ANSWER = "pong"
const SESSION_ID = "routes-test-sid"

/** The user texts the test transport received, one entry per send. */
let sent: string[] = []
let runSpy: ReturnType<typeof spyOn<Session, "run">>

beforeEach(() => {
  sent = []
  resetStreamJsonWriterForTests()
  runSpy = spyOn(Session.prototype, "run")
})

afterEach(() => {
  runSpy.mockRestore()
})

/** The test transport: record the last user text, stream the answer, end the turn. */
async function* testTransport(
  opts: SendOptions,
): AsyncGenerator<string, StreamedResponse, undefined> {
  const content = opts.messages.at(-1)?.content
  if (typeof content === "string") sent.push(content)
  else if (Array.isArray(content)) {
    for (const block of content) if (block.type === "text") sent.push(block.text)
  }
  yield "po"
  yield "ng"
  return {
    blocks: [{ type: "text" as const, text: ANSWER }],
    text: ANSWER,
    stopReason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  } as StreamedResponse
}

/** Session deps with no plugins, no store, and the test transport. */
function sessionDeps(): BuildAgentCoreDeps {
  return {
    auth: AUTH,
    model: "routes-test-model",
    providerId: "routes-test-prov",
    sendFn: testTransport,
    loader: null,
    modeManager: null,
    store: null,
    blobStore: null,
    saveEcho: null,
    turnAttachments: [],
  }
}

/** The `main.ts` event-stream factory, with the test deps. */
function openEventStreamSession(): Promise<Session> {
  return openAgentCoreSession(withHostPorts({ ...sessionDeps(), sessionId: SESSION_ID }))
}

/** One-shot input with the fields every non-interactive route shares. */
function oneShotInput(
  overrides: Partial<RunNonInteractivePromptInput> &
    Pick<RunNonInteractivePromptInput, "agent" | "outputFormat">,
): RunNonInteractivePromptInput {
  return {
    prompt: PROMPT,
    formatterCmd: undefined,
    showHeader: false,
    wantJsonOutput: overrides.outputFormat !== "text",
    outputSchema: undefined,
    loader: null,
    cwd: process.cwd(),
    exit: (code: number): never => {
      throw new Error(`unexpected exit ${code}`)
    },
    ...overrides,
  }
}

/** Parse JSONL chunks into objects. */
function parseLines(chunks: readonly string[]): Array<Record<string, unknown>> {
  return chunks
    .join("")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** Capture `process.stdout.write` while `fn` runs. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout)
  let buffer = ""
  ;(process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => {
    buffer += String(chunk)
    return true
  }
  try {
    await fn()
  } finally {
    ;(process.stdout as unknown as { write: typeof original }).write = original
  }
  return buffer
}

/** Check that the route ran exactly one core `Session` turn with the prompt. */
function expectOneSessionRun(): void {
  expect(runSpy).toHaveBeenCalledTimes(1)
  expect(runSpy.mock.calls[0]?.[0]).toBe(PROMPT)
  expect(sent).toEqual([PROMPT])
}

/** A loader stub with one host mode `routes` and a pass-through `turn.willStart`. */
function hostModeLoader(handler: HostModeHandler): PluginLoader {
  const stub = {
    findHostMode: (id: string) =>
      id === "routes"
        ? {
            spec: { id: "routes", description: "routes", entry: { type: "module", path: "x.ts" } },
            pluginId: "p",
            packageDir: "/",
            entryAbsolute: "/x.ts",
            handler,
          }
        : undefined,
    hooks: () => ({
      emitChain: async (_channel: string, payload: { text: string }) => ({
        payload,
        halted: false,
      }),
    }),
  }
  return stub as unknown as PluginLoader
}

describe("CLI routes over createRuntime / Session", () => {
  const savedExitCode = process.exitCode
  afterEach(() => {
    process.exitCode = savedExitCode
  })

  it("REPL: InteractiveSession.run streams the answer and completes", async () => {
    const session = await InteractiveSession.create(sessionDeps())
    const run = session.run(PROMPT)
    let text = ""
    for (;;) {
      const next = await run.next()
      if (next.done) {
        expect(next.value.outcome).toBe("completed")
        break
      }
      text += next.value
    }
    expect(text).toBe(ANSWER)
    expectOneSessionRun()
    expect(session.history().map((m) => m.role)).toEqual(["user", "assistant"])
  })

  it("--prompt text: prints the answer on stdout", async () => {
    const agent = await InteractiveSession.create(sessionDeps())
    const out = await captureStdout(() =>
      runNonInteractivePrompt(oneShotInput({ agent, outputFormat: "text" })),
    )
    expect(out).toContain(ANSWER)
    expectOneSessionRun()
  })

  it("--output-format json: writes the legacy event kinds with the answer", async () => {
    const agent = await InteractiveSession.create(sessionDeps())
    const chunks: string[] = []
    await runNonInteractivePrompt(
      oneShotInput({
        agent,
        outputFormat: "json",
        openEventStreamSession,
        stdout: (chunk) => chunks.push(chunk),
      }),
    )
    const events = parseLines(chunks)
    expect(events.every((e) => LEGACY_EVENT_KINDS.includes(e.type as never))).toBeTrue()
    expect(events.at(0)?.type).toBe("turn_started")
    expect(events.at(-1)?.type).toBe("turn_completed")
    expect(events).toContainEqual(expect.objectContaining({ type: "item_completed", text: ANSWER }))
    expectOneSessionRun()
  })

  it("--output-format stream-json: session_started first, run_finished completed last", async () => {
    const agent = await InteractiveSession.create(sessionDeps())
    const chunks: string[] = []
    await runNonInteractivePrompt(
      oneShotInput({
        agent,
        outputFormat: "stream-json",
        openEventStreamSession,
        streamInfo: { sessionId: SESSION_ID, model: "routes-test-model", cwd: process.cwd() },
        stdout: (chunk) => chunks.push(chunk),
      }),
    )
    const events = parseLines(chunks)
    expect(events.at(0)?.type).toBe("session_started")
    expect(events.at(-1)).toMatchObject({ type: "run_finished", outcome: "completed" })
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i))
    expect(events.every((e) => e.sessionId === SESSION_ID)).toBeTrue()
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual(["po", "ng"])
    expect(events).toContainEqual(expect.objectContaining({ type: "item_completed", text: ANSWER }))
    expectOneSessionRun()
  })

  it("--host-mode: HostRuntime.openSession runs one turn and the process exits 0", async () => {
    const entries: SessionEntry[] = []
    const handler = async (ctx: HostModeContext): Promise<number> => {
      const session = await ctx.runtime.openSession()
      expect(session.sessionId).toBe(SESSION_ID)
      const run = session.run(PROMPT, { emitDeltas: true, signal: new AbortController().signal })
      for await (const entry of run) entries.push(entry)
      expect((await run.result).outcome).toBe("completed")
      await session.close()
      return 0
    }
    const stderr: string[] = []
    await runHostMode({
      hostModeId: "routes",
      hostModeArgv: [],
      promptSource: { kind: "none" },
      loader: hostModeLoader(handler),
      sessionDeps: sessionDeps(),
      sessionId: SESSION_ID,
      hostLifecycle: createLifecyclePort(null),
      stderr: { write: (s: string) => stderr.push(s) > 0 },
      // Never the real process: other test files listen for real signals.
      signalSource: new EventEmitter() as unknown as Pick<NodeJS.Process, "on" | "removeListener">,
    })
    expect(stderr).toEqual([])
    expect(process.exitCode).toBe(0)
    const events = entries.flatMap((e) => (e.ch === "event" ? [e.data] : []))
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual(["po", "ng"])
    expect(events).toContainEqual(expect.objectContaining({ type: "item_completed", text: ANSWER }))
    expect(events.at(-1)).toMatchObject({ type: "run_finished", outcome: "completed" })
    expect(entries.every((e) => e.sessionId === SESSION_ID)).toBeTrue()
    expectOneSessionRun()
  })
})
