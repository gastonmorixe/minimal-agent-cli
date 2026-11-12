/**
 * Volatile-key rule and stable dedupe key of diagnostics with message "".
 * Sources use the `zz.` prefix, no other test uses them.
 */

import { describe, expect, test } from "bun:test"
import { Facility, type LogEvent, Severity } from "@minimal-agent/core/host/diagnostics"
import { ScrollbackDiagnosticSink } from "../ui/status/scrollback.ts"
import { diagnosticKey, isVolatileDiagnosticKey } from "./diagnostic-text.ts"

function typed(source: string, attrs: Record<string, string | number | boolean | null>): LogEvent {
  return {
    ts: 0,
    severity: Severity.Warning,
    facility: Facility.User,
    source,
    message: "",
    diagnostic: { source, level: "warn", attrs },
  } as LogEvent
}

describe("isVolatileDiagnosticKey", () => {
  const volatile = [
    "elapsed-ms",
    "elapsedMs",
    "delay-ms",
    "delayMs",
    "idle-ms",
    "attempt",
    "attempts",
    "retries",
    "duration",
    "durationMs",
    "bytes",
    "byteCount_bytes",
    "totalBytes",
    "reset-at",
    "resetAt",
    "ts",
    "timestamp",
    "completed-tool-calls",
    "completedToolCalls",
    "timeout_seconds",
  ]
  const stable = [
    "error-type",
    "errorClass",
    "curve",
    "phase",
    "decision",
    "code",
    "pluginId",
    "kind",
    "mode",
    "path",
    "saw-text",
    "stall-sub-phase",
  ]
  for (const k of volatile)
    test(`volatile: ${k}`, () => expect(isVolatileDiagnosticKey(k)).toBe(true))
  for (const k of stable) test(`stable: ${k}`, () => expect(isVolatileDiagnosticKey(k)).toBe(false))
})

describe("diagnosticKey with message empty", () => {
  test("(a) a volatile repeat gives the same key", () => {
    const a = typed("zz.retry", { curve: "x", elapsedMs: 10, attempt: 1 })
    const b = typed("zz.retry", { curve: "x", elapsedMs: 99, attempt: 2 })
    expect(diagnosticKey(a)).toBe(diagnosticKey(b))
  })
  test("(a) structuredData-only events too", () => {
    const base = {
      ts: 0,
      severity: Severity.Warning,
      facility: Facility.User,
      source: "zz.sd",
      message: "",
    }
    const a = { ...base, structuredData: { kind: "k", "elapsed-ms": 1 } } as LogEvent
    const b = { ...base, structuredData: { kind: "k", "elapsed-ms": 2 } } as LogEvent
    expect(diagnosticKey(a)).toBe(diagnosticKey(b))
  })
  test("(b) a stable attr change gives another key", () => {
    const a = typed("zz.retry", { curve: "x", attempt: 1 })
    const b = typed("zz.retry", { curve: "y", attempt: 1 })
    expect(diagnosticKey(a)).not.toBe(diagnosticKey(b))
  })
  test("(b) another source gives another key", () => {
    expect(diagnosticKey(typed("zz.one", { k: 1 }))).not.toBe(
      diagnosticKey(typed("zz.two", { k: 1 })),
    )
  })
})

describe("look-alike and unlisted names", () => {
  // Names that resemble a volatile one but are not in the deny set and do not
  // match the suffix rule. Each must stay in the dedupe key.
  const lookAlikes = [
    "retry-policy",
    "max-attempts",
    "attempt-id",
    "timeout-policy",
    "ordering",
    "pluginId",
    "kind",
    "order",
    "slot",
    "owner",
    "refused",
    "contract",
    "dir",
    "keys",
    "field",
    "index",
  ]
  for (const name of lookAlikes) {
    test(`(b2) look-alike stable keys stay in the dedupe key: ${name}`, () => {
      expect(isVolatileDiagnosticKey(name)).toBe(false)
      const a = typed("zz.look", { [name]: "one" })
      const b = typed("zz.look", { [name]: "two" })
      expect(diagnosticKey(a)).not.toBe(diagnosticKey(b))

      const lines: string[] = []
      const sink = new ScrollbackDiagnosticSink({
        write: (s) => {
          lines.push(s)
        },
        now: () => 1000,
        dedupRepaintMinMs: 0,
      })
      sink.onEvent(a)
      sink.onEvent(b)
      expect(lines).toHaveLength(2)
      for (const l of lines) expect(l).not.toContain("×")
    })
  }

  test("(known limit) an unlisted volatile key keeps repeats apart", () => {
    // Known limit of the name rule, not a promise, and it cuts both ways.
    // (a) This test: a volatile key that is not on the list (for example
    // latency, next-attempt, retry-after) keeps repeats apart, so they do
    // not collapse. The fix is to add the name to the list.
    // (b) The next test: a name on the list can drop a real discriminator.
    expect(isVolatileDiagnosticKey("latency")).toBe(false)
    const a = typed("zz.limit", { curve: "x", latency: 10 })
    const b = typed("zz.limit", { curve: "x", latency: 99 })
    expect(diagnosticKey(a)).not.toBe(diagnosticKey(b))
  })

  test("(known limit) a listed name can drop a real discriminator", () => {
    // Known limit of the name rule, not a promise. Names such as size, count,
    // or a name ending in -ms, -bytes, -seconds, -at are treated as volatile.
    // A key that names a real stable limit (max-bytes) or a retry-after-ms
    // that differs per cause is dropped too. Two different diagnostics that
    // differ only in such a key COLLAPSE.
    expect(isVolatileDiagnosticKey("size")).toBe(true)
    const a = typed("zz.limit.size", { size: 1 })
    const b = typed("zz.limit.size", { size: 2 })
    expect(diagnosticKey(a)).toBe(diagnosticKey(b))
  })
})
