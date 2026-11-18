/**
 * The Auto-ASK trace of the live REPL goes to the diagnostic bus (Debug,
 * `auto-ask.trace`), not to `process.stderr`. `DEBUG=1` still gates it.
 *
 * @module startup/live-repl.auto-ask-logger.test
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { EventEmitter } from "node:events"
import { getDiagnosticBus, type LogEvent, Severity } from "@minimal-agent/core/host/diagnostics"
import { AutoAskController } from "@minimal-agent/core/host-kit/auto-ask"
import { ModeManager } from "@minimal-agent/core/host-kit/modes"
import type { ManifestMode } from "@minimal-agent/core/plugin-api/types/plugin"

import { autoAskLogger } from "./live-repl.ts"

const SOURCE = "auto-ask.trace"

const ASK_MODE: ManifestMode = {
  id: "ask",
  label: "ASK",
  statusLabel: "Asking",
  disallowedTools: ["Edit", "Write"],
}

/** Tiny stand-in for the editor: only the `input` event the controller reads. */
class FakeSource extends EventEmitter {
  send(text: string, seq: number): void {
    this.emit("input", { text, seq })
  }
}

describe("autoAskLogger", () => {
  let events: LogEvent[] = []
  let unsubscribe: (() => void) | undefined
  let stderrWrite: ReturnType<typeof spyOn<typeof process.stderr, "write">>

  beforeEach(() => {
    events = []
    unsubscribe = getDiagnosticBus().on("*", (e) => events.push(e))
    stderrWrite = spyOn(process.stderr, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    stderrWrite.mockRestore()
    unsubscribe?.()
    unsubscribe = undefined
  })

  const ours = (): LogEvent[] => events.filter((e) => e.source === SOURCE)

  it("is off unless DEBUG is exactly '1'", () => {
    expect(autoAskLogger({})).toBeUndefined()
    expect(autoAskLogger({ DEBUG: "0" })).toBeUndefined()
    expect(autoAskLogger({ DEBUG: "true" })).toBeUndefined()
    expect(autoAskLogger({ DEBUG: "" })).toBeUndefined()
  })

  it("with DEBUG=1 a line becomes a Debug auto-ask.trace event, nothing on stderr", () => {
    const log = autoAskLogger({ DEBUG: "1" })
    expect(log).toBeDefined()
    log?.("auto-ask: → ASK (score=3)")

    const got = ours()
    expect(got).toHaveLength(1)
    expect(got[0]?.severity).toBe(Severity.Debug)
    expect(got[0]?.message).toBe("auto-ask: → ASK (score=3)")
    expect(stderrWrite).not.toHaveBeenCalled()
  })

  it("a real AutoAskController traces its mode flips on the bus", () => {
    const modes = new ModeManager([ASK_MODE], null)
    const source = new FakeSource()
    const ctrl = new AutoAskController(source, modes, { logger: autoAskLogger({ DEBUG: "1" }) })
    try {
      source.send("what is this", 1)
      expect(modes.activeId()).toBe("ask")
      source.send("fix the bug", 2)
      expect(modes.activeId()).toBeNull()
    } finally {
      ctrl.dispose()
    }

    // Every trace is a Debug event. The count is not pinned: core also traces
    // its own "user changed mode" hook while it reverts.
    const got = ours()
    for (const e of got) expect(e.severity).toBe(Severity.Debug)
    const messages = got.map((e) => e.message)
    const flipIn = messages.findIndex((m) => m.includes("→ ASK"))
    const flipOut = messages.findIndex((m) => m.includes("← default"))
    expect(flipIn).toBeGreaterThanOrEqual(0)
    expect(flipOut).toBeGreaterThan(flipIn)
    expect(stderrWrite).not.toHaveBeenCalled()
  })

  it("without DEBUG=1 the controller traces nothing", () => {
    const modes = new ModeManager([ASK_MODE], null)
    const source = new FakeSource()
    const ctrl = new AutoAskController(source, modes, { logger: autoAskLogger({}) })
    try {
      source.send("what is this", 1)
      expect(modes.activeId()).toBe("ask")
    } finally {
      ctrl.dispose()
    }
    expect(ours()).toEqual([])
    expect(stderrWrite).not.toHaveBeenCalled()
  })
})
