/**
 * The SIGTERM wrap-up of the headless event-stream route.
 *
 * - The first SIGTERM starts the wrap-up once: the core runs ONE final turn
 *   with the wrap-up note, and the run exits 143 with `run_finished`
 *   `truncated` on stdout.
 * - A second SIGTERM (after the repeat window), or the grace time, forces
 *   exit 143.
 *
 * A fake signal source and a fake exit: no test sends a real signal.
 *
 * @module startup/headless-wrap-up.test
 */

import { beforeEach, describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import type { Session } from "@minimal-agent/core"
import { createRuntime } from "@minimal-agent/core"
import type { AuthResult } from "@minimal-agent/core/host/auth"
import type { ToolExecResult, ToolRegistry } from "@minimal-agent/core/sdk/ports"
import type { ReplAgentLike } from "../repl.ts"
import type { TestSendResult as StreamedResponse } from "../test-utils/transport-types.ts"

import {
  ENV_WRAP_UP_TOOLS,
  installHeadlessWrapUp,
  REPEAT_IGNORE_MS,
  SIGTERM_EXIT_CODE,
  WRAP_UP_DEADLINE_MARGIN_MS,
  WRAP_UP_GRACE_MS,
  WRAP_UP_NOTE,
  wantsHeadlessWrapUp,
  wrapUpNote,
  wrapUpReason,
} from "./headless-wrap-up.ts"
import { runNonInteractivePrompt } from "./run-non-interactive.ts"
import { resetStreamJsonWriterForTests } from "./stream-json-writer.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const TOOLS: ToolRegistry = {
  list: () => [
    { name: "Bash", description: "d", input_schema: {} },
    { name: "Report", description: "d", input_schema: {} },
  ],
}

type Source = EventEmitter & Pick<NodeJS.Process, "on" | "removeListener">

function fakeSource(): Source {
  return new EventEmitter() as Source
}

beforeEach(() => resetStreamJsonWriterForTests())

describe("installHeadlessWrapUp", () => {
  it("the first SIGTERM aborts with the wrap-up reason once; a second one exits 143", () => {
    const source = fakeSource()
    const exits: number[] = []
    const notes: string[] = []
    let t = 1000
    const prevCode = process.exitCode
    const w = installHeadlessWrapUp({
      signalSource: source,
      exitProcess: (code) => exits.push(code),
      stderr: (s) => notes.push(s),
      env: { [ENV_WRAP_UP_TOOLS]: "Report, Other" },
      now: () => t,
    })
    try {
      expect(w.started()).toBe(false)
      source.emit("SIGTERM")
      expect(w.started()).toBe(true)
      // Two tools: the generic note. The final turn ends 3 s before the forced end.
      expect(w.signal.reason).toMatchObject({
        kind: "wrap_up",
        text: WRAP_UP_NOTE,
        tools: ["Report", "Other"],
        deadlineAt: 1000 + WRAP_UP_GRACE_MS - WRAP_UP_DEADLINE_MARGIN_MS,
      })
      expect(exits).toEqual([])
      // A repeat at once (a supervisor double-send) is ignored.
      source.emit("SIGTERM")
      expect(exits).toEqual([])
      t += REPEAT_IGNORE_MS
      source.emit("SIGTERM")
      expect(exits).toEqual([SIGTERM_EXIT_CODE])
      source.emit("SIGTERM")
      expect(exits).toEqual([SIGTERM_EXIT_CODE])
      expect(notes.length).toBe(2)
    } finally {
      w.dispose()
      process.exitCode = prevCode
    }
    expect(source.listenerCount("SIGTERM")).toBe(0)
  })

  it("the grace time ends the process with 143", async () => {
    const source = fakeSource()
    const exits: number[] = []
    const prevCode = process.exitCode
    const w = installHeadlessWrapUp({
      signalSource: source,
      exitProcess: (code) => exits.push(code),
      stderr: () => {},
      graceMs: 10,
    })
    try {
      source.emit("SIGTERM")
      await new Promise((r) => setTimeout(r, 40))
      expect(exits).toEqual([SIGTERM_EXIT_CODE])
    } finally {
      w.dispose()
      process.exitCode = prevCode
    }
  })

  it("no tool list without the env var", () => {
    const r = wrapUpReason({})
    expect(r).toMatchObject({ kind: "wrap_up", text: WRAP_UP_NOTE })
    expect("tools" in r).toBe(false)
    expect("deadlineAt" in r).toBe(false)
  })

  it("MIN-3: the reason is an AbortError, so throwIfAborted throws an Error", () => {
    const ac = new AbortController()
    ac.abort(wrapUpReason({ [ENV_WRAP_UP_TOOLS]: "Report" }, 7))
    let thrown: unknown
    try {
      ac.signal.throwIfAborted()
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).name).toBe("AbortError")
    expect((thrown as Error).message).toBe("wrap_up")
    expect(thrown).toMatchObject({ kind: "wrap_up", tools: ["Report"], deadlineAt: 7 })
  })

  it("R3: only a worker (a non-empty wrap-up tools env) wants the wrap-up", () => {
    expect(wantsHeadlessWrapUp({})).toBe(false)
    expect(wantsHeadlessWrapUp({ [ENV_WRAP_UP_TOOLS]: "" })).toBe(false)
    expect(wantsHeadlessWrapUp({ [ENV_WRAP_UP_TOOLS]: " , " })).toBe(false)
    expect(wantsHeadlessWrapUp({ [ENV_WRAP_UP_TOOLS]: "Report" })).toBe(true)
  })

  it("MAJ-1: exitAfterRun ends the process after the wait, once", async () => {
    const source = fakeSource()
    const exits: number[] = []
    const w = installHeadlessWrapUp({
      signalSource: source,
      exitProcess: (code) => exits.push(code),
      stderr: () => {},
      afterRunExitMs: 10,
    })
    source.emit("SIGTERM")
    w.dispose()
    w.exitAfterRun(SIGTERM_EXIT_CODE)
    expect(exits).toEqual([])
    await new Promise((r) => setTimeout(r, 40))
    expect(exits).toEqual([SIGTERM_EXIT_CODE])
  })

  it("the note names the tool only when the env names exactly one tool", () => {
    const one = wrapUpReason({ [ENV_WRAP_UP_TOOLS]: " SubAgentsReportResult " }, 5)
    expect(one).toMatchObject({
      kind: "wrap_up",
      text: wrapUpNote(["SubAgentsReportResult"]),
      tools: ["SubAgentsReportResult"],
      deadlineAt: 5,
    })
    expect(one.text).toContain("Call the SubAgentsReportResult tool now")
    expect(WRAP_UP_NOTE).not.toContain("ReportResult")
    expect(wrapUpNote(["A", "B"])).toBe(WRAP_UP_NOTE)
    expect(wrapUpNote([])).toBe(WRAP_UP_NOTE)
  })
})

