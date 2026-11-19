import { describe, expect, it } from "bun:test"

import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"

import {
  fitDisplayWidth,
  fitDisplayWidthLeft,
  formatBytes,
  formatCost,
  formatCwd,
  formatDayLabel,
  formatDuration,
  formatLocalTime,
  formatRelativeAge,
  formatTokenCount,
  padEndDisplay,
  padStartDisplay,
  sliceDisplayWidth,
  toCellText,
} from "./index.ts"

const S = 1000
const M = 60 * S
const H = 60 * M
const D = 24 * H

describe("formatTokenCount", () => {
  it.each([
    [0, "0"],
    [847, "847"],
    [1000, "1k"],
    [4300, "4.3k"],
    [102_900, "102.9k"],
    [999_999, "1M"],
    [1_200_000, "1.2M"],
    [10_700_000, "10.7M"],
    [-1, "—"],
    [Number.NaN, "—"],
  ])("%p → %p", (n, out) => expect(formatTokenCount(n)).toBe(out))

  // Review item 1: rounding must not stay in a unit at its boundary.
  // Review item 9: a B step after M.
  it.each([
    [999.4, "999"],
    [999.5, "1k"],
    [999_949, "999.9k"],
    [999_950, "1M"],
    [999_949_999, "999.9M"],
    [999_950_000, "1B"],
    [3_400_000_000, "3.4B"],
    [1e12, "1000B"],
  ])("rounds across the unit boundary: %p → %p", (n, out) => expect(formatTokenCount(n)).toBe(out))
})

describe("formatBytes", () => {
  it.each([
    [312, "312 B"],
    [499_098, "487.4 kB"],
    [2.3 * 1024 * 1024, "2.3 MB"],
    [1.25 * 1024 ** 3, "1.25 GB"],
    [-5, "—"],
  ])("%p → %p", (n, out) => expect(formatBytes(n)).toBe(out))

  // Review item 1: a value just below a unit reads in the next unit.
  it.each([
    [1023.4, "1023 B"],
    [1023.6, "1.0 kB"],
    [1024 * 1024 - 1, "1.0 MB"],
    [1024 ** 3 - 1, "1.00 GB"],
    [1024 ** 4, "1024.00 GB"],
  ])("rounds across the unit boundary: %p → %p", (n, out) => expect(formatBytes(n)).toBe(out))
})

describe("formatCost", () => {
  it.each([
    [0, "$0.00"],
    [0.001, "<$0.01"],
    [0.02, "$0.02"],
    [6.123, "$6.12"],
    [1234.5, "$1,234.50"],
    [Number.POSITIVE_INFINITY, "—"],
  ])("%p → %p", (n, out) => expect(formatCost(n)).toBe(out))

  // Review item 8: `-0` is zero, not a negative cost.
  it("prints -0 as $0.00", () => {
    expect(formatCost(-0)).toBe("$0.00")
    expect(formatCost(0.004 - 0.004)).toBe("$0.00")
  })
})

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [48 * S, "48s"],
    [4 * M, "4m"],
    [3 * M + 40 * S, "3m40s"],
    [9 * M + 2 * S, "9m02s"],
    [21 * M + 30 * S, "21m"],
    [2 * H + 5 * M, "2h05m"],
    [3 * D + 4 * H, "3d04h"],
    [-1, "—"],
  ])("%p ms → %p", (ms, out) => expect(formatDuration(ms)).toBe(out))
})

describe("formatRelativeAge", () => {
  const now = Date.UTC(2026, 10, 19, 15, 0, 0)
  it.each([
    [now + 10 * S, "now"],
    [now - 2 * S, "now"],
    [now - 40 * S, "40s ago"],
    [now - 5 * M, "5m ago"],
    [now - 3 * H, "3h ago"],
    [now - 2 * D, "2d ago"],
    [now - 35 * D, "5w ago"],
    [now - 400 * D, "1y ago"],
  ])("%p → %p", (at, out) => expect(formatRelativeAge(at, { now })).toBe(out))

  // Review item 2: a bad clock gives the placeholder, not "NaNy ago".
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 9e15])("now=%p → —", (bad) => {
    expect(formatRelativeAge(now, { now: bad })).toBe("—")
  })
})

