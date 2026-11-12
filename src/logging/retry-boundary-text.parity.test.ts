/**
 * Parity test (S14.4): the host renderer gives the bytes that core used to
 * emit as `text_delta`. Covers the interactive path, open-responses output
 * and the stream-json line.
 *
 * @module logging/retry-boundary-text.parity.test
 */

import { describe, expect, test } from "bun:test"

import type { AgentEvent } from "@minimal-agent/core/sdk/events"

import { retryBoundaryText } from "./retry-boundary-text.ts"

/** The old core marker, inline. */
const oldMarker = (n: number): string => `\n↳ stream stalled — retrying (attempt ${n})…\n`

describe("retryBoundaryText parity", () => {
  test("byte-equal to the old marker", () => {
    for (const n of [2, 3, 10]) {
      expect(retryBoundaryText({ attempt: n })).toBe(oldMarker(n))
      expect(Buffer.from(retryBoundaryText({ attempt: n })).equals(Buffer.from(oldMarker(n)))).toBe(
        true,
      )
    }
  })

  test("typed event renders the same text as the old text_delta carried", () => {
    const ev: AgentEvent = { type: "retry-boundary", id: "1:text", attempt: 2 }
    const old: AgentEvent = { type: "text_delta", id: "1:text", text: oldMarker(2) }
    expect(ev.type === "retry-boundary" ? retryBoundaryText(ev) : "").toBe(
      old.type === "text_delta" ? old.text : "x",
    )
  })
})
