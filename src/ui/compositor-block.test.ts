/**
 * `Compositor.writeBlock`: scrollback text that must not join a streamed row.
 *
 * A streamed response has no trailing newline until its row is complete, so
 * the stream cursor sits mid-row while the text streams. `writeStream` appends
 * there, which is right for the response and wrong for a self-contained block
 * such as a `⚠ warn` diagnostic: the block joined the last line of the
 * response. `writeBlock` holds the block until the row is complete.
 *
 * Why it waits and does not end the row itself: see compositor-block.mdstream.test.ts.
 */

import { describe, expect, it } from "bun:test"

import { FakeTerminal } from "../test-utils/fake-terminal.ts"

import { Compositor } from "./compositor.ts"

const BLOCK = "  ⚠ warn  cache.anomaly\n  ╰ no read after write\n"

function mounted(cols = 40, rows = 12) {
  const term = new FakeTerminal({ cols, rows, scrollbackLimit: 100 })
  const writes: string[] = []
  const c = new Compositor({
    output: {
      isTTY: true,
      columns: cols,
      rows,
      write: (s: string) => {
        writes.push(s)
        term.feed(s)
        return true
      },
    },
  })
  c.mount()
  c.setLiveArea(["❯ "], { row: 0, col: 2 })
  return { term, c, writes }
}

/** The rows of the scrollback and the screen. */
const allRows = (term: FakeTerminal) => [...term.scrollback, ...term.screen()]

/** Index of the first row that contains `text`, or -1. */
const rowOf = (term: FakeTerminal, text: string) => allRows(term).findIndex((l) => l.includes(text))

