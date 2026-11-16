/**
 * The CLI renders `CompactNoProviderError` with its own host renderer, so
 * `/compact` does not show an empty reason ("compact failed: ").
 */
import { describe, expect, test } from "bun:test"

import { CompactNoProviderError } from "@minimal-agent/core/errors"

import { COMPACT_NO_PROVIDER_TEXT, createCliErrorRegistry, errorText } from "./core-text.ts"

describe("CompactNoProviderError CLI text", () => {
  test("errorText names the missing text id and the tail fallback", () => {
    const err = new CompactNoProviderError("local")
    expect(err.message).toBe("")
    const text = errorText(err)
    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain("compact.summary_system")
    expect(text).toContain("/compact tail")
    expect(text).toBe(COMPACT_NO_PROVIDER_TEXT)
  })

  test("the CLI registry renders the JSON form", () => {
    const json = new CompactNoProviderError("local").toJSON()
    expect(createCliErrorRegistry().render(json)).toBe(COMPACT_NO_PROVIDER_TEXT)
  })
})
