/**
 * Regression tests for "live area repeats into scrollback" (user-reported
 * Nov 13 2026, session a39a4e06, 93 x 13 terminal).
 *
 * Symptom: with a 10-row footer (intercom, quota, schedule, fleet panel)
 * the scrollback filled with copies of the status row, the queue rows and
 * blank rows: one copy per spinner frame, and tool output landed between
 * them.
 *
 * Root cause: the live area was taller than the viewport. Its top rows
 * scrolled above the viewport as the terminal painted them. The erase
 * walk-up (`ESC[nA`) stops at the viewport top, so it could not reach
 * those rows, and each repaint pushed one more copy into scrollback.
 */

import { describe, expect, it } from "bun:test"

import { FakeTTYInput } from "../editor-controller.fixtures.ts"
import { EditorController } from "../editor-controller.ts"
import { FakeTerminal } from "../test-utils/fake-terminal.ts"

import { Compositor } from "./compositor.ts"
import { fitLiveAreaToRows, liveAreaRowBudget } from "./live-area-fit.ts"

const FOOTER = [
  "intercom 6 online",
  "5h 58% 7d 21%",
  "schedule next in 9m44s",
  "fleet 2 running",
  "  A1 research",
  "  A6 live-repro",
  "  A5 live-repro",
  "  A2 scan-core",
  "  A3 scan-plugins",
  "  A4 scan-plugins",
]

function termOutput(term: FakeTerminal, rows: number | undefined = term.rows) {
  return {
    isTTY: true as const,
    columns: term.cols,
    rows,
    write: (s: string) => {
      term.feed(s)
      return true
    },
  }
}

/** status + 2 queue rows + gap + prompt + spacer + footer = 16 rows. */
function busyFrame(tick: number): { lines: string[]; cursor: { row: number; col: number } } {
  const lines = [`STATUS tick ${tick}`, "QUEUED 1", "QUEUED 2", "", "> ", "", ...FOOTER]
  return { lines, cursor: { row: 4, col: 2 } }
}

describe("fitLiveAreaToRows", () => {
  it("returns the input unchanged when it fits", () => {
    const lines = ["a", "b", "c"]
    const cursor = { row: 1, col: 0 }
    expect(fitLiveAreaToRows(lines, cursor, 3)).toEqual({ lines, cursor })
    expect(fitLiveAreaToRows(lines, cursor, Number.POSITIVE_INFINITY)).toEqual({ lines, cursor })
  })

  it("drops bottom rows first and counts them in a marker row", () => {
    const fit = fitLiveAreaToRows(["a", "b", "c", "d", "e", "f"], { row: 1, col: 3 }, 4)
    expect(fit.lines.slice(0, 3)).toEqual(["a", "b", "c"])
    // 3 rows are hidden: d, e, f. The marker takes the place of d.
    expect(fit.lines[3]).toContain("+3 more rows")
    expect(fit.cursor).toEqual({ row: 1, col: 3 })
  })

  it("slides the window down to keep the cursor row", () => {
    const fit = fitLiveAreaToRows(["a", "b", "c", "d", "e", "f"], { row: 4, col: 1 }, 3)
    // Rows c, d, e stay, but f is hidden, so the marker would replace e.
    // e is the cursor row, so the marker is not painted.
    expect(fit.lines).toEqual(["c", "d", "e"])
    expect(fit.cursor).toEqual({ row: 2, col: 1 })
  })

  it("never paints the marker on the cursor row or as the only row", () => {
    expect(fitLiveAreaToRows(["a", "b", "c"], { row: 0, col: 0 }, 1).lines).toEqual(["a"])
    expect(fitLiveAreaToRows(["a", "b", "c"], { row: 1, col: 0 }, 2).lines).toEqual(["a", "b"])
  })

  it("keeps the top rows when there is no cursor", () => {
    const fit = fitLiveAreaToRows(["a", "b", "c", "d"], null, 3)
    expect(fit.lines.slice(0, 2)).toEqual(["a", "b"])
    expect(fit.lines[2]).toContain("+2 more rows")
    expect(fit.cursor).toBeNull()
  })
})

