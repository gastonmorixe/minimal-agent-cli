/**
 * `routeDiagnosticsThroughCompositor`: a `⚠ warn` block never joins the open
 * row of a streaming response.
 *
 * The scrollback sink writes to stderr. The stdio interceptor forwards that
 * to `compositor.writeStream`, which appends at the stream cursor. While a
 * response streams, the cursor is at the end of the last response row (the
 * newline comes at the end of the turn), so the block began on that row:
 *
 *   Hi again! What would you like to work on? ...  ⚠ warn  cache.anomaly · 08:08:25
 *
 * These tests run the real chain: bus, sink, compositor, and a headless
 * terminal that shows what the user would see.
 */

import { describe, expect, it } from "bun:test"
import {
  createDiagnosticBus,
  Facility,
  type LogEvent,
  Severity,
} from "@minimal-agent/core/host/diagnostics"

import { FakeTerminal } from "../test-utils/fake-terminal.ts"
import { Compositor } from "../ui/compositor.ts"
import { ScrollbackDiagnosticSink, type ScrollbackSinkOptions } from "../ui/status/scrollback.ts"
import { routeDiagnosticsThroughCompositor } from "./diagnostic-sinks.ts"

const T0 = Date.UTC(2026, 10, 18, 13, 8, 25)

const RESPONSE =
  "Hi again! What would you like to work on? I can help with code, files and other tasks."

/** The warning of the report: the cache plugin, with its `code` data row. */
function warning(over: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: T0,
    severity: Severity.Warning,
    facility: Facility.User,
    source: "cache.anomaly",
    message: "cache: turn 1 wrote 22106 tokens to cache but turn 2 read 0.",
    structuredData: { code: "no_read_after_write" },
    ...over,
  }
}

/**
 * A compositor on a headless terminal, and a sink on the bus. The sink starts
 * on the route the live-area REPL has by default: it writes to stderr, and the
 * stdio interceptor hands that to `compositor.writeStream`.
 */
function rig(opts: { cols?: number; sink?: ScrollbackSinkOptions } = {}) {
  const cols = opts.cols ?? 100
  const term = new FakeTerminal({ cols, rows: 16, scrollbackLimit: 100 })
  const compositor = new Compositor({
    output: {
      isTTY: true,
      columns: cols,
      rows: 16,
      write: (s: string) => {
        term.feed(s)
        return true
      },
    },
  })
  compositor.mount()
  compositor.setLiveArea(["❯ "], { row: 0, col: 2 })

  const sink = new ScrollbackDiagnosticSink({
    write: (s) => compositor.writeStream(s),
    now: () => T0,
    ...opts.sink,
  })
  const bus = createDiagnosticBus()
  sink.attach(bus)
  return { term, compositor, sink, bus }
}

/** The rows of the scrollback and the screen, trailing blanks dropped. */
const rowsOf = (term: FakeTerminal) => [...term.scrollback, ...term.screen()]