describe("runNonInteractivePrompt stream-json: SIGTERM wrap-up", () => {
  it("runs one final turn, writes run_finished truncated, and exits 143", async () => {
    const source = fakeSource()
    const sends: Array<{ tools: string[]; last: string }> = []
    const executed: string[] = []
    const sendFn = async function* (opts: {
      tools?: Array<{ name: string }>
      messages: Array<{ content: unknown }>
      signal?: AbortSignal
    }): AsyncGenerator<string, StreamedResponse, undefined> {
      sends.push({
        tools: (opts.tools ?? []).map((t) => t.name),
        last: JSON.stringify(opts.messages[opts.messages.length - 1]?.content),
      })
      if (sends.length === 1) {
        // A stalled request: SIGTERM arrives, the wrap-up aborts it.
        setTimeout(() => source.emit("SIGTERM"), 5)
        await new Promise<never>((_r, reject) => {
          opts.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          )
        })
      }
      yield ""
      return {
        blocks: [{ type: "tool_use" as const, id: "r1", name: "Report", input: {} }],
        text: "",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    const session: Session = createRuntime().openSession({
      auth: AUTH,
      model: "test-model",
      toolRegistry: TOOLS,
      toolExecutor: {
        execute: async (tool): Promise<ToolExecResult> => {
          executed.push(tool.name)
          return { content: "ok", isError: false }
        },
      },
      sendFn: sendFn as never,
      id: "sid-wrap",
    })
    const out: string[] = []
    const exits: number[] = []
    const forced: number[] = []
    await runNonInteractivePrompt({
      agent: {} as unknown as ReplAgentLike,
      prompt: "go",
      formatterCmd: undefined,
      showHeader: false,
      wantJsonOutput: false,
      outputSchema: undefined,
      loader: null,
      cwd: process.cwd(),
      outputFormat: "stream-json",
      openEventStreamSession: async () => session,
      stdout: (s) => out.push(s),
      stderr: () => {},
      exit: ((code: number) => {
        exits.push(code)
      }) as unknown as (code: number) => never,
      wrapUp: {
        signalSource: source,
        exitProcess: (code) => forced.push(code),
        stderr: () => {},
        env: { [ENV_WRAP_UP_TOOLS]: "Report" },
      },
    })

    expect(sends.length).toBe(2)
    expect(sends[1]?.tools).toEqual(["Report"])
    expect(sends[1]?.last).toContain(wrapUpNote(["Report"]))
    expect(executed).toEqual(["Report"])
    expect(exits).toEqual([SIGTERM_EXIT_CODE])
    expect(forced).toEqual([])
    expect(source.listenerCount("SIGTERM")).toBe(0)
    const lines = out
      .join("")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const finished = lines.filter((l) => l.type === "run_finished")
    expect(finished.map((l) => l.outcome)).toEqual(["truncated"])
    expect(lines.some((l) => l.type === "error")).toBe(false)
    expect(lines.filter((l) => l.type === "turn_started").length).toBe(2)
  })

  it("MIN-1: a SIGTERM before the round request exists ends as aborted, exit 143", async () => {
    const source = fakeSource()
    let sends = 0
    const session: Session = createRuntime().openSession({
      auth: AUTH,
      model: "test-model",
      toolRegistry: TOOLS,
      toolExecutor: { execute: async () => ({ content: "ok", isError: false }) },
      // SIGTERM while the first user message is built (before any request).
      mediaResolver: {
        resolveUserContent: async () => {
          source.emit("SIGTERM")
          throw Object.assign(new Error("aborted"), { name: "AbortError" })
        },
      },
      sendFn: async function* () {
        sends++
        yield ""
        return { blocks: [], text: "", stopReason: "end_turn" } as StreamedResponse
      } as never,
      id: "sid-wrap-early",
    })
    const out: string[] = []
    const exits: number[] = []
    const forced: number[] = []
    await runNonInteractivePrompt({
      agent: {} as unknown as ReplAgentLike,
      prompt: "go",
      formatterCmd: undefined,
      showHeader: false,
      wantJsonOutput: false,
      outputSchema: undefined,
      loader: null,
      cwd: process.cwd(),
      outputFormat: "stream-json",
      openEventStreamSession: async () => session,
      stdout: (s) => out.push(s),
      stderr: () => {},
      exit: ((code: number) => {
        exits.push(code)
      }) as unknown as (code: number) => never,
      wrapUp: {
        signalSource: source,
        exitProcess: (code) => forced.push(code),
        stderr: () => {},
        env: { [ENV_WRAP_UP_TOOLS]: "Report" },
      },
    })
    expect(sends).toBe(0)
    expect(exits).toEqual([SIGTERM_EXIT_CODE])
    expect(forced).toEqual([])
    const lines = out
      .join("")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.filter((l) => l.type === "run_finished").map((l) => l.outcome)).toEqual([
      "aborted",
    ])
  })

  /** One stream-json run with a fake source. `onSend`/`onLine` can emit SIGTERM. */
  async function runOnce(opts: {
    env: Record<string, string>
    onSend?: (source: Source, signal: AbortSignal | undefined) => Promise<void>
    onLine?: (source: Source, line: string) => void
  }) {
    const source = fakeSource()
    let sends = 0
    let listenersDuringSend = -1
    const session: Session = createRuntime().openSession({
      auth: AUTH,
      model: "test-model",
      toolRegistry: TOOLS,
      toolExecutor: { execute: async () => ({ content: "ok", isError: false }) },
      sendFn: async function* (o: { signal?: AbortSignal }) {
        sends++
        listenersDuringSend = source.listenerCount("SIGTERM")
        await opts.onSend?.(source, o.signal)
        yield ""
        return { blocks: [], text: "done", stopReason: "end_turn" } as StreamedResponse
      } as never,
      id: "sid-wrap-gate",
    })
    const out: string[] = []
    const exits: number[] = []
    const forced: number[] = []
    await runNonInteractivePrompt({
      agent: {} as unknown as ReplAgentLike,
      prompt: "go",
      formatterCmd: undefined,
      showHeader: false,
      wantJsonOutput: false,
      outputSchema: undefined,
      loader: null,
      cwd: process.cwd(),
      outputFormat: "stream-json",
      openEventStreamSession: async () => session,
      stdout: (s) => {
        out.push(s)
        opts.onLine?.(source, s)
      },
      stderr: () => {},
      exit: ((code: number) => {
        exits.push(code)
      }) as unknown as (code: number) => never,
      wrapUp: {
        signalSource: source,
        exitProcess: (code) => forced.push(code),
        stderr: () => {},
        env: opts.env,
        afterRunExitMs: 10,
      },
    })
    const lines = out
      .join("")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    return { source, sends: () => sends, listenersDuringSend, exits, forced, lines }
  }

  it("R3: without the wrap-up tools env (not a worker), no SIGTERM listener is installed", async () => {
    const r = await runOnce({ env: {} })
    expect(r.listenersDuringSend).toBe(0)
    expect(r.sends()).toBe(1)
    expect(r.exits).toEqual([])
    expect(r.lines.filter((l) => l.type === "run_finished").map((l) => l.outcome)).toEqual([
      "completed",
    ])
  })

  it("R3: with the env (a worker), the listener is there during the run, and gone after", async () => {
    const r = await runOnce({ env: { [ENV_WRAP_UP_TOOLS]: "Report" } })
    expect(r.listenersDuringSend).toBe(1)
    expect(r.source.listenerCount("SIGTERM")).toBe(0)
    expect(r.exits).toEqual([])
  })

  it("MIN-1: a SIGTERM after run_finished completed (before dispose) keeps exit 0", async () => {
    const r = await runOnce({
      env: { [ENV_WRAP_UP_TOOLS]: "Report" },
      onLine: (source, line) => {
        if (line.includes('"run_finished"')) source.emit("SIGTERM")
      },
    })
    expect(r.sends()).toBe(1)
    expect(r.exits).toEqual([])
    expect(r.lines.filter((l) => l.type === "run_finished").map((l) => l.outcome)).toEqual([
      "completed",
    ])
    expect(r.lines.find((l) => l.type === "result")?.outcome).toBe("completed")
    // The process still ends (with its own code) if a live handle stays.
    await new Promise((res) => setTimeout(res, 40))
    expect(r.forced).toEqual([0])
  })
})
