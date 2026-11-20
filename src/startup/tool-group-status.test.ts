/**
 * The tool group status row (D11, decision A). The CLI status port shows
 * the `running_tool` rows of calls that run at the same time as ONE row:
 * `Running N tools · Fetch ×7 · (12s)`, with the timer of the oldest call
 * that still runs. One open call keeps today's row.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { StatusBus } from "@minimal-agent/core/host/status-bus"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"
import { _resetNerdGlyphCellsForTest } from "../terminal/nerd-glyph-width.ts"
import type { Spinner } from "../ui/spinner/index.ts"
import { LiveAreaStatusController } from "../ui/status/live-area-controller.ts"

import { createStatusPort, toolGroupLabel } from "./host-ports.ts"

class FakeEditor {
  readonly statuses: Array<string | null> = []
  setStatus(text: string | null): void {
    this.statuses.push(text)
  }
}

const fakeSpinner: Spinner = {
  willShow: () => undefined,
  didShow: () => undefined,
  willDisappear: () => undefined,
  didDisappear: () => undefined,
  render: () => ({ glyph: "*" }),
}

/** A port and a status row that share one fake clock. */
function harness(maxFps = 0) {
  let now = 1_000_000
  const bus = new StatusBus()
  const editor = new FakeEditor()
  const port = createStatusPort(bus, { now: () => now })
  const ctrl = new LiveAreaStatusController(bus, editor, {
    spinner: fakeSpinner,
    maxFps,
    now: () => now,
  })
  ctrl.start()
  const tick = (ms: number) => {
    now += ms
  }
  /** Open one tool call the way core does: open, then the idle activity. */
  const openTool = (toolName: string) => {
    const handle = port.open({ phase: "running_tool", toolName })
    handle.updateActivity({ direction: "idle", startedAt: now })
    return handle
  }
  /** The plain text of the row, after a repaint from the bus. */
  const row = (): string | null => {
    ctrl.pauseForOverlay(null)
    ctrl.resumeFromOverlay()
    const last = editor.statuses.at(-1)
    return last == null ? null : stripAnsi(last)
  }
  return { bus, editor, port, ctrl, tick, openTool, row }
}

describe("toolGroupLabel", () => {
  it("counts each tool name in first-start order", () => {
    expect(toolGroupLabel(["Fetch", "Read", "Fetch", "Glob", "Fetch"])).toBe(
      "Running 5 tools · Fetch ×3 · Read ×1 · Glob ×1",
    )
    expect(toolGroupLabel(["Fetch", "Fetch"])).toBe("Running 2 tools · Fetch ×2")
  })

  it("a tool with one call ends in ×1", () => {
    expect(toolGroupLabel(["Fetch", "Read"])).toBe("Running 2 tools · Fetch ×1 · Read ×1")
    expect(toolGroupLabel(["Glob", "Glob", "Read"]).endsWith("Read ×1")).toBe(true)
  })
})