describe("routeDiagnosticsThroughCompositor", () => {
  it("without the route, a warning joins the open row (the reported bug)", () => {
    const { term, compositor, bus } = rig()
    compositor.writeStream(`\n${RESPONSE}`) // no newline yet: the response row is open
    bus.emit(warning())

    const row = rowsOf(term).find((l) => l.includes("Hi again!"))
    expect(row).toContain("⚠ warn")
  })

  it("a warning during a streaming response waits for the row, then starts on rows of its own", () => {
    const { term, compositor, sink, bus } = rig()
    routeDiagnosticsThroughCompositor(sink, compositor)
    compositor.writeStream(`\n${RESPONSE}`) // no newline yet: the response row is open
    bus.emit(warning())

    // While the row is open the block is not on screen, and the response row is intact.
    expect(rowsOf(term).some((l) => l.includes("⚠ warn"))).toBe(false)
    expect(rowsOf(term)).toContain(RESPONSE)

    // The row ends (the next line feed, or the end of the turn): the block follows it.
    compositor.writeStream("\n")
    const rows = rowsOf(term)
    const response = rows.indexOf(RESPONSE)
    expect(response).toBeGreaterThanOrEqual(0)
    // The block is on the very next rows, in order, with no blank row between.
    expect(rows[response + 1]).toMatch(/^ {2}⚠ warn {2}cache\.anomaly · \d\d:\d\d:\d\d$/)
    expect(rows[response + 2]).toBe(
      "  │ cache: turn 1 wrote 22106 tokens to cache but turn 2 read 0.",
    )
    expect(rows[response + 3]).toBe("  ╰ code: no_read_after_write")
  })

  it("the end of a turn writes a block that still waits", () => {
    const { term, compositor, sink, bus } = rig()
    routeDiagnosticsThroughCompositor(sink, compositor)
    compositor.writeStream(`\n${RESPONSE}`)
    bus.emit(warning())

    compositor.flushStream() // what the REPL does when the turn's formatter has ended
    const rows = rowsOf(term)
    const response = rows.indexOf(RESPONSE)
    expect(response).toBeGreaterThanOrEqual(0)
    expect(rows[response + 1]).toContain("⚠ warn")
  })

  it("a warning after a closed row adds no blank row", () => {
    const { term, compositor, sink, bus } = rig()
    routeDiagnosticsThroughCompositor(sink, compositor)
    compositor.writeStream(`\n${RESPONSE}\n`) // the row is closed
    bus.emit(warning())

    const rows = rowsOf(term)
    const response = rows.indexOf(RESPONSE)
    expect(response).toBeGreaterThanOrEqual(0)
    expect(rows[response + 1]).toContain("⚠ warn")
  })

  it("a warning before any output takes the first row, with no blank row above it", () => {
    const { term, compositor, sink, bus } = rig()
    routeDiagnosticsThroughCompositor(sink, compositor)
    bus.emit(warning())

    expect(rowsOf(term)[0]).toContain("⚠ warn")
  })

  it("an error (✗) block follows the open row too", () => {
    const { term, compositor, sink, bus } = rig()
    routeDiagnosticsThroughCompositor(sink, compositor)
    compositor.writeStream(`\n${RESPONSE}`)
    bus.emit(
      warning({
        severity: Severity.Error,
        source: "auth.refresh",
        message: "invalid_grant",
        structuredData: undefined,
      }),
    )
    compositor.writeStream("\n")

    const rows = rowsOf(term)
    const response = rows.indexOf(RESPONSE)
    expect(response).toBeGreaterThanOrEqual(0)
    expect(rows[response + 1]).toContain("✗ error")
  })

  it("the `(×N)` repeat line follows its row too", () => {
    let clock = T0
    const { term, compositor, sink, bus } = rig({
      sink: { now: () => clock, dedupRepaintMinMs: 0 },
    })
    routeDiagnosticsThroughCompositor(sink, compositor)

    compositor.writeStream(`\n${RESPONSE}`)
    bus.emit(warning()) // the full block: it waits for the row
    compositor.writeStream("\nmore text") // the row ends, the block is written, the response goes on
    clock += 1000
    bus.emit(warning()) // same tuple inside the window: the compact line, waiting again
    compositor.writeStream("\n") // that row ends

    const rows = rowsOf(term)
    const repeat = rows.findIndex((l) => l.includes("(×2"))
    expect(repeat).toBeGreaterThanOrEqual(0)
    expect(rows[repeat]?.startsWith("  ⚠ warn")).toBe(true)
    // The text that streamed after the first block is on its own row, right above it.
    expect(rows[repeat - 1]).toBe("more text")
  })

  it("the live area stays below the block, once", () => {
    const { term, compositor, sink, bus } = rig()
    routeDiagnosticsThroughCompositor(sink, compositor)
    compositor.writeStream(`\n${RESPONSE}`)
    bus.emit(warning())
    compositor.writeStream("\n")

    const rows = rowsOf(term)
    const closer = rows.findIndex((l) => l.includes("╰ code: no_read_after_write"))
    const prompts = rows.map((l, i) => (l.startsWith("❯") ? i : -1)).filter((i) => i >= 0)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toBeGreaterThan(closer)
  })

  it("the restore function sends the sink back to the writer it had", () => {
    const original: string[] = []
    const { term, compositor, sink, bus } = rig({ sink: { write: (s) => original.push(s) } })
    const restore = routeDiagnosticsThroughCompositor(sink, compositor)

    bus.emit(warning({ message: "first" }))
    expect(original).toEqual([])
    expect(rowsOf(term).some((l) => l.includes("│ first"))).toBe(true)

    restore()
    bus.emit(warning({ message: "second" })) // a different message: not a repeat
    expect(original).toHaveLength(1)
    expect(original[0]).toContain("second")
  })

  it("a null sink (protocol mode) is a no-op and returns a callable restore", () => {
    const blocks: string[] = []
    const restore = routeDiagnosticsThroughCompositor(null, { writeBlock: (t) => blocks.push(t) })

    expect(typeof restore).toBe("function")
    expect(() => restore()).not.toThrow()
    expect(blocks).toEqual([])
  })

  it("hands each rendered chunk to writeBlock, with its trailing newline", () => {
    const blocks: string[] = []
    const sink = new ScrollbackDiagnosticSink({ write: () => {}, now: () => T0 })
    routeDiagnosticsThroughCompositor(sink, { writeBlock: (t) => blocks.push(t) })
    sink.onEvent(warning())

    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.endsWith("\n")).toBe(true)
    expect(blocks[0]).toContain("cache.anomaly")
  })
})
