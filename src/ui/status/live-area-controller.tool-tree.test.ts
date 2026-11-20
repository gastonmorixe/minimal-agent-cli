/**
 * The live area status controller with the live tool tree: the open tool
 * calls show as rows in the status slot, with a fake clock.
 */

import { describe, expect, it } from "bun:test"
import { StatusBus } from "@minimal-agent/core/host/status-bus"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"
import { TOOL_PRESENTATION } from "../../plugins-ui/tool-presentation.ts"
import { createStatusPort } from "../../startup/host-ports.ts"
import type { Spinner } from "../spinner/index.ts"
import { LiveAreaStatusController } from "./live-area-controller.ts"
import { ToolCallTracker } from "./tool-calls.ts"

const T0 = 1_000_000_000_000

class FakeEditor {
  readonly statuses: Array<string | readonly string[] | null> = []
  setStatus(text: string | readonly string[] | null): void {
    this.statuses.push(text)
  }
  last(): string[] | string | null {
    const value = this.statuses.at(-1)
    if (value == null) return null
    return typeof value === "string" ? stripAnsi(value) : value.map(stripAnsi)
  }
}

const fakeSpinner: Spinner = {
  willShow: () => undefined,
  didShow: () => undefined,
  willDisappear: () => undefined,
  didDisappear: () => undefined,
  render: () => ({ glyph: "*" }),
}

function setup() {
  const clock = { now: T0 }
  const bus = new StatusBus()
  const editor = new FakeEditor()
  const tracker = new ToolCallTracker({ now: () => clock.now })
  const port = createStatusPort(bus)
  const ctrl = new LiveAreaStatusController(bus, editor, {
    spinner: fakeSpinner,
    maxFps: 0,
    now: () => clock.now,
    toolTree: {
      tracker,
      presentation: TOOL_PRESENTATION,
      cwd: "/work",
      columns: () => 100,
      rows: () => 50,
      fade: false,
    },
  })
  ctrl.start()
  /** A call the way the REPL sees it: a bus row from core, a start from the view. */
  const run = (id: string, name: string, input: Record<string, unknown>) => {
    tracker.queue(id, name, input)
    const handle = port.open({ phase: "running_tool", toolName: name })
    tracker.start(id, name, input, true)
    return handle
  }
  return { clock, bus, editor, tracker, port, ctrl, run }
}

describe("LiveAreaStatusController with a live tool tree", () => {
  it("shows the tool calls as rows, and no group row from the bus", () => {
    const t = setup()
    t.run("a", "Fetch", { url: "https://a.com" })
    t.run("b", "Read", { file_path: "/work/x.ts" })
    t.clock.now += 5000
    t.ctrl.pauseForOverlay(null)
    t.ctrl.resumeFromOverlay()
    expect(t.editor.last()).toEqual([
      "○ Running 2 tools · 5s",
      "├ ● ⤓ Fetch  a.com",
      "╰ ○ • Read   x.ts",
    ])
    expect(t.editor.statuses.flat().join("\n")).not.toContain("Running Fetch")
  })

  it("shows the ended call's row removed in the same change as the tracker end", () => {
    const t = setup()
    const a = t.run("a", "Fetch", { url: "https://a.com" })
    t.run("b", "Fetch", { url: "https://b.com" })
    a.clear()
    t.tracker.end("a")
    expect(t.editor.last()).toEqual(["● Running ⤓ Fetch  b.com"])
    t.tracker.end("b")
    // No call runs: the status goes back to the bus (empty: null).
    expect(t.editor.last()).toBeNull()
  })

  it("pauses: header `○ Paused · N tools`, dim rows, time frozen; resumes after", () => {
    const t = setup()
    t.run("a", "Fetch", { url: "https://a.com" })
    t.run("b", "Fetch", { url: "https://b.com" })
    t.clock.now += 12_000
    t.ctrl.pauseForOverlay("⏸ paused")
    expect(t.editor.last()).toEqual([
      "○ Paused · 2 tools · 12s",
      "├ ○ ⤓ Fetch  a.com",
      "╰ ○ ⤓ Fetch  b.com",
    ])
    t.clock.now += 9000
    t.tracker.end("a") // a change while a modal is open keeps the pause
    expect(t.editor.last()).toEqual(["○ Paused ⤓ Fetch  b.com · 12s"])
    t.ctrl.resumeFromOverlay()
    expect(t.editor.last()).toEqual(["○ Running ⤓ Fetch  b.com · 21s"])
  })

  it("keeps the row of a one-call run in the same form as before the tree for other phases", () => {
    const t = setup()
    t.bus.create("Thinking", { notificationId: "agent.thinking", category: "agent" })
    expect(t.editor.last()).toBe("* Thinking")
  })
})
