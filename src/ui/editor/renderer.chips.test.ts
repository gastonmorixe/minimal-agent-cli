/**
 * U13 (paste plugin v3, D2): the renderer paints each atomic span as its chip
 * label. A synthetic span source: each `{...}` run is a span with the label
 * `[chip]` (6 cells). The last block uses the real codec.
 */

import { describe, expect, it } from "bun:test"

import { EditorBuffer } from "../../input/editor-buffer.ts"
import { CHIP_SGR, ChipRegistry, type ChipSpan } from "../../paste/chip-registry.ts"
import { testSideband as sb, sidebandFixturePresent } from "../../test-utils/sideband-fixture.ts"
import { computeCursorVisualPos, EditorRenderer, findColAtVisualPos } from "./renderer.ts"

const LABEL = "[chip]"

function braces(line: string): ChipSpan[] {
  const chars = Array.from(line)
  const out: ChipSpan[] = []
  let open = -1
  chars.forEach((ch, i) => {
    if (ch === "{") open = i
    if (ch === "}" && open >= 0) {
      out.push({ start: open, end: i + 1, label: LABEL })
      open = -1
    }
  })
  return out
}

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

function bufOf(text: string): EditorBuffer {
  const buf = new EditorBuffer(braces)
  buf.insert(text)
  return buf
}

const renderer = (showHidden = false) =>
  new EditorRenderer({ prompt: "> ", continuationPrompt: "  ", showHidden })

describe("EditorRenderer chips", () => {
  it("paints a span as its label in the chip style", () => {
    const buf = bufOf("ab{xyz}cd")
    const out = renderer().render(buf, { columns: 80 })
    expect(out.lines).toEqual([`> ab${CHIP_SGR}${LABEL}\x1b[0mcd`])
    // The cursor is after the label cells: 2 + 2 + 6 + 2.
    expect(out.cursor).toEqual({ row: 0, col: 12 })
    buf.col = 2
    expect(renderer().render(buf, { columns: 80 }).cursor).toEqual({ row: 0, col: 4 })
    buf.moveRight()
    expect(renderer().render(buf, { columns: 80 }).cursor).toEqual({ row: 0, col: 10 })
  })

  it("no-wrap layout uses the label cells too", () => {
    const buf = bufOf("ab{xyz}cd")
    const out = renderer().render(buf)
    expect(plain(out.lines[0]!)).toBe(`> ab${LABEL}cd`)
    expect(out.cursor).toEqual({ row: 0, col: 12 })
  })

  it("a wrap never splits a chip: the row breaks before it", () => {
    // Row 0 has 8 cells after the prompt: "abcd" + a 6-cell chip does not fit.
    const buf = bufOf("abcd{xyz}e")
    const r = renderer()
    const out = r.render(buf, { columns: 10 })
    expect(out.lines.map(plain)).toEqual(["> abcd", `${LABEL}e`])
    expect(out.cursor).toEqual({ row: 1, col: 7 })
    expect(r.measureRows(buf, 10)).toBe(2)
  })

  it("a chip wider than a row is cut at the row end", () => {
    const buf = bufOf("{x}")
    const out = renderer().render(buf, { columns: 4 })
    // The cursor is at the end of a full row: the phantom row follows.
    expect(out.lines.map(plain)).toEqual(["> [c", "hip]", ""])
  })

  it("an exact fill with the cursor at the end adds the phantom row", () => {
    // "> " + 6-cell chip + "ab" = 10 cells.
    const buf = bufOf("{x}ab")
    const r = renderer()
    const out = r.render(buf, { columns: 10 })
    expect(out.lines.map(plain)).toEqual([`> ${LABEL}ab`, ""])
    expect(out.cursor).toEqual({ row: 1, col: 0 })
    expect(r.measureRows(buf, 10)).toBe(2)
  })

  it("show-hidden paints the raw tag", () => {
    const buf = bufOf("a {xyz}")
    const out = renderer(true).render(buf, { columns: 80 })
    expect(plain(out.lines[0]!)).toBe("> a·{xyz}")
    expect(out.lines[0]!.includes(CHIP_SGR)).toBe(false)
    expect(out.cursor).toEqual({ row: 0, col: 9 })
  })

  it("buffer styles do not paint over a chip", () => {
    const buf = bufOf("{x}a")
    const out = renderer().render(buf, {
      columns: 80,
      styles: [{ start: 0, end: 4, style: "\x1b[31m" }],
    })
    expect(out.lines[0]).toBe(`> ${CHIP_SGR}${LABEL}\x1b[0m\x1b[31ma\x1b[0m`)
  })
})

