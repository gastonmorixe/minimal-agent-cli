/**
 * Tests for {@link buildReadyBanner}.
 *
 * Pure string builder : these tests pin the user-visible invariants:
 *
 *   - "status" + "ready" keywords appear together on the first row
 *   - no key hint row (enter/shift+enter/ctrl+c/shift+tab/alt+m)
 *   - trailing `\n\n` is load-bearing (one blank row of breathing room
 *     above whatever follows)
 *   - leading `\n` separates the banner from the startup tree closer
 *     (which ends on a `╰` row with no trailing blank of its own)
 */
import { describe, expect, it } from "bun:test"

import { buildReadyBanner } from "./ready-banner.ts"

const ANSI = /\x1b\[[\d;]*m/g
const strip = (s: string) => s.replace(ANSI, "")

describe("buildReadyBanner", () => {
  it("contains 'status' and 'ready' on the first content row", () => {
    const out = strip(buildReadyBanner())
    const lines = out.split("\n")
    // [0]='' (leading \n), [1]='  status ready'
    expect(lines[1]).toContain("status")
    expect(lines[1]).toContain("ready")
  })

  it("has no key hint row", () => {
    const out = strip(buildReadyBanner())
    for (const hint of ["enter send", "new line", "ctrl+c", "shift+tab", "alt+m", "·"]) {
      expect(out).not.toContain(hint)
    }
  })

  it("begins with a single leading newline (separates from startup tree closer)", () => {
    const out = buildReadyBanner()
    expect(out.startsWith("\n")).toBe(true)
    expect(out.startsWith("\n\n")).toBe(false)
  })

  it("ends with exactly two trailing newlines (one blank row of breathing room)", () => {
    const out = buildReadyBanner()
    expect(out.endsWith("\n\n")).toBe(true)
    expect(out.endsWith("\n\n\n")).toBe(false)
  })

  it("ANSI is non-empty (banner is colored)", () => {
    const raw = buildReadyBanner()
    expect(raw).toMatch(ANSI)
  })
})
