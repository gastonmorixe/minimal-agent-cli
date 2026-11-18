/**
 * `EditorController` reports a throwing hook or handler on the diagnostic bus,
 * not on `process.stderr`.
 *
 * A raw stderr write tears the live area while the REPL is up. The three
 * catch sites (`editor.key` emit, `editor.buffer.changed` emit, the queue key
 * handler) emit a Warning `editor.handler-threw` with `{ handler }` instead.
 *
 * @module editor-controller.diagnostics.test
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { getDiagnosticBus, type LogEvent, Severity } from "@minimal-agent/core/host/diagnostics"
import { Hooks } from "@minimal-agent/core/host-kit/hooks"

import { make } from "./editor-controller.fixtures.ts"

const SOURCE = "editor.handler-threw"

describe("EditorController: a throwing hook or handler goes to the diagnostic bus", () => {
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

  it("editor.key emit that throws: Warning with handler=editor.key, nothing on stderr", () => {
    const hooks = new Hooks()
    spyOn(hooks, "emitSync").mockImplementation(() => {
      throw new Error("emit-sync boom")
    })
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("\x1b[A") // ArrowUp is routed through the editor.key hook
    ctrl.stop()

    const got = ours()
    expect(got).toHaveLength(1)
    expect(got[0]?.severity).toBe(Severity.Warning)
    expect(got[0]?.message).toBe("emit-sync boom")
    expect(got[0]?.structuredData).toEqual({ handler: "editor.key" })
    expect(stderrWrite).not.toHaveBeenCalled()
  })

  it("editor.buffer.changed emit that throws: Warning with handler=editor.buffer.changed", () => {
    const hooks = new Hooks()
    spyOn(hooks, "emitAsync").mockImplementation(() => {
      throw new Error("emit-async boom")
    })
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("x") // a changed buffer repaints and fires editor.buffer.changed
    ctrl.stop()

    const got = ours()
    expect(got.length).toBeGreaterThanOrEqual(1)
    for (const e of got) {
      expect(e.severity).toBe(Severity.Warning)
      expect(e.message).toBe("emit-async boom")
      expect(e.structuredData).toEqual({ handler: "editor.buffer.changed" })
    }
    expect(stderrWrite).not.toHaveBeenCalled()
  })

  it("queue key handler that throws: Warning with handler=queueKeyHandler, key is not logged", () => {
    const { ctrl, stdin } = make()
    ctrl.setQueueKeyHandler(() => {
      throw new Error("queue boom")
    })
    ctrl.start()
    stdin.send("q") // a printable key reaches the queue handler first
    const submits: string[] = []
    ctrl.on("submit", (t) => submits.push(t))
    stdin.send("\r")
    ctrl.stop()

    // The key still falls through to default handling (behaviour unchanged).
    expect(submits).toEqual(["q"])
    const got = ours()
    expect(got.length).toBeGreaterThanOrEqual(1)
    for (const e of got) {
      expect(e.severity).toBe(Severity.Warning)
      expect(e.message).toBe("queue boom")
      expect(e.structuredData).toEqual({ handler: "queueKeyHandler" })
      // The typed character must not leak into the durable log.
      expect(JSON.stringify(e)).not.toContain('"q"')
    }
    expect(stderrWrite).not.toHaveBeenCalled()
  })

  it("a non-Error throw is reported by its string form", () => {
    const hooks = new Hooks()
    spyOn(hooks, "emitSync").mockImplementation(() => {
      throw "plain string"
    })
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("\x1b[A")
    ctrl.stop()

    expect(ours()[0]?.message).toBe("plain string")
    expect(stderrWrite).not.toHaveBeenCalled()
  })
})
