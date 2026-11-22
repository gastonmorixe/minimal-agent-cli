/**
 * Vertical nav over atomic chips (paste plugin v3, D2 review fixes). A
 * synthetic span source: each `{...}` run is a span with a label of `width`
 * cells. Prompt width 2 on each row.
 */

import { describe, expect, it } from "bun:test"

import { EditorBuffer } from "../input/editor-buffer.ts"
import type { ChipSpan } from "../paste/chip-registry.ts"
import { VerticalNavigator } from "./vertical-nav.ts"

function bracesOf(width: number): (line: string) => ChipSpan[] {
  return (line) => {
    const chars = Array.from(line)
    const out: ChipSpan[] = []
    let open = -1
    chars.forEach((ch, i) => {
      if (ch === "{") open = i
      if (ch === "}" && open >= 0) {
        out.push({ start: open, end: i + 1, label: "L".repeat(width) })
        open = -1
      }
    })
    return out
  }
}

function setup(text: string, width: number, cols: number) {
  const buf = new EditorBuffer(bracesOf(width))
  const lines = text.split("\n")
  lines.forEach((l, i) => {
    buf.insert(l)
    if (i < lines.length - 1) buf.newline()
  })
  const nav = new VerticalNavigator(
    buf,
    () => 2,
    () => cols,
  )
  return { buf, nav }
}

describe("VerticalNavigator: a chip wider than a row", () => {
  // Rows: "> ab" | 10 chip cells | 10 chip cells | "cd". The cursor at the
  // chip start (col 2) is on row 1; row 2 gives col 2 again.
  it("moveDown skips the next rows of the chip and does not stop", () => {
    const { buf, nav } = setup("ab{y}cd", 20, 10)
    buf.col = 2
    expect(nav.moveDown()).toBe(true)
    expect(buf.col).toBe(5)
    // The last row of the only line: no move.
    expect(nav.moveDown()).toBe(false)
  })

  it("moveDown goes on to the next logical line when no row gives a new col", () => {
    // "{y}" alone: rows "> " + 8 cells | 10 cells | 2 cells; col 3 is its end.
    const { buf, nav } = setup("{y}\nnext", 20, 10)
    buf.row = 0
    buf.col = 3
    expect(nav.moveDown()).toBe(true)
    expect(buf.row).toBe(1)
  })

  it("moveUp skips the rows of the chip, then goes to the line above", () => {
    const { buf, nav } = setup("top\nab{y}cd", 20, 10)
    buf.col = 5
    expect(nav.moveUp()).toBe(true)
    expect([buf.row, buf.col]).toEqual([1, 2])
    expect(nav.moveUp()).toBe(true)
    expect([buf.row, buf.col]).toEqual([1, 0])
    expect(nav.moveUp()).toBe(true)
    expect(buf.row).toBe(0)
  })

  it("moveUp from the chip end skips the rows that give the same col", () => {
    // "> " + 8 cells | 10 cells | 2 cells: col 3 is on row 2, rows 1 and 0 give 0.
    const { buf, nav } = setup("top\n{y}", 20, 10)
    buf.col = 3
    expect(nav.moveUp()).toBe(true)
    expect([buf.row, buf.col]).toEqual([1, 0])
    expect(nav.moveUp()).toBe(true)
    expect(buf.row).toBe(0)
  })
})

describe("VerticalNavigator: an empty first row before a chip", () => {
  // Label 8 cells, cols 9, prompt 2: row 0 is empty, the chip is on row 1.
  it("moveUp at col 0 does not jump to the end of the line", () => {
    const { buf, nav } = setup("{x} tail text here", 8, 9)
    buf.col = 0
    expect(nav.moveUp()).toBe(false)
    expect(buf.col).toBe(0)
  })

  it("moveUp at col 0 goes to the line above", () => {
    const { buf, nav } = setup("top\n{x} tail text here", 8, 9)
    buf.col = 0
    expect(nav.moveUp()).toBe(true)
    expect(buf.row).toBe(0)
  })
})
