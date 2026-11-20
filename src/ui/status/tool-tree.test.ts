/**
 * The live tool tree: frames as strings with a fake clock.
 */

import { describe, expect, it } from "bun:test"
import { displayWidth, stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"
import { TOOL_PRESENTATION } from "../../plugins-ui/tool-presentation.ts"
import { effectiveDisplayWidth } from "../../terminal/nerd-glyph-width.ts"
import { ToolCallTracker } from "./tool-calls.ts"
import {
  BLINK_FRAME_MS,
  blinkDot,
  cutMiddle,
  formatToolTime,
  renderToolTree,
  shortTarget,
  shortUrl,
} from "./tool-tree.ts"

const T0 = 1_000_000_000_000 // an even second, so phase 0 shows `●`
const CWD = "/work/proj"

interface Frame {
  tracker: ToolCallTracker
  clock: { now: number }
  start(id: string, name: string, input?: Record<string, unknown>, concurrent?: boolean): void
  render(opts?: { columns?: number; rows?: number; paused?: boolean; fade?: boolean }): string[]
  plain(opts?: { columns?: number; rows?: number; paused?: boolean }): string[]
}

function harness(cap?: number): Frame {
  const clock = { now: T0 }
  const tracker = new ToolCallTracker({ now: () => clock.now })
  tracker.setConcurrencyCap(cap)
  const render: Frame["render"] = (opts = {}) =>
    renderToolTree({
      snapshot: tracker.snapshot(),
      now: clock.now,
      columns: opts.columns ?? 100,
      rows: opts.rows ?? 50,
      ...(opts.paused ? { paused: true } : {}),
      fade: opts.fade ?? false,
      presentation: TOOL_PRESENTATION,
      cwd: CWD,
    })
  return {
    tracker,
    clock,
    start: (id, name, input = {}, concurrent = true) => {
      tracker.queue(id, name, input)
      tracker.start(id, name, input, concurrent)
    },
    render,
    plain: (opts) => render(opts).map(stripAnsi),
  }
}

describe("formatToolTime", () => {
  it("shows seconds, then minutes and seconds", () => {
    expect(formatToolTime(0)).toBe("0s")
    expect(formatToolTime(12_900)).toBe("12s")
    expect(formatToolTime(64_000)).toBe("1m04s")
    expect(formatToolTime(3_720_000)).toBe("1h02m")
  })
})

describe("short targets", () => {
  it("removes the scheme, www. and a trailing slash", () => {
    expect(shortUrl("https://www.npr.org/sections/news/")).toBe("npr.org/sections/news")
    expect(shortUrl("http://apnews.com")).toBe("apnews.com")
  })
  it("shows paths relative to the cwd", () => {
    expect(shortTarget("Read", { file_path: `${CWD}/src/a.ts` }, CWD)).toBe("src/a.ts")
    expect(shortTarget("Read", { file_path: "src/b.ts" }, CWD)).toBe("src/b.ts")
    expect(shortTarget("Read", { file_path: "/etc/hosts" }, CWD)).toBe("/etc/hosts")
  })
  it("shows Grep as `pattern` in path", () => {
    expect(shortTarget("Grep", { pattern: "runToolCalls", path: `${CWD}/src` }, CWD)).toBe(
      '"runToolCalls" in src',
    )
    expect(shortTarget("Grep", { pattern: "x" }, CWD)).toBe('"x"')
  })
  it("cuts long text in the middle with …", () => {
    const cut = cutMiddle("abcdefghijklmnopqrstuvwxyz", 11)
    expect(cut).toBe("abcde…vwxyz")
    expect(displayWidth(cut)).toBe(11)
    expect(cutMiddle("short", 11)).toBe("short")
  })
})

describe("header and rows", () => {
  it("shows the header, rows in call order, and the last row with ╰", () => {
    const h = harness()
    h.start("a", "Fetch", { url: "https://www.npr.org/sections/news/" })
    h.start("b", "Fetch", { url: "https://aljazeera.com" })
    h.start("c", "Read", { file_path: `${CWD}/src/sdk/tool-calls.ts` })
    h.start("d", "Grep", { pattern: "runToolCalls", path: `${CWD}/src/` })
    h.clock.now += 12_000
    expect(h.plain()).toEqual([
      "● Running 4 tools · 12s",
      "├ ○ ⤓ Fetch  npr.org/sections/news",
      "├ ● ⤓ Fetch  aljazeera.com",
      "├ ○ • Read   src/sdk/tool-calls.ts",
      '╰ ● ⌕ Grep   "runToolCalls" in src/',
    ])
  })

  it("has no stray `·` before the first timer tick", () => {
    const h = harness()
    h.start("a", "Fetch", { url: "https://a.com" })
    h.start("b", "Fetch", { url: "https://b.com" })
    const [header] = h.plain()
    expect(header).toBe("● Running 2 tools")
    expect(header?.endsWith("·")).toBe(false)
  })

  it("shows `· K queued` only when K > 0, and the dim ◌ on the side-by-side row", () => {
    const h = harness(2)
    h.tracker.queue("a", "Fetch", { url: "https://a.com" })
    h.tracker.queue("b", "Fetch", { url: "https://b.com" })
    h.tracker.queue("c", "Fetch", { url: "https://c.com" })
    h.tracker.start("a", "Fetch", { url: "https://a.com" }, true)
    h.tracker.start("b", "Fetch", { url: "https://b.com" }, true)
    h.clock.now += 4000
    expect(h.plain()).toEqual([
      "● Running 2 tools · 1 queued · 4s",
      "├ ○ ⤓ Fetch  a.com",
      "├ ● ⤓ Fetch  b.com",
      "╰ ◌ ⤓ c.com",
    ])
    // The queued call starts: it moves up into the list with a blinking dot.
    // The row above it is b (phase 0), so c takes phase 1.
    h.tracker.start("c", "Fetch", { url: "https://c.com" }, true)
    expect(h.plain()).toEqual([
      "● Running 3 tools · 4s",
      "├ ○ ⤓ Fetch  a.com",
      "├ ● ⤓ Fetch  b.com",
      expect.stringMatching(/^╰ ○ ⤓ Fetch {2}c\.com +0s$/),
    ])
  })

  it("shows a row time only when it differs from the header time by 2 s or more", () => {
    const h = harness()
    h.start("a", "Fetch", { url: "https://a.com" })
    h.clock.now += 1000
    h.start("b", "Fetch", { url: "https://b.com" })
    h.clock.now += 11_000
    h.start("c", "Fetch", { url: "https://c.com" })
    h.clock.now += 3000
    // header 15s; a: 15s (hidden); b: 14s (hidden); c: 3s (shown)
    const rows = h.plain()
    expect(rows[0]).toBe("○ Running 3 tools · 15s")
    expect(rows[1]).toMatch(/^├ [●○] ⤓ Fetch {2}a\.com$/)
    expect(rows[2]).toMatch(/^├ [●○] ⤓ Fetch {2}b\.com$/)
    expect(rows[3]).toMatch(/^╰ [●○] ⤓ Fetch {2}c\.com +3s$/)
    h.clock.now += 49_000
    expect(h.plain()[0]).toBe("● Running 3 tools · 1m04s")
  })

  it("counts the header from the oldest call that still runs", () => {
    const h = harness()
    h.start("a", "Fetch", { url: "https://a.com" })
    h.clock.now += 10_000
    h.start("b", "Fetch", { url: "https://b.com" })
    h.start("c", "Fetch", { url: "https://c.com" })
    h.clock.now += 5000
    expect(h.plain()[0]).toBe("○ Running 3 tools · 15s")
    h.tracker.end("a")
    expect(h.plain()[0]).toBe("○ Running 2 tools · 5s")
  })
})

describe("blink phases", () => {
  it("alternates one frame per second, and each row takes the phase opposite to the row above", () => {
    const h = harness()
    for (const [id, host] of [
      ["a", "a.com"],
      ["b", "b.com"],
      ["c", "c.com"],
    ] as const) {
      h.start(id, "Fetch", { url: `https://${host}` })
    }
    const dots = (rows: string[]) =>
      rows.map((row) => (row[0] === "●" || row[0] === "○" ? row[0] : row[2]))
    const first = dots(h.plain())
    expect(first).toEqual(["●", "○", "●", "○"])
    h.clock.now += BLINK_FRAME_MS
    expect(dots(h.plain())).toEqual(["○", "●", "○", "●"])
    h.clock.now += BLINK_FRAME_MS
    expect(dots(h.plain())).toEqual(first)
  })

  it("keeps the phase of a row when a row above it ends", () => {
    const h = harness()
    h.start("a", "Fetch", { url: "https://a.com" })
    h.start("b", "Fetch", { url: "https://b.com" })
    h.start("c", "Fetch", { url: "https://c.com" })
    const before = h.plain().map((row) => row[2])
    // rows: a ○, b ●, c ○
    expect(before.slice(1)).toEqual(["○", "●", "○"])
    h.tracker.end("a")
    const after = h.plain()
    expect(after[1]?.[2]).toBe("●") // b is first now, and keeps ●
    expect(after[2]?.[2]).toBe("○") // c keeps ○
  })

  it("gives a row that starts later the opposite phase of the row above it at its start", () => {
    const h = harness()
    h.start("a", "Fetch", { url: "https://a.com" })
    h.start("b", "Fetch", { url: "https://b.com" })
    h.start("c", "Fetch", { url: "https://c.com" })
    h.tracker.end("b")
    h.start("d", "Fetch", { url: "https://d.com" })
    // d is last, above it is c (phase 0): d takes phase 1.
    const rows = h.plain()
    expect(rows[3]?.[2]).toBe("●")
    expect(rows[2]?.[2]).toBe("○")
  })

  it("fades the ● in truecolor in steps, and only changes the glyph in 16 colors", () => {
    const look = {
      icon: "⤓",
      paint: (t: string) => `\x1b[36m${t}\x1b[39m`,
      rgb: [0, 215, 255] as const,
    }
    const seen = new Set<string>()
    for (let ms = 0; ms < BLINK_FRAME_MS; ms += 50) {
      seen.add(blinkDot(0, T0 + ms, look, true))
    }
    expect(seen.size).toBeGreaterThanOrEqual(4)
    expect(seen.size).toBeLessThanOrEqual(6)
    expect([...seen].every((dot) => dot.includes("38;2;") && stripAnsi(dot) === "●")).toBe(true)
    // 16 colors: no fade, one color for the whole frame.
    const plain = new Set<string>()
    for (let ms = 0; ms < BLINK_FRAME_MS; ms += 50) plain.add(blinkDot(0, T0 + ms, look, false))
    expect(plain.size).toBe(1)
    expect([...plain][0]).not.toContain("38;2;")
    expect(stripAnsi(blinkDot(0, T0 + BLINK_FRAME_MS, look, false))).toBe("○")
  })

  it("never uses the terminal blink code", () => {
    const h = harness()
    h.start("a", "Fetch", { url: "https://a.com" })
    h.start("b", "Fetch", { url: "https://b.com" })
    for (const fade of [true, false]) {
      expect(h.render({ fade }).join("\n")).not.toContain("\x1b[5m")
    }
  })
})

describe("limit", () => {
  const fill = (h: Frame, n: number) => {
    for (let i = 0; i < n; i++) h.start(`c${i}`, "Fetch", { url: `https://site${i}.com` })
  }

  it("shows at most 10 call rows and puts the rest side by side on the last row", () => {
    const h = harness()
    fill(h, 14)
    const rows = h.plain()
    expect(rows[0]).toBe("● Running 14 tools")
    expect(rows.filter((row) => row.startsWith("├"))).toHaveLength(9)
    const last = rows.filter((row) => row.startsWith("╰"))
    expect(last).toHaveLength(1)
    expect(rows.length).toBeLessThanOrEqual(1 + 10 + 1)
    expect(last[0]).toContain("site9.com")
    expect(last[0]).toContain("site13.com")
    expect(rows.join("\n")).not.toMatch(/more/)
  })

  it("keeps fewer rows when a terminal of 20 rows would pass half the height", () => {
    const h = harness()
    fill(h, 14)
    const rows = h.plain({ rows: 20 })
    expect(rows.length).toBeLessThanOrEqual(10)
    expect(rows[0]).toBe("● Running 14 tools")
    expect(rows.at(-1)?.startsWith("╰") || rows.at(-2)?.startsWith("╰")).toBe(true)
  })

  it("uses the same rule for a terminal of 30 rows", () => {
    const h = harness()
    fill(h, 14)
    expect(h.plain({ rows: 30 }).length).toBeLessThanOrEqual(15)
    expect(h.plain({ rows: 30 }).length).toBeGreaterThan(h.plain({ rows: 20 }).length)
  })

  it("wraps the side-by-side row to 2 lines and cuts with …", () => {
    const h = harness()
    fill(h, 40)
    const rows = h.plain({ columns: 60, rows: 20 })
    const start = rows.findIndex((row) => row.startsWith("╰"))
    const side = rows.slice(start)
    expect(side.length).toBeLessThanOrEqual(2)
    expect(side[0]).toMatch(/^╰ [●○] ⤓ site\d+\.com {3}[●○] ⤓/)
    if (side[1]) expect(side[1].startsWith("  ")).toBe(true)
    expect(side.join("")).toContain("…")
    for (const row of rows) expect(effectiveDisplayWidth(row)).toBeLessThanOrEqual(59)
  })

  it("keeps every row inside the width", () => {
    const h = harness()
    h.start("a", "Fetch", { url: `https://${"very-long-host-name.".repeat(8)}example.com/path` })
    h.start("b", "Read", { file_path: `${CWD}/${"deep/".repeat(30)}file.ts` })
    for (const row of h.plain({ columns: 50 })) expect(effectiveDisplayWidth(row)).toBeLessThan(50)
  })
})

describe("one call", () => {
  it("is one row with no tree, and the dot blinks", () => {
    const h = harness()
    h.tracker.queue("a", "Fetch", { url: "https://www.npr.org/sections/news/" })
    h.tracker.start("a", "Fetch", { url: "https://www.npr.org/sections/news/" }, false)
    h.clock.now += 3000
    expect(h.plain()).toEqual(["● Running ⤓ Fetch  npr.org/sections/news · 3s"])
    h.clock.now += BLINK_FRAME_MS
    expect(h.plain()).toEqual(["○ Running ⤓ Fetch  npr.org/sections/news · 4s"])
  })

  it("has no stray `·` in its first second", () => {
    const h = harness()
    h.tracker.start("a", "Fetch", { url: "https://a.com" }, false)
    expect(h.plain()).toEqual(["○ Running ⤓ Fetch  a.com"])
  })

  it("shows a serial call that waits as nothing queued", () => {
    const h = harness(10)
    h.tracker.queue("a", "Bash", { command: "ls" })
    h.tracker.queue("b", "Read", { file_path: "x" })
    h.tracker.start("a", "Bash", { command: "ls" }, false)
    expect(h.plain()).toHaveLength(1)
  })
})

describe("paused", () => {
  it("shows `○ Paused · N tools`, dim ○ rows, and no blink", () => {
    const h = harness()
    h.start("a", "Fetch", { url: "https://a.com" })
    h.start("b", "Read", { file_path: "src/x.ts" })
    h.clock.now += 12_000
    const a = h.plain({ paused: true })
    expect(a).toEqual(["○ Paused · 2 tools · 12s", "├ ○ ⤓ Fetch  a.com", "╰ ○ • Read   src/x.ts"])
    h.clock.now += BLINK_FRAME_MS
    expect(h.plain({ paused: true }).slice(1)).toEqual(a.slice(1))
    expect(h.render({ paused: true }).join("")).toContain("\x1b[2m")
  })
})

describe("tracker", () => {
  it("keeps the queue order and forgets a call when it ends", () => {
    const h = harness()
    h.tracker.queue("a", "Read")
    h.tracker.queue("b", "Read")
    expect(h.tracker.snapshot().running).toHaveLength(0)
    h.tracker.start("b", "Read", {}, true)
    expect(h.tracker.snapshot().running.map((c) => c.id)).toEqual(["b"])
    h.tracker.end("a")
    h.tracker.end("b")
    expect(h.tracker.hasRunning()).toBe(false)
  })

  it("removes the row in the same frame as the block (held, then released)", () => {
    const events: string[] = []
    const h = harness()
    h.tracker.setFrameHooks({ begin: () => events.push("begin"), end: () => events.push("end") })
    h.start("a", "Fetch", { url: "https://a.com" })
    h.start("b", "Fetch", { url: "https://b.com" })
    h.tracker.subscribe(() => events.push("changed"))
    h.tracker.holdFrame()
    events.push("block written")
    h.tracker.end("a")
    expect(events).toEqual(["begin", "block written", "changed", "end"])
    expect(h.plain()).toEqual(["● Running ⤓ Fetch  b.com"])
  })

  it("releases a held frame at reset", () => {
    const events: string[] = []
    const h = harness()
    h.tracker.setFrameHooks({ begin: () => events.push("begin"), end: () => events.push("end") })
    h.tracker.holdFrame()
    h.tracker.reset()
    expect(events).toEqual(["begin", "end"])
  })
})

describe("glyph width", () => {
  it("● ○ ◌ are 1 cell for the layout, so rows line up", () => {
    for (const glyph of ["●", "○", "◌", "├", "╰", "…"]) {
      expect(effectiveDisplayWidth(glyph)).toBe(1)
    }
  })
})
