/**
 * The CLI renders `LifecycleDeniedError` (15e.2) from its fields. Core holds
 * no deny text and the error message is "", so a host must never show an
 * empty line, also when the hook gave no reason.
 */
import { describe, expect, test } from "bun:test"

import { LifecycleDeniedError } from "@minimal-agent/core/errors"

import {
  createCliErrorRegistry,
  errorEventText,
  errorText,
  failureText,
  lifecycleDeniedText,
} from "./core-text.ts"

describe("LifecycleDeniedError CLI text", () => {
  test("a deny with no reason renders a non-empty line with the hook name", () => {
    const err = new LifecycleDeniedError({ hook: "message.willSend" })
    expect(err.message).toBe("")
    const text = errorText(err)
    expect(text).toBe("The message.willSend hook denied the operation.")
  })

  test("the reason, plugin id and tool come from the fields", () => {
    const err = new LifecycleDeniedError({
      hook: "tool.didBatch",
      reason: "tests fail",
      pluginId: "acme",
      tool: "Bash",
    })
    expect(errorText(err)).toBe(
      "The tool.didBatch hook denied the operation (plugin acme) for the tool Bash: tests fail",
    )
  })

  test("a failed approval hook names the label and the detail, no invented reason", () => {
    const err = new LifecycleDeniedError({
      hook: "compact.willRun",
      failure: { label: "user:gate", detail: "timeout" },
    })
    expect(errorText(err)).toBe(
      'The compact.willRun hook denied the operation. The approval hook "user:gate" failed (timeout).',
    )
    const noLabel = new LifecycleDeniedError({
      hook: "compact.willRun",
      failure: { detail: "bus broke" },
    })
    expect(errorText(noLabel)).toBe(
      "The compact.willRun hook denied the operation. The approval hook failed (bus broke).",
    )
  })

  test("the error event (message '') renders the same line", () => {
    const json = new LifecycleDeniedError({ hook: "tool.didBatch" }).toJSON()
    const text = errorEventText({ message: "", error: { kind: json.kind, fields: json.fields } })
    expect(text).toBe("The tool.didBatch hook denied the operation.")
    expect(text.length).toBeGreaterThan(0)
  })

  test("a compact failure line is never empty", () => {
    const err = new LifecycleDeniedError({ hook: "compact.willRun" })
    expect(failureText("compact failed", err)).toBe(
      "compact failed: The compact.willRun hook denied the operation.",
    )
  })

  test("the CLI registry renders the JSON form", () => {
    const json = new LifecycleDeniedError({ hook: "message.willSend", reason: "secrets" }).toJSON()
    expect(createCliErrorRegistry().render(json)).toBe(lifecycleDeniedText(json))
    expect(lifecycleDeniedText(json)).toBe(
      "The message.willSend hook denied the operation: secrets",
    )
  })

  test("an error event of a kind with no CLI text and message '' shows the kind", () => {
    expect(errorEventText({ message: "", error: { kind: "SomeNewError", fields: {} } })).toBe(
      "SomeNewError",
    )
  })
})
