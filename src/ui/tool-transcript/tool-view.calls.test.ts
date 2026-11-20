/**
 * The tool view tells the live tool tree when a call starts and when its
 * block reaches the scrollback: the row goes away right after the block.
 */

import { describe, expect, it } from "bun:test"
import type { ToolViewEvent } from "@minimal-agent/core/host-kit/tool-executor-adapter"
import { createReplToolView, type ToolViewCalls } from "./tool-view.ts"

const tool = (id: string) => ({
  type: "tool_use" as const,
  id,
  name: "Fetch",
  input: { url: "https://a.com" },
})

function outcome(id: string): ToolViewEvent {
  return {
    type: "outcome",
    tool: tool(id),
    outcome: { content: "ok", isError: false, findings: [] },
  } as unknown as ToolViewEvent
}

describe("createReplToolView: live tool calls", () => {
  it("writes the block between beforeBlock and afterBlock, so the row goes in the same frame", async () => {
    const log: string[] = []
    const calls: ToolViewCalls = {
      started: (t, concurrent) => log.push(`started ${t.id} ${concurrent}`),
      beforeBlock: () => log.push("before"),
      afterBlock: (id) => log.push(`after ${id}`),
    }
    const view = createReplToolView({
      writeTranscript: (line) => log.push(`row ${line.split("\n").at(-1)?.slice(0, 2)}`),
      presentation: new Map(),
      calls,
    })
    await view.onToolEvent({
      type: "started",
      tool: tool("a"),
      pluginTool: false,
      concurrent: true,
    } as unknown as ToolViewEvent)
    await view.onToolEvent(outcome("a"))
    expect(log[0]).toBe("started a true")
    const before = log.indexOf("before")
    const after = log.indexOf("after a")
    expect(before).toBeGreaterThan(0)
    expect(after).toBeGreaterThan(before)
    // Every row of the block is written between the two calls.
    const rows = log.map((entry, idx) => (entry.startsWith("row") ? idx : -1)).filter((i) => i >= 0)
    expect(rows.length).toBeGreaterThan(0)
    for (const idx of rows) {
      expect(idx).toBeGreaterThan(before)
      expect(idx).toBeLessThan(after)
    }
  })

  it("also closes a refused call", async () => {
    const log: string[] = []
    const view = createReplToolView({
      writeTranscript: () => {},
      presentation: new Map(),
      calls: {
        started: () => {},
        beforeBlock: () => log.push("before"),
        afterBlock: (id) => log.push(`after ${id}`),
      },
    })
    await view.onToolEvent({
      type: "refused",
      tool: tool("r"),
      message: "no",
      refusedBy: "policy",
    } as unknown as ToolViewEvent)
    expect(log).toEqual(["before", "after r"])
  })
})
