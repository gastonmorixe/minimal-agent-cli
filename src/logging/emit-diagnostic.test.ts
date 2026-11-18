/**
 * `emitDiagnostic`: the one-line bus emit that replaces direct stderr writes.
 *
 * @module logging/emit-diagnostic.test
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import {
  Facility,
  getDiagnosticBus,
  type LogEvent,
  Severity,
} from "@minimal-agent/core/host/diagnostics"
import { emitDiagnostic, plainDiagnosticText } from "./emit-diagnostic.ts"

describe("plainDiagnosticText", () => {
  it("strips SGR colours and keeps the words", () => {
    expect(plainDiagnosticText("  \x1b[1;33mwarn\x1b[0m could not install")).toBe(
      "warn could not install",
    )
  })

  it("strips OSC sequences (hyperlink, window title) and a C1 CSI", () => {
    expect(plainDiagnosticText("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\ end")).toBe("link end")
    expect(plainDiagnosticText("\x1b]0;title\x07after")).toBe("after")
    expect(plainDiagnosticText("\u009b31mred\u009b0m")).toBe("red")
  })

  it("turns newlines, tabs, CR, BEL, DEL and other controls into one space", () => {
    expect(plainDiagnosticText("a\nb\tc\r\nd\x07e\x7ff\x00g")).toBe("a b c d e f g")
  })

  it("collapses runs of whitespace and trims", () => {
    expect(plainDiagnosticText("  one   two \n\n three  ")).toBe("one two three")
  })

  it("keeps non-ASCII text (emoji, CJK, accents) untouched", () => {
    expect(plainDiagnosticText("⚠ ünïcode 日本語 🙂")).toBe("⚠ ünïcode 日本語 🙂")
  })

  it("returns an empty string for text that is only escapes and whitespace", () => {
    expect(plainDiagnosticText("\x1b[0m \n\t")).toBe("")
    expect(plainDiagnosticText("")).toBe("")
  })
})

describe("emitDiagnostic", () => {
  let events: LogEvent[] = []
  let unsubscribe: (() => void) | undefined

  beforeEach(() => {
    events = []
    unsubscribe = getDiagnosticBus().on("*", (e) => events.push(e))
  })

  afterEach(() => {
    unsubscribe?.()
    unsubscribe = undefined
  })

  it("emits one event with the severity, source, message and data, under Facility.User", () => {
    const before = Date.now()
    emitDiagnostic(Severity.Warning, "test.emit-diagnostic", "something odd", {
      handler: "queueKeyHandler",
      count: 2,
      fatal: false,
    })
    const mine = events.filter((e) => e.source === "test.emit-diagnostic")
    expect(mine).toHaveLength(1)
    const event = mine[0] as LogEvent
    expect(event.severity).toBe(Severity.Warning)
    expect(event.facility).toBe(Facility.User)
    expect(event.message).toBe("something odd")
    expect(event.structuredData).toEqual({ handler: "queueKeyHandler", count: 2, fatal: false })
    expect(event.ts).toBeGreaterThanOrEqual(before)
    expect(event.ts).toBeLessThanOrEqual(Date.now())
  })

  it("keeps the severity it is given (Debug stays Debug)", () => {
    emitDiagnostic(Severity.Debug, "test.emit-diagnostic.debug", "trace")
    const mine = events.filter((e) => e.source === "test.emit-diagnostic.debug")
    expect(mine).toHaveLength(1)
    expect(mine[0]?.severity).toBe(Severity.Debug)
    expect(mine[0]?.structuredData).toBeUndefined()
  })

  it("writes nothing to process.stdout or process.stderr", () => {
    const out = spyOn(process.stdout, "write").mockImplementation(() => true)
    const err = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      emitDiagnostic(Severity.Warning, "test.emit-diagnostic.quiet", "no tty write")
      expect(out).not.toHaveBeenCalled()
      expect(err).not.toHaveBeenCalled()
    } finally {
      out.mockRestore()
      err.mockRestore()
    }
    expect(events.some((e) => e.source === "test.emit-diagnostic.quiet")).toBe(true)
  })

  it("never throws, even when the bus itself throws", () => {
    const bus = getDiagnosticBus()
    const emit = spyOn(bus, "emit").mockImplementation(() => {
      throw new Error("bus is broken")
    })
    try {
      expect(() =>
        emitDiagnostic(Severity.Warning, "test.emit-diagnostic.broken", "still fine"),
      ).not.toThrow()
      expect(emit).toHaveBeenCalledTimes(1)
    } finally {
      emit.mockRestore()
    }
  })
})
