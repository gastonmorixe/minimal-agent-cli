/**
 * Volatile-key rule and stable dedupe key of diagnostics with message "".
 * Sources use the `zz.` prefix, no other test uses them.
 */

import { describe, expect, test } from "bun:test"
import { Facility, type LogEvent, Severity } from "@minimal-agent/core/host/diagnostics"
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