describe("cursor maps with chips", () => {
  const line = "abcd{xyz}e"
  const spans = braces(line)

  it("computeCursorVisualPos uses the display cells", () => {
    expect(computeCursorVisualPos(line, 10, 2, 10, spans)).toEqual({
      visualRow: 1,
      visualCol: 7,
      rowsInLine: 2,
    })
    // Before the chip: the chip starts row 1.
    expect(computeCursorVisualPos(line, 4, 2, 10, spans)).toEqual({
      visualRow: 1,
      visualCol: 0,
      rowsInLine: 2,
    })
    expect(computeCursorVisualPos(line, 2, 2, 10, spans).visualCol).toBe(4)
  })

  it("findColAtVisualPos lands on a unit edge, never inside a chip", () => {
    // Row 1, cells 0..5 are the chip: a cell inside gives its start.
    expect(findColAtVisualPos(line, 1, 3, 2, 10, spans)).toBe(4)
    expect(findColAtVisualPos(line, 1, 6, 2, 10, spans)).toBe(9)
    expect(findColAtVisualPos(line, 1, 99, 2, 10, spans)).toBe(10)
    // Row 0 past its content: stay on row 0, before its last unit.
    expect(findColAtVisualPos(line, 0, 9, 2, 10, spans)).toBe(3)
    expect(findColAtVisualPos(line, 0, 4, 2, 10, spans)).toBe(2)
  })

  it("an empty row before a chip maps to the chip start, not the line end", () => {
    // Label 6 cells, cols 7, prompt 2: row 0 is empty, the chip is row 1.
    const l = "{x} tail"
    const sp = braces(l)
    expect(findColAtVisualPos(l, 0, 0, 2, 7, sp)).toBe(0)
    expect(findColAtVisualPos(l, 0, 5, 2, 7, sp)).toBe(0)
  })

  it("no spans: the old maps", () => {
    expect(computeCursorVisualPos("abc", 2, 2, 10)).toEqual(
      computeCursorVisualPos("abc", 2, 2, 10, []),
    )
    expect(findColAtVisualPos("abcdef", 0, 5, 2, 10)).toBe(3)
  })
})

describe.skipIf(!sidebandFixturePresent())("EditorRenderer chips (real codec)", () => {
  it("a paste ref and a peer mention paint as chips; no codec paints the tag", () => {
    const chips = new ChipRegistry()
    const peer = sb.render("intercom-peer", { attrs: { name: "bob", sid: "s1" }, body: "@bob" })
    const ref = sb.render("paste", { attrs: { id: "ab1cd", bytes: 12, lines: 1 } })
    const buf = new EditorBuffer((l) => chips.spansOf(l, sb))
    buf.insert(`${peer} x ${ref}`)
    const out = renderer().render(buf, { columns: 80 })
    expect(plain(out.lines[0]!)).toBe("> @bob x [paste]")
    expect(out.cursor).toEqual({ row: 0, col: 16 })
    const raw = new EditorBuffer()
    raw.insert(`${peer} x ${ref}`)
    expect(plain(renderer().render(raw, { columns: 1000 }).lines[0]!)).toBe(`> ${peer} x ${ref}`)
  })
})
