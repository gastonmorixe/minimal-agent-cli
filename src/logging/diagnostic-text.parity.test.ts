/**
 * Parity test (S14.2 step 0): `diagnosticText(e)` equals `e.message` while the
 * message is set, so every CLI renderer prints the same bytes as before.
 * Also covers the source registry and the fallback for an unknown source.
 *
 * @module logging/diagnostic-text.parity.test
 */

import { describe, expect, test } from "bun:test"

import {
  createDiagnosticBus,
  Facility,
  type LogEvent,
  Severity,
} from "@minimal-agent/core/host/diagnostics"

import { diagnosticText, registerDiagnosticText } from "./diagnostic-text.ts"
import { StderrMirrorSink } from "./log-stderr.ts"

function ev(over: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: Date.UTC(2026, 4, 20, 11, 14, 37, 412),
    severity: Severity.Warning,
    facility: Facility.User,
    source: "test.src",
    message: "hello",
    ...over,
  }
}

const SAMPLES: readonly LogEvent[] = [
  ev(),
  ev({ severity: Severity.Error, message: "boom: it failed" }),
  ev({ severity: Severity.Info, message: "multi\nline" }),
  ev({ severity: Severity.Debug, message: "x", structuredData: { k: "v" } }),
  ev({
    message: "with diagnostic",
    diagnostic: { source: "test.src", level: "warn", attrs: { a: 1 } },
  }),
]

describe("diagnosticText parity (message set)", () => {
  for (const s of SAMPLES) {
    test(`byte equal to message: ${s.severity} ${JSON.stringify(s.message)}`, () => {
      expect(diagnosticText(s)).toBe(s.message)
    })
  }

  test("log-stderr prints the exact old line (old template inlined)", () => {
    const expected = [
      "[WARN] test.src: hello\n",
      "[ERROR] test.src: boom: it failed\n",
      "[INFO] test.src: multi\nline\n",
      '[DEBUG] test.src: x k="v"\n',
      "[WARN] test.src: with diagnostic\n",
    ]
    SAMPLES.forEach((s, i) => {
      const lines: string[] = []
      const bus = createDiagnosticBus()
      const sink = new StderrMirrorSink({
        write: (l: string) => lines.push(l),
        level: Severity.Debug,
      })
      sink.attach(bus)
      bus.emit(s)
      expect(lines).toEqual([expected[i] as string])
    })
  })
})

describe("diagnosticText registry and fallback", () => {
  test("empty message, unknown source: fallback with stable key order", () => {
    const e = ev({
      message: "",
      diagnostic: { source: "zz.unknown", level: "warn", attrs: { b: 2, a: "x", c: true } },
    })
    expect(diagnosticText(e)).toBe("zz.unknown: a=x b=2 c=true")
  })

  test("empty message, no diagnostic: empty string (same as message)", () => {
    expect(diagnosticText(ev({ message: "" }))).toBe("")
  })

  test("registered source renders from attrs and level", () => {
    registerDiagnosticText("zz.registered", (attrs, level) => `[${level}] n=${String(attrs.n)}`)
    const e = ev({
      message: "",
      diagnostic: { source: "zz.registered", level: "error", attrs: { n: 7 } },
    })
    expect(diagnosticText(e)).toBe("[error] n=7")
  })

  test("message wins over a registered renderer", () => {
    registerDiagnosticText("zz.registered2", () => "from registry")
    const e = ev({
      message: "kept",
      diagnostic: { source: "zz.registered2", level: "warn", attrs: {} },
    })
    expect(diagnosticText(e)).toBe("kept")
  })
})