describe("createStatusPort: tool group row", () => {
  beforeEach(() => _resetNerdGlyphCellsForTest())
  afterEach(() => _resetNerdGlyphCellsForTest())

  it("one tool keeps today's row", () => {
    const h = harness()
    const call = h.openTool("Fetch")
    expect(h.bus.current()).toBe("Running Fetch")
    expect(h.bus.currentStatus()?.notificationId).toBe("tool.running")
    h.tick(12_000)
    expect(h.row()).toBe("* Running Fetch · (12s)")
    call.clear()
    expect(h.bus.current()).toBeNull()
    h.ctrl.stop()
  })

  it("3 tools show one row with counts in first-start order and the oldest timer", () => {
    const h = harness()
    const a = h.openTool("Fetch")
    h.tick(2_000)
    const b = h.openTool("Read")
    h.tick(3_000)
    const c = h.openTool("Fetch")
    // One bus entry, not three.
    expect(h.bus.current()).toBe("Running 3 tools · Fetch ×2 · Read ×1")
    h.tick(7_000)
    // 12 s since the oldest call (a) started.
    expect(h.row()).toBe("* Running 3 tools · Fetch ×2 · Read ×1 · (12s)")

    // The oldest call ends first: the timer moves to the next oldest (b).
    a.clear()
    expect(h.bus.current()).toBe("Running 2 tools · Read ×1 · Fetch ×1")
    expect(h.row()).toBe("* Running 2 tools · Read ×1 · Fetch ×1 · (10s)")

    // Back to one call: the row shows that call as today.
    b.clear()
    expect(h.bus.current()).toBe("Running Fetch")
    expect(h.row()).toBe("* Running Fetch · (7s)")
    c.clear()
    expect(h.bus.current()).toBeNull()
    expect(h.row()).toBeNull()
    h.ctrl.stop()
  })

  it("drops back to one when the newest calls end first", () => {
    const h = harness()
    const a = h.openTool("Glob")
    h.tick(1_000)
    const b = h.openTool("Fetch")
    expect(h.bus.current()).toBe("Running 2 tools · Glob ×1 · Fetch ×1")
    h.tick(4_000)
    b.clear()
    expect(h.bus.current()).toBe("Running Glob")
    // Rule 3: the same notification id as a solo row (the icon and the text).
    expect(h.bus.currentStatus()?.notificationId).toBe("tool.running")
    expect(h.row()).toBe("* Running Glob · (5s)")
    a.clear()
    expect(h.bus.current()).toBeNull()
    // A new call after the group starts a fresh, plain row.
    const next = h.openTool("Read")
    expect(h.bus.currentStatus()?.notificationId).toBe("tool.running")
    expect(h.row()).toBe("* Running Read ·")
    next.clear()
    h.ctrl.stop()
  })

  it("back to 1 keeps the time of that call, also when the entry is older", () => {
    const h = harness()
    const a = h.openTool("Fetch")
    h.tick(10_000)
    const b = h.openTool("Read")
    h.tick(3_000)
    // The carrier entry is the one of call a (13 s old). Call b is 3 s old.
    a.clear()
    expect(h.bus.currentStatus()?.notificationId).toBe("tool.running")
    expect(h.row()).toBe("* Running Read · (3s)")
    h.tick(2_000)
    expect(h.row()).toBe("* Running Read · (5s)")
    b.clear()
    h.ctrl.stop()
  })

  it("resetToolRows drops a stale call, so a later call is a solo row again", () => {
    const h = harness()
    // A call that core never clears (a missed clear).
    const stale = h.openTool("Fetch")
    h.tick(60_000)
    // The run ends: the host resets the tool rows.
    h.port.resetToolRows()
    expect(h.bus.current()).toBeNull()

    h.tick(1_000)
    const next = h.openTool("Read")
    expect(h.bus.current()).toBe("Running Read")
    expect(h.bus.currentStatus()?.notificationId).toBe("tool.running")
    h.tick(2_000)
    expect(h.row()).toBe("* Running Read · (2s)")
    // A late call on the stale handle does nothing to the new row.
    stale.update({ phase: "running_tool", toolName: "Glob" })
    stale.updateActivity({ direction: "down", recvBytes: 10 })
    stale.clear()
    expect(h.bus.current()).toBe("Running Read")
    // A second call groups with the live call only.
    const other = h.openTool("Glob")
    expect(h.bus.current()).toBe("Running 2 tools · Read ×1 · Glob ×1")
    other.clear()
    next.clear()
    expect(h.bus.current()).toBeNull()
    h.ctrl.stop()
  })

  it("without the reset, a stale call would group with a later call", () => {
    const h = harness()
    h.openTool("Fetch")
    const next = h.openTool("Read")
    expect(h.bus.current()).toBe("Running 2 tools · Fetch ×1 · Read ×1")
    next.clear()
    h.port.resetToolRows()
    expect(h.bus.current()).toBeNull()
    h.ctrl.stop()
  })

  it("a clear twice of the same call changes nothing", () => {
    const h = harness()
    const a = h.openTool("Fetch")
    const b = h.openTool("Fetch")
    a.clear()
    a.clear()
    expect(h.bus.current()).toBe("Running Fetch")
    b.clear()
    expect(h.bus.current()).toBeNull()
    h.ctrl.stop()
  })

  it("other phases keep their own rows", () => {
    const h = harness()
    const send = h.port.open({ phase: "sending" })
    const tool = h.openTool("Fetch")
    expect(h.bus.current()).toBe("Running Fetch")
    tool.clear()
    expect(h.bus.current()).toBe("Sending request")
    send.clear()
    h.ctrl.stop()
  })

  it("a modal that opens while 3 calls run stops the tick; the row resumes after it closes", async () => {
    const h = harness(60)
    const calls = [h.openTool("Fetch"), h.openTool("Fetch"), h.openTool("Read")]
    h.ctrl.pauseForOverlay("PAUSED")
    const during = h.editor.statuses.length
    h.tick(5_000)
    // Bus churn and time under the modal: no paint, no tick.
    calls[0]?.clear()
    await Bun.sleep(80)
    expect(h.editor.statuses.length).toBe(during)
    expect(h.editor.statuses.at(-1)).toBe("PAUSED")

    h.ctrl.resumeFromOverlay()
    expect(stripAnsi(h.editor.statuses.at(-1) ?? "")).toBe(
      "* Running 2 tools · Fetch ×1 · Read ×1 · (5s)",
    )
    // The tick runs again after the modal closes.
    const after = h.editor.statuses.length
    await Bun.sleep(80)
    expect(h.editor.statuses.length).toBeGreaterThan(after)
    for (const call of calls) call.clear()
    h.ctrl.stop()
  })
})
