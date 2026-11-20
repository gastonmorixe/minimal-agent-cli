/**
 * The REPL tool view for calls in a wave (D11). Core marks a call that
 * runs in a wave of 2 or more with `started.concurrent`. The view keeps
 * the rows of such a call and writes them as one block when the call
 * ends, so blocks show in end order and never mix. Solo calls and Bash
 * write live, as before (X4).
 */

import { afterEach, describe, expect, it, setSystemTime } from "bun:test"
import type {
  ToolViewEvent,
  ToolViewOutcome,
} from "@minimal-agent/core/host-kit/tool-executor-adapter"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"
import type { ToolUseBlock } from "@minimal-agent/core/sdk/messages"
import { ToolTimeTracker } from "./tool-time.ts"

import { createReplToolView } from "./tool-view.ts"

const T0 = new Date(2026, 10, 20, 9, 0, 0).getTime()

function readCall(id: string, path: string): ToolUseBlock {
  return { type: "tool_use", id, name: "Read", input: { file_path: path } }
}

function outcome(content: string, extra: Partial<ToolViewOutcome> = {}): ToolViewOutcome {
  return { content, isError: false, aborted: false, findings: [], ...extra }
}

/** A view whose writes are recorded one entry per `writeTranscript` call. */
function recorder(tracker: ToolTimeTracker | null = null) {
  const writes: string[] = []
  const view = createReplToolView({
    writeTranscript: (line) => writes.push(line),
    presentation: new Map(),
    toolTimeTracker: tracker,
    columns: () => 100,
    cwd: "/w",
  })
  const send = (event: ToolViewEvent) => view.onToolEvent(event)
  return { writes, view, send }
}

/** Split recorded rows into blocks: each block starts at a `╭` header row. */
function blocks(writes: string[]): string[][] {
  const out: string[][] = []
  for (const row of writes.map((w) => stripAnsi(w))) {
    if (row.includes("╭")) out.push([row])
    else out.at(-1)?.push(row)
  }
  return out
}

afterEach(() => {
  setSystemTime()
})