describe("formatLocalTime / formatDayLabel with an injected zone", () => {
  // 2026-11-19 13:33 UTC = 08:33 in New York (EST, UTC-5).
  const now = Date.UTC(2026, 10, 19, 15, 0, 0)
  const ny = { now, timeZone: "America/New_York" }

  it("formats HH:MM in the zone", () => {
    expect(formatLocalTime(Date.UTC(2026, 10, 19, 13, 33), ny)).toBe("08:33")
    expect(formatLocalTime(Date.UTC(2026, 10, 19, 13, 33), { timeZone: "UTC" })).toBe("13:33")
    expect(formatLocalTime(Date.UTC(2026, 10, 19, 5, 0), ny)).toBe("00:00")
  })

  it("labels today, yesterday and older days in the zone", () => {
    expect(formatDayLabel(Date.UTC(2026, 10, 19, 13, 33), ny)).toBe("today")
    // 03:10 UTC on Nov 19 is 22:10 on Nov 18 in New York.
    expect(formatDayLabel(Date.UTC(2026, 10, 19, 3, 10), ny)).toBe("yesterday")
    expect(formatDayLabel(Date.UTC(2026, 10, 19, 3, 10), { now, timeZone: "UTC" })).toBe("today")
    expect(formatDayLabel(Date.UTC(2026, 10, 18, 3, 10), ny)).toBe("Tue Nov 17")
    expect(formatDayLabel(Date.UTC(2025, 11, 30, 18), ny)).toBe("Tue Dec 30 2025")
  })

  // Review item 2: no RangeError from Intl for a bad clock, time or zone.
  it("gives — for a now or a time that Intl cannot format", () => {
    const at = Date.UTC(2026, 10, 19, 13, 33)
    expect(formatDayLabel(at, { now: Number.NaN })).toBe("—")
    expect(formatDayLabel(at, { now: Number.NEGATIVE_INFINITY })).toBe("—")
    expect(formatDayLabel(9e15, ny)).toBe("—")
    expect(formatLocalTime(9e15, ny)).toBe("—")
  })

  it("uses the host zone for a zone that Intl rejects", () => {
    const at = Date.UTC(2026, 10, 19, 13, 33)
    const bad = { now, timeZone: "Not/AZone" }
    expect(() => formatLocalTime(at, bad)).not.toThrow()
    expect(formatLocalTime(at, bad)).toBe(formatLocalTime(at, { now }))
    expect(formatDayLabel(at, bad)).toBe(formatDayLabel(at, { now }))
    expect(formatLocalTime(at, { timeZone: "" })).toBe(formatLocalTime(at))
  })
})

describe("display-width text helpers", () => {
  it("fits and pads by cells, not UTF-16 units", () => {
    expect(fitDisplayWidth("日本語テキスト", 7)).toBe("日本語…")
    expect(displayWidth(fitDisplayWidth("🙂🙂🙂🙂", 5))).toBeLessThanOrEqual(5)
    expect(fitDisplayWidthLeft("abc/日本/def", 7)).toBe("…本/def")
    expect(sliceDisplayWidth("日本語", 5)).toBe("日本")
    expect(padEndDisplay("日本", 6)).toBe("日本  ")
    expect(padStartDisplay("🙂", 4)).toBe("  🙂")
  })

  it("removes SGR and control characters from cell text", () => {
    expect(toCellText("\u001b[31ma\u001b[0m\tb\nc")).toBe("a b c")
  })

  // Review item 4: OSC 8 hyperlinks and bidi controls do not reach a cell.
  it("removes OSC 8 hyperlinks with BEL or ST ends", () => {
    const bel = "\u001b]8;;https://x.test/a\u0007link\u001b]8;;\u0007"
    const st = "\u001b]8;id=1;https://x.test/b\u001b\\link\u001b]8;;\u001b\\"
    expect(toCellText(bel)).toBe("link")
    expect(toCellText(st)).toBe("link")
    expect(toCellText("a\u009d0;title\u009cb")).toBe("ab")
    expect(toCellText("a\u001b]0;open\u001b[31mb")).toBe("ab")
    expect(toCellText("a\u001b]8;;no-end")).toBe("a")
  })

  it("removes bidi embedding, override and isolate controls", () => {
    expect(toCellText("a\u202eevil\u202cb\u2066c\u2069\u202a\u202b\u202d\u2067\u2068")).toBe(
      "aevilbc",
    )
  })
})

describe("formatCwd", () => {
  const home = "/Users/user"
  it("collapses $HOME", () => {
    expect(formatCwd("/Users/user", 20, { home })).toBe("~")
    expect(formatCwd("/Users/user/Projects/x", 20, { home })).toBe("~/Projects/x")
    expect(formatCwd("/Users/userx/p", 20, { home })).toBe("/Users/userx/p")
  })

  it("truncates on the left by display width", () => {
    const cwd = "/Users/user/Projects/日本語/minimal-agent"
    expect(formatCwd(cwd, 17, { home })).toBe("…語/minimal-agent")
    // A wide glyph that does not fit stays out; the result is one cell short.
    expect(formatCwd(cwd, 16, { home })).toBe("…/minimal-agent")
    for (let w = 1; w < 40; w++)
      expect(displayWidth(formatCwd(cwd, w, { home }))).toBeLessThanOrEqual(w)
  })
})