describe("liveAreaRowBudget", () => {
  it("reserves 2 rows for the stream line and the separator", () => {
    expect(liveAreaRowBudget(13)).toBe(11)
    expect(liveAreaRowBudget(24)).toBe(22)
  })

  it("never goes below 1 row", () => {
    expect(liveAreaRowBudget(1)).toBe(1)
    expect(liveAreaRowBudget(2)).toBe(1)
  })

  it("is unlimited when the row count is unknown", () => {
    expect(liveAreaRowBudget(undefined)).toBe(Number.POSITIVE_INFINITY)
    expect(liveAreaRowBudget(0)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("Compositor: live area taller than the viewport", () => {
  it("does not leak live-area rows into scrollback on repaint", () => {
    const term = new FakeTerminal({ cols: 93, rows: 13, scrollbackLimit: 5000 })
    const c = new Compositor({ output: termOutput(term) })
    c.mount()
    for (let i = 0; i < 30; i++) c.writeStream(`history ${i}\n`)

    for (let tick = 0; tick < 20; tick++) {
      const f = busyFrame(tick)
      c.setLiveArea(f.lines, f.cursor)
    }

    expect(term.scrollback.filter((l) => !l.startsWith("history "))).toEqual([])
    // The newest frame is on screen once, with the prompt row visible.
    const screen = term.screen()
    expect(screen.filter((l) => l.startsWith("STATUS"))).toEqual(["STATUS tick 19"])
    expect(screen).toContain(">")
    expect(screen.some((l) => l.includes("more rows"))).toBe(true)
  })

  it("keeps stream output in order with no live-area rows between", () => {
    const term = new FakeTerminal({ cols: 93, rows: 13, scrollbackLimit: 5000 })
    const c = new Compositor({ output: termOutput(term) })
    c.mount()
    const expected: string[] = []
    for (let i = 0; i < 40; i++) {
      const f = busyFrame(i)
      c.setLiveArea(f.lines, f.cursor)
      c.writeStream(`tool row ${i}\n`)
      expected.push(`tool row ${i}`)
    }
    c.unmount()

    const text = [...term.scrollback, ...term.screen()]
    expect(text.filter((l) => l.startsWith("tool row"))).toEqual(expected)
    // Only the last frame stays, where unmount left it.
    expect(text.filter((l) => l.startsWith("STATUS")).length).toBe(1)
    // No blank row between 2 stream rows.
    const first = text.indexOf("tool row 0")
    const last = text.indexOf("tool row 39")
    expect(text.slice(first, last + 1)).toEqual(expected)
  })

  it("holds when a partial stream line sits above the live area", () => {
    // Worst case for the row reserve: the stream line is mid-line, so the
    // compositor owns that row, a separator row, and the live area.
    const term = new FakeTerminal({ cols: 93, rows: 13, scrollbackLimit: 5000 })
    const c = new Compositor({ output: termOutput(term) })
    c.mount()
    for (let i = 0; i < 30; i++) c.writeStream(`history ${i}\n`)
    c.writeStream("partial")
    for (let tick = 0; tick < 10; tick++) {
      const f = busyFrame(tick)
      c.setLiveArea(f.lines, f.cursor)
    }
    c.writeStream(" line done\n")

    const text = [...term.scrollback, ...term.screen()]
    expect(text.filter((l) => l.startsWith("STATUS")).length).toBe(1)
    expect(text).toContain("partial line done")
  })

  it("shows the full live area again when the viewport grows", () => {
    const term = new FakeTerminal({ cols: 93, rows: 30, scrollbackLimit: 5000 })
    const out = termOutput(term, 13)
    const c = new Compositor({ output: out })
    c.mount()
    const f = busyFrame(0)
    c.setLiveArea(f.lines, f.cursor)
    expect(c.liveHeight).toBe(11)
    out.rows = 30
    c.setLiveArea(f.lines, f.cursor)
    expect(c.liveHeight).toBe(16)
    expect(term.screen().some((l) => l.includes("more rows"))).toBe(false)
  })

  it("does not clip when the row count is unknown", () => {
    const prev = process.env.LINES
    delete process.env.LINES
    try {
      const term = new FakeTerminal({ cols: 93, rows: 40, scrollbackLimit: 5000 })
      const c = new Compositor({ output: termOutput(term, 0) })
      c.mount()
      const f = busyFrame(0)
      c.setLiveArea(f.lines, f.cursor)
      expect(c.liveHeight).toBe(16)
    } finally {
      if (prev !== undefined) process.env.LINES = prev
    }
  })

  it("reads $LINES when the output reports no row count", () => {
    const prev = process.env.LINES
    process.env.LINES = "13"
    try {
      const term = new FakeTerminal({ cols: 93, rows: 13, scrollbackLimit: 5000 })
      const c = new Compositor({ output: termOutput(term, 0) })
      c.mount()
      for (let tick = 0; tick < 5; tick++) {
        const f = busyFrame(tick)
        c.setLiveArea(f.lines, f.cursor)
      }
      expect(c.liveHeight).toBe(11)
      expect(term.scrollback).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.LINES
      else process.env.LINES = prev
    }
  })
})

describe("EditorController: tall footer on a short terminal", () => {
  it("leaves a clean scrollback across status, queue and footer repaints", () => {
    const term = new FakeTerminal({ cols: 93, rows: 13, scrollbackLimit: 5000 })
    const output = termOutput(term)
    const compositor = new Compositor({ output })
    compositor.mount()
    const stdin = new FakeTTYInput()
    const ctrl = new EditorController({
      exitFn: () => {},
      prompt: "> ",
      continuationPrompt: "  ",
      compositor,
      // biome-ignore lint/suspicious/noExplicitAny: test harness wiring
      stdin: stdin as any,
      // biome-ignore lint/suspicious/noExplicitAny: test harness wiring
      output: output as any,
      maxLiveHeight: () => Math.max(2, Math.floor(term.rows / 2)),
      resizeDebounceMs: 0,
    })
    ctrl.start()
    try {
      for (let i = 0; i < 30; i++) compositor.writeStream(`history ${i}\n`)
      ctrl.setFooterLines(FOOTER)
      ctrl.setDecorationLines(["QUEUED 1", "QUEUED 2"])
      for (let tick = 0; tick < 20; tick++) {
        ctrl.setStatus(`STATUS tick ${tick}`)
        compositor.writeStream(`tool row ${tick}\n`)
      }
      // Idle: the status row is reserved but blank, and the footer ticks.
      ctrl.setStatus(null)
      ctrl.setDecorationLines([])
      for (let tick = 0; tick < 20; tick++) {
        ctrl.setFooterLines([`schedule next in ${tick}s`, ...FOOTER.slice(1)])
      }

      const stream = term.scrollback.filter((l) => /^(history|tool row) /.test(l))
      expect(term.scrollback).toEqual(stream)
      expect(term.screen().some((l) => l.startsWith(">"))).toBe(true)
    } finally {
      ctrl.stop()
    }
  })
})