describe("Compositor.writeBlock", () => {
  it("writeStream keeps appending to an open row (the contract writeBlock sits beside)", () => {
    const { term, c } = mounted()
    c.writeStream("Hi there")
    c.writeStream(" and more\n")
    expect(allRows(term)).toContain("Hi there and more")
  })

  it("holds the block while the response row is open", () => {
    const { term, c } = mounted()
    c.writeStream("\nHi again! What can I do?")
    c.writeBlock(BLOCK)

    // Nothing of the block is on screen, and the response row is intact.
    expect(rowOf(term, "⚠ warn")).toBe(-1)
    expect(allRows(term)).toContain("Hi again! What can I do?")
  })

  it("writes the block on rows of its own once the response row ends", () => {
    const { term, c } = mounted()
    c.writeStream("\nHi again!")
    c.writeBlock(BLOCK)
    c.writeStream(" What can I do?\n")

    const text = rowOf(term, "Hi again! What can I do?")
    expect(allRows(term)[text]).toBe("Hi again! What can I do?")
    // The block is right under it: no blank row in between.
    expect(rowOf(term, "⚠ warn")).toBe(text + 1)
    expect(rowOf(term, "╰ no read after write")).toBe(text + 2)
  })

  it("writes a block at once, with no blank row above it, when the row is already closed", () => {
    const { term, c } = mounted()
    c.writeStream("\nDone.\n")
    c.writeBlock(BLOCK)

    expect(rowOf(term, "⚠ warn")).toBe(rowOf(term, "Done.") + 1)
  })

  it("takes the first row when nothing was written yet", () => {
    const { term, c } = mounted()
    c.writeBlock(BLOCK)

    expect(allRows(term)[0]).toContain("⚠ warn")
  })

  it("keeps a row that wrapped at the terminal width open until its line feed", () => {
    const { term, c } = mounted(20)
    c.writeStream(`\n${"x".repeat(25)}`) // wraps: 20 cells, then 5 on the next row
    c.writeBlock(BLOCK)
    expect(rowOf(term, "⚠ warn")).toBe(-1)

    c.writeStream("\n")
    // The last response row is the 5 cells that wrapped. The block is right under it.
    const tail = allRows(term).indexOf("xxxxx")
    expect(tail).toBeGreaterThanOrEqual(0)
    expect(rowOf(term, "⚠ warn")).toBe(tail + 1)
  })

  it("keeps a row that fills the width exactly open until its line feed", () => {
    const { term, c } = mounted(10)
    c.writeStream(`\n${"y".repeat(10)}`) // the cursor waits after the last cell
    c.writeBlock(BLOCK)
    expect(rowOf(term, "⚠ warn")).toBe(-1)

    c.writeStream("\n")
    // Look for 9 of the 10 cells: a real terminal clamps the redraw's
    // cursor-forward at the last column, which is a separate matter. The block
    // must still take the row right under the response.
    const text = rowOf(term, "y".repeat(9))
    expect(text).toBeGreaterThanOrEqual(0)
    expect(rowOf(term, "⚠ warn")).toBe(text + 1)
  })

  it("does not take a bare carriage return for the end of a row", () => {
    // A formatter rewrites its open row with `\r` + `ESC[K`. The row is not final yet.
    const { term, c } = mounted()
    c.writeStream("\nraw echo\r")
    c.writeBlock(BLOCK)
    expect(rowOf(term, "⚠ warn")).toBe(-1)

    c.writeStream("\x1b[Kformatted\n")
    const text = rowOf(term, "formatted")
    expect(text).toBeGreaterThanOrEqual(0)
    expect(allRows(term).some((l) => l.includes("raw echo"))).toBe(false)
    expect(rowOf(term, "⚠ warn")).toBe(text + 1)
  })

  it("writes several waiting blocks together, in arrival order, with no gap", () => {
    const { term, c } = mounted()
    c.writeStream("\nstreaming")
    c.writeBlock("  ⚠ warn  one\n")
    c.writeBlock("  ⚠ warn  two\n")
    expect(rowOf(term, "⚠ warn")).toBe(-1)

    c.writeStream("\n")
    const one = rowOf(term, "⚠ warn  one")
    expect(one).toBe(rowOf(term, "streaming") + 1)
    expect(rowOf(term, "⚠ warn  two")).toBe(one + 1)
  })

  it("a block does not break the rows that follow it", () => {
    const { term, c } = mounted()
    c.writeStream("\nbefore")
    c.writeBlock("  ⚠ warn\n")
    c.writeStream("\n")
    c.writeStream("after\n")

    const rows = allRows(term)
    expect(rows).toContain("before")
    expect(rows).toContain("after")
    expect(rowOf(term, "after")).toBe(rowOf(term, "⚠ warn") + 1)
  })

  it("holds the block through bytes that a resize hold keeps back", () => {
    // The open row exists only in the held bytes: the painted cursor is at col 0.
    const { term, c } = mounted()
    c.writeStream("\nfirst\n")
    c.notifyResize()
    c.writeStream("second") // held
    c.writeBlock(BLOCK) // waits: the row is open
    c.writeStream("\n") // held; the block follows it in the hold
    c.setLiveArea(["❯ "], { row: 0, col: 2 }) // the trailing repaint flushes the hold

    const text = rowOf(term, "second")
    expect(allRows(term)[text]).toBe("second")
    expect(rowOf(term, "⚠ warn")).toBe(text + 1)
  })

  it("does not glue a block into a partial escape that the ANSI buffer keeps back (closed row)", () => {
    const { term, c } = mounted()
    c.writeStream("\nfoo\n\x1b[3") // the row is closed, the escape is held back
    c.writeBlock(BLOCK)
    // The row is closed: the block goes in at once, in front of the held escape.
    expect(rowOf(term, "⚠ warn")).toBe(rowOf(term, "foo") + 1)

    c.writeStream("1mred\x1b[0m\n") // the escape completes
    const rows = allRows(term)
    expect(rows.some((l) => l.includes("[31") || l.includes("1mred"))).toBe(false)
    expect(rowOf(term, "red")).toBe(rowOf(term, "╰ no read after write") + 1)
  })

  it("does not glue a block into a partial escape that the ANSI buffer keeps back (open row)", () => {
    const { term, c } = mounted()
    c.writeStream("\nfoo\x1b[3") // the row is open, the escape is held back
    c.writeBlock(BLOCK)
    expect(rowOf(term, "⚠ warn")).toBe(-1)

    c.writeStream("1mred\x1b[0m\n") // the escape completes and the row ends
    const rows = allRows(term)
    expect(rows.some((l) => l.includes("[31") || l.includes("1mred"))).toBe(false)
    expect(rows).toContain("foored")
    expect(rowOf(term, "⚠ warn")).toBe(rowOf(term, "foored") + 1)
  })

  it("puts the block right after the first line feed of a chunk, not after the rest of it", () => {
    const { term, c } = mounted()
    c.writeStream("\nfirst row")
    c.writeBlock(BLOCK)
    c.writeStream(" ends\nsecond row\nthird row\n") // one chunk with three line feeds

    const first = rowOf(term, "first row ends")
    expect(rowOf(term, "⚠ warn")).toBe(first + 1)
    expect(rowOf(term, "second row")).toBe(rowOf(term, "╰ no read after write") + 1)
    expect(rowOf(term, "third row")).toBe(rowOf(term, "second row") + 1)
  })

  it("keeps the block until the end of the stream when the formatter moves the cursor", () => {
    // `ESC[1A` can rewrite a row that already ended with a line feed, so no row is final.
    const { term, c } = mounted()
    c.writeStream("\nrow one\n\x1b[1A\rrow ONE\nrow two\n")
    c.writeBlock(BLOCK)
    c.writeStream("row three\n")
    expect(rowOf(term, "⚠ warn")).toBe(-1)

    c.flushStream() // the end of the turn
    expect(rowOf(term, "⚠ warn")).toBe(rowOf(term, "row three") + 1)
  })

  it("flushStream ends an open row and writes the waiting block (the end of a turn)", () => {
    const { term, c } = mounted()
    c.writeStream("\nstreaming")
    c.writeBlock(BLOCK)
    expect(rowOf(term, "⚠ warn")).toBe(-1)

    c.flushStream()
    expect(rowOf(term, "⚠ warn")).toBe(rowOf(term, "streaming") + 1)
  })

  it("unmount writes a block that still waits", () => {
    const { term, c } = mounted()
    c.writeStream("\nstreaming")
    c.writeBlock(BLOCK)

    c.unmount()
    expect(rowOf(term, "⚠ warn")).toBe(rowOf(term, "streaming") + 1)
  })

  it("withSuspendedLiveArea writes a block that waited while the callback owned the terminal", async () => {
    const { term, c } = mounted()
    c.writeStream("\nstreaming")
    c.writeBlock(BLOCK)

    await c.withSuspendedLiveArea(() => {
      term.feed("\r\npicked\r\n") // the callback leaves a clean line
    })
    expect(rowOf(term, "⚠ warn")).toBe(rowOf(term, "picked") + 1)
  })

  it("writes nothing for an empty block", () => {
    const { c, writes } = mounted()
    c.writeStream("open row")
    writes.length = 0
    c.writeBlock("")
    c.flushStream()

    expect(writes).toEqual([])
  })

  it("the live area stays on its row under the block, once", () => {
    const { term, c } = mounted()
    c.writeStream("\nstreaming")
    c.writeBlock(BLOCK)
    c.writeStream("\n")

    const rows = allRows(term)
    const prompts = rows.map((l, i) => (l.startsWith("❯") ? i : -1)).filter((i) => i >= 0)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toBeGreaterThan(rowOf(term, "╰ no read after write"))
  })

  it("passes a block straight through on a terminal that is not a TTY", () => {
    const writes: string[] = []
    const c = new Compositor({
      output: { isTTY: false, columns: 80, rows: 24, write: (s: string) => (writes.push(s), true) },
    })
    c.mount()
    c.writeBlock("a block\n")

    expect(writes.join("")).toBe("a block\n")
  })

  it("passes a block straight through before the compositor is mounted", () => {
    const writes: string[] = []
    const c = new Compositor({
      output: { isTTY: true, columns: 80, rows: 24, write: (s: string) => (writes.push(s), true) },
    })
    c.writeBlock("a block\n")

    // The raw-mode TTY path turns a bare LF into CRLF.
    expect(writes.join("")).toBe("a block\r\n")
  })
})
