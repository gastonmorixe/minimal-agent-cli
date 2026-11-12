/**
 * Parity test (system prompt base diagnostics): the registry renders the two
 * new typed warn sources from attrs when the message is empty. These events
 * have no old core sentence, so the expected strings are inline literals of
 * the new text design. The renderer is not used to build any expectation.
 *
 * @module logging/diagnostic-text-prompt.parity.test
 */

import { describe, expect, test } from "bun:test"

import { Facility, type LogEvent, Severity } from "@minimal-agent/core/host/diagnostics"

import { diagnosticKey, diagnosticText } from "./diagnostic-text.ts"
import { registerPromptDiagnosticText } from "./diagnostic-text-prompt.ts"

registerPromptDiagnosticText()

type Attrs = Record<string, string | number | boolean | null>

function ev(source: string, attrs: Attrs, message = ""): LogEvent {
  return {
    ts: 0,
    severity: Severity.Warning,
    facility: Facility.User,
    source,
    message,
    diagnostic: { source, level: "warn", attrs },
  }
}

const LOAD = "prompt.system_base_load_failed"
const CONFLICT = "prompt.system_base_slot_conflict"
const load = (attrs: Attrs, message = ""): LogEvent =>
  ev(LOAD, { packageDir: "/p/plugin", abs: "/p/plugin/base.ts", ...attrs }, message)
const conflict = (attrs: Attrs, message = ""): LogEvent =>
  ev(CONFLICT, { slot: "identity", owner: "a", refused: "b", ...attrs }, message)

describe("prompt.system_base_load_failed: text from attrs", () => {
  test("module_not_found", () => {
    expect(diagnosticText(load({ code: "module_not_found", reason: "" }))).toBe(
      "/p/plugin: systemPromptBase failed: module not found: /p/plugin/base.ts",
    )
  })
  test("no_provider_export", () => {
    expect(diagnosticText(load({ code: "no_provider_export", reason: "" }))).toBe(
      "/p/plugin: systemPromptBase failed: /p/plugin/base.ts has no provider export",
    )
  })
  test("load_failed with reason", () => {
    expect(diagnosticText(load({ code: "load_failed", reason: "SyntaxError" }))).toBe(
      "/p/plugin: systemPromptBase failed: SyntaxError",
    )
  })
  test("load_failed with empty reason", () => {
    expect(diagnosticText(load({ code: "load_failed", reason: "" }))).toBe(
      "/p/plugin: systemPromptBase failed: load failed",
    )
  })
})

describe("prompt.system_base_slot_conflict: text from attrs", () => {
  test("identity", () => {
    expect(diagnosticText(conflict({}))).toBe(
      'system prompt slot "identity" is owned by plugin "a": plugin "b" was refused',
    )
  })
  test("tone", () => {
    expect(diagnosticText(conflict({ slot: "tone" }))).toBe(
      'system prompt slot "tone" is owned by plugin "a": plugin "b" was refused',
    )
  })
})

describe("load_failed unknown or missing code: generic fallback", () => {
  test("unknown code", () => {
    expect(diagnosticText(ev(LOAD, { code: "zzz", packageDir: "/p" }))).toBe(
      "code=zzz packageDir=/p",
    )
  })
  test("missing code", () => {
    expect(diagnosticText(ev(LOAD, { packageDir: "/p", abs: "/a" }))).toBe("abs=/a packageDir=/p")
  })
})

describe("message set: printed unchanged", () => {
  test("load_failed", () => {
    expect(diagnosticText(load({ code: "load_failed", reason: "" }, "hello"))).toBe("hello")
  })
  test("slot_conflict", () => {
    expect(diagnosticText(conflict({}, "hello"))).toBe("hello")
  })
})

describe("dedupe key", () => {
  test("slot_conflict with different refused differ", () => {
    expect(diagnosticKey(conflict({ refused: "b" }))).not.toBe(
      diagnosticKey(conflict({ refused: "c" })),
    )
  })
  test("load_failed with the same attrs are equal", () => {
    const a = load({ code: "load_failed", reason: "SyntaxError" })
    const b = load({ code: "load_failed", reason: "SyntaxError" })
    expect(diagnosticKey(a)).toBe(diagnosticKey(b))
  })
})
