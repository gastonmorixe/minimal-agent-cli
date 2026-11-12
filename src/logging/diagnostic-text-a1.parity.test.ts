/**
 * Parity test (S14.2 A1): the registry renders the old text from attrs when the
 * message is empty (the later step). Core now sends message AND attrs. The
 * CLI text and the stderr line must equal the old ones, byte for byte. The
 * old templates are inlined as the expected strings.
 *
 * @module logging/diagnostic-text-a1.parity.test
 */

import { describe, expect, test } from "bun:test"

import {
  createDiagnosticBus,
  Facility,
  type LogEvent,
  Severity,
} from "@minimal-agent/core/host/diagnostics"

import { diagnosticKey, diagnosticText } from "./diagnostic-text.ts"
import { registerA1DiagnosticText } from "./diagnostic-text-a1.ts"
import { StderrMirrorSink } from "./log-stderr.ts"

registerA1DiagnosticText()

type Attrs = Record<string, string | number | boolean | null>
const LEVEL = {
  [Severity.Warning]: "warn",
  [Severity.Debug]: "debug",
  [Severity.Info]: "info",
  [Severity.Error]: "error",
} as const

function ev(severity: keyof typeof LEVEL, source: string, attrs: Attrs): LogEvent {
  return {
    ts: 0,
    severity,
    facility: Facility.User,
    source,
    message: "",
    diagnostic: { source, level: LEVEL[severity], attrs },
  }
}

const CASES: readonly { name: string; e: LogEvent; old: string; tag: string }[] = [
  {
    name: "net-dbg.logger-failure",
    e: ev(Severity.Warning, "net-dbg.logger-failure", { detail: "disk full" }),
    old: "logger failure (further errors suppressed): disk full",
    tag: "WARN",
  },
  {
    name: "config.parse-error",
    e: ev(Severity.Debug, "config.parse-error", { path: "/x/c.jsonc", detail: "bad token" }),
    old: "/x/c.jsonc: bad token",
    tag: "DEBUG",
  },
  {
    name: "network.http3-mode",
    e: ev(Severity.Warning, "network.http3-mode", { mode: "zzz" }),
    old: 'MINIMAL_AGENT_HTTP3="zzz" unrecognized (expected off/opt/force); h3 disabled.',
    tag: "WARN",
  },
  {
    name: "auth.login",
    e: ev(Severity.Debug, "auth.login", { line: "exchange ok" }),
    old: "exchange ok",
    tag: "DEBUG",
  },
  {
    name: "auth.refresh peer-rotated",
    e: ev(Severity.Info, "auth.refresh", { code: "peer-rotated" }),
    old: "peer-process rotated token; retrying with fresh stored value",
    tag: "INFO",
  },
  {
    name: "auth.refresh refreshing",
    e: ev(Severity.Info, "auth.refresh", { code: "refreshing" }),
    old: "access token expired (401); refreshing",
    tag: "INFO",
  },
  {
    name: "auth.refresh stale",
    e: ev(Severity.Error, "auth.refresh", { code: "stale" }),
    old: "401 persists after token refresh; credentials are stale",
    tag: "ERROR",
  },
]

describe("A1 diagnostic text parity", () => {
  for (const c of CASES) {
    test(`${c.name}: text equals the old message`, () => {
      expect(diagnosticText(c.e)).toBe(c.old)
    })
    test(`${c.name}: stderr line equals the old line`, () => {
      const lines: string[] = []
      const bus = createDiagnosticBus()
      new StderrMirrorSink({ write: (l: string) => lines.push(l), level: Severity.Debug }).attach(
        bus,
      )
      bus.emit(c.e)
      expect(lines).toEqual([`[${c.tag}] ${c.e.source}: ${c.old}\n`])
    })
  }

  test("dedupe key: same attrs collapse, other attrs do not", () => {
    const a = ev(Severity.Warning, "network.http3-mode", { mode: "x" })
    const b = ev(Severity.Warning, "network.http3-mode", { mode: "x" })
    const c = ev(Severity.Warning, "network.http3-mode", { mode: "y" })
    expect(diagnosticKey(a)).toBe(diagnosticKey(b))
    expect(diagnosticKey(a)).not.toBe(diagnosticKey(c))
  })
})

describe("A1 dual-write: the old message wins over attrs", () => {
  for (const c of CASES) {
    test(`${c.name}: old message set plus attrs, text and key equal the old string`, () => {
      const e = { ...c.e, message: c.old }
      expect(diagnosticText(e)).toBe(c.old)
      expect(diagnosticKey(e)).toBe(c.old)
    })
  }

  test("message set plus attrs renders the message and keys on it", () => {
    const old = 'MINIMAL_AGENT_HTTP3="x" unrecognized (expected off/opt/force); h3 disabled.'
    const e = { ...ev(Severity.Warning, "network.http3-mode", { mode: "x" }), message: old }
    expect(diagnosticText(e)).toBe(old)
    expect(diagnosticKey(e)).toBe(old)
  })
})