describe("REPL tool view: calls in a wave", () => {
  it("writes each call as one block, in end order, with the start time in the header", async () => {
    const { writes, send } = recorder(new ToolTimeTracker())
    const a = readCall("a", "/w/a.txt")
    const b = readCall("b", "/w/b.txt")
    setSystemTime(new Date(T0))
    await send({ type: "started", tool: a, pluginTool: false, concurrent: true })
    setSystemTime(new Date(T0 + 5_000))
    await send({ type: "started", tool: b, pluginTool: false, concurrent: true })
    // Nothing shows while the calls run.
    expect(writes).toEqual([])

    setSystemTime(new Date(T0 + 20_000))
    await send({ type: "outcome", tool: b, outcome: outcome("beta body") })
    const afterB = writes.length
    expect(afterB).toBeGreaterThan(0)
    setSystemTime(new Date(T0 + 30_000))
    await send({ type: "outcome", tool: a, outcome: outcome("alpha body") })

    const got = blocks(writes)
    expect(got).toHaveLength(2)
    const [first, second] = got
    // End order: B ended first.
    expect(first?.[0]).toContain("b.txt")
    expect(second?.[0]).toContain("a.txt")
    // The header shows the START time of the call, not its end time.
    expect(first?.[0]).toContain("09:00:05")
    expect(second?.[0]).toContain("09:00:00")
    expect(second?.[0]).not.toContain("09:00:30")
    // No mixed rows: each block holds only its own body.
    expect(first?.join("\n")).toContain("beta body")
    expect(first?.join("\n")).not.toContain("alpha body")
    expect(second?.join("\n")).toContain("alpha body")
    expect(second?.join("\n")).not.toContain("beta body")
    // B's rows all came before A's first row.
    expect(writes.slice(0, afterB).some((w) => stripAnsi(w).includes("alpha body"))).toBe(false)
  })

  it("keeps a solo call byte-identical to the live path", async () => {
    const run = async (concurrentKey: boolean): Promise<string[]> => {
      const { writes, send } = recorder()
      const tool = readCall("s", "/w/solo.txt")
      const started: ToolViewEvent = concurrentKey
        ? { type: "started", tool, pluginTool: false, concurrent: false }
        : { type: "started", tool, pluginTool: false }
      await send(started)
      const atStart = writes.length
      await send({ type: "outcome", tool, outcome: outcome("one\ntwo\nthree") })
      // Live path: the header shows at once, before the outcome.
      expect(atStart).toBeGreaterThan(0)
      return writes
    }
    const live = await run(false)
    const flagFalse = await run(true)
    expect(flagFalse).toEqual(live)

    // A wave call gives the same rows, only later.
    const { writes, send } = recorder()
    const tool = readCall("s", "/w/solo.txt")
    await send({ type: "started", tool, pluginTool: false, concurrent: true })
    expect(writes).toEqual([])
    await send({ type: "outcome", tool, outcome: outcome("one\ntwo\nthree") })
    expect(writes).toEqual(live)
  })

  it("keeps Bash live in a wave", async () => {
    const { writes, send } = recorder()
    const bash: ToolUseBlock = {
      type: "tool_use",
      id: "sh",
      name: "Bash",
      input: { command: "seq 3" },
    }
    await send({
      type: "started",
      tool: bash,
      pluginTool: false,
      concurrent: true,
    })
    expect(writes.some((w) => stripAnsi(w).includes("seq 3"))).toBe(true)
    await send({ type: "output", tool: bash, chunk: "1\n2\n" })
    await send({ type: "output", tool: bash, chunk: "3\n" })
    // Stream rows show before the call ends.
    expect(writes.some((w) => stripAnsi(w).includes("1"))).toBe(true)
    const beforeEnd = writes.length
    await send({ type: "executed", tool: bash, isError: false })
    await send({ type: "outcome", tool: bash, outcome: outcome("1\n2\n3") })
    expect(writes.length).toBeGreaterThan(beforeEnd)
  })

  it("writes an aborted wave call as its block, and flushPending writes a call with no outcome", async () => {
    const { writes, view, send } = recorder()
    const a = readCall("a", "/w/a.txt")
    const b = readCall("b", "/w/b.txt")
    await send({ type: "started", tool: a, pluginTool: false, concurrent: true })
    await send({ type: "started", tool: b, pluginTool: false, concurrent: true })
    await send({
      type: "outcome",
      tool: a,
      outcome: outcome("tool aborted by user", { aborted: true, isError: true }),
    })
    expect(blocks(writes)).toHaveLength(1)
    expect(blocks(writes)[0]?.[0]).toContain("a.txt")

    // B never gets an outcome (the run stopped). The safety net writes it.
    view.flushPending()
    const got = blocks(writes)
    expect(got).toHaveLength(2)
    expect(got[1]?.[0]).toContain("b.txt")
    // A second flush writes nothing more.
    const count = writes.length
    view.flushPending()
    expect(writes.length).toBe(count)
  })

  it("prints the date prefix on the block that prints first, across midnight", async () => {
    const tracker = new ToolTimeTracker()
    const { writes, send } = recorder(tracker)
    // An earlier tool on Nov 19 sets the day of the tracker.
    const LATE = new Date(2026, 10, 19, 23, 59, 50).getTime()
    setSystemTime(new Date(LATE - 60_000))
    tracker.format(LATE - 60_000)
    const a = readCall("a", "/w/a.txt")
    const b = readCall("b", "/w/b.txt")
    // a starts before midnight, b after midnight.
    setSystemTime(new Date(LATE))
    await send({ type: "started", tool: a, pluginTool: false, concurrent: true })
    setSystemTime(new Date(LATE + 20_000))
    await send({ type: "started", tool: b, pluginTool: false, concurrent: true })
    // b ends first and prints first: its header is the first of Nov 20.
    setSystemTime(new Date(LATE + 30_000))
    await send({ type: "outcome", tool: b, outcome: outcome("beta") })
    setSystemTime(new Date(LATE + 40_000))
    await send({ type: "outcome", tool: a, outcome: outcome("alpha") })
    const [first, second] = blocks(writes)
    expect(first?.[0]).toContain("b.txt")
    expect(first?.[0]).toContain("Nov 20 00:00:10")
    // a prints second, with a start time on Nov 19: the day changed back.
    expect(second?.[0]).toContain("a.txt")
    expect(second?.[0]).toContain("Nov 19 23:59:50")
  })

  it("keeps the start time for a plugin tool with no header key in a wave", async () => {
    const { writes, send } = recorder(new ToolTimeTracker())
    const p1: ToolUseBlock = { type: "tool_use", id: "p1", name: "Probe", input: {} }
    const p2: ToolUseBlock = { type: "tool_use", id: "p2", name: "Probe", input: {} }
    setSystemTime(new Date(T0))
    await send({ type: "started", tool: p1, pluginTool: true, concurrent: true })
    setSystemTime(new Date(T0 + 2_000))
    await send({ type: "started", tool: p2, pluginTool: true, concurrent: true })
    // The plugin header waits for plugin_result; nothing shows yet.
    setSystemTime(new Date(T0 + 9_000))
    await send({
      type: "plugin_result",
      tool: p2,
      view: { displayHeader: "probe two", suppressToolTime: false },
    })
    await send({
      type: "plugin_result",
      tool: p1,
      view: { displayHeader: "probe one", suppressToolTime: false },
    })
    expect(writes).toEqual([])
    await send({ type: "outcome", tool: p2, outcome: outcome("two body") })
    await send({ type: "outcome", tool: p1, outcome: outcome("one body") })
    const [first, second] = blocks(writes)
    expect(first?.[0]).toContain("probe two")
    expect(first?.[0]).toContain("09:00:02")
    expect(first?.join("\n")).toContain("two body")
    expect(second?.[0]).toContain("probe one")
    expect(second?.[0]).toContain("09:00:00")
    expect(second?.join("\n")).toContain("one body")
  })

  it("an abort while a call waits for the post-run section writes its block once, as aborted", async () => {
    const { writes, view, send } = recorder()
    const a = readCall("a", "/w/a.txt")
    const b = readCall("b", "/w/b.txt")
    await send({ type: "started", tool: a, pluginTool: false, concurrent: true })
    await send({ type: "started", tool: b, pluginTool: false, concurrent: true })
    await send({ type: "outcome", tool: a, outcome: outcome("alpha body") })
    // b ran, then the abort came while it waited for the section. Core
    // sends an aborted outcome for it (tool-round.ts, the ran() catch).
    await send({
      type: "outcome",
      tool: b,
      outcome: outcome("[Request interrupted by user]", { aborted: true, isError: true }),
    })
    const got = blocks(writes)
    expect(got).toHaveLength(2)
    expect(got[1]?.[0]).toContain("b.txt")
    expect(got[1]?.join("\n")).toContain("interrupted")
    // The run end flush writes nothing more: the block is out once.
    const count = writes.length
    view.flushPending()
    expect(writes.length).toBe(count)
    expect(writes.filter((w) => stripAnsi(w).includes("b.txt"))).toHaveLength(1)
  })

  it("flushPending does not touch a finished or live call", () => {
    const { writes, view } = recorder()
    view.flushPending()
    expect(writes).toEqual([])
  })
})
