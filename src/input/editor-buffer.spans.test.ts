/**
 * U12 (paste plugin v3, D2): atomic chip spans in the editor buffer.
 *
 * The mechanics use a synthetic span source: each `{...}` run of a line is one
 * span. The last block uses the real codec through the chip registry.
 */

import { describe, expect, it } from "bun:test"

import { ChipRegistry, type ChipSpan } from "../paste/chip-registry.ts"
import { testSideband as sb, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"
import { EditorBuffer } from "./editor-buffer.ts"

/** Each `{...}` of the line is a span with the label `C`. */
function braces(line: string): ChipSpan[] {
  const chars = Array.from(line)
  const out: ChipSpan[] = []
  let open = -1
  chars.forEach((ch, i) => {
    if (ch === "{") open = i
    if (ch === "}" && open >= 0) {
      out.push({ start: open, end: i + 1, label: "C" })
      open = -1
    }
  })
  return out
}

function make(text: string, col?: number): EditorBuffer {
  const buf = new EditorBuffer(braces)
  const lines = text.split("\n")
  lines.forEach((l, i) => {
    buf.insert(l)
    if (i < lines.length - 1) buf.newline()
  })
  if (col !== undefined) buf.col = col
  return buf
}

/** True when the cursor is strictly inside a span of its row. */
function inside(buf: EditorBuffer): boolean {
  return buf.spansOfRow(buf.row).some((s) => buf.col > s.start && buf.col < s.end)
}

describe("EditorBuffer spans: move", () => {
  it("moveRight and moveLeft jump over a span", () => {
    const buf = make("ab{xyz}cd")
    buf.moveLineStart()
    buf.moveRight()
    buf.moveRight()
    expect(buf.col).toBe(2)
    buf.moveRight()
    expect(buf.col).toBe(7)
    buf.moveLeft()
    expect(buf.col).toBe(2)
  })

  it("moveUp and moveDown snap back out of a span", () => {
    const buf = make("ab{xyz}cd\nabcdefghi")
    expect(buf.row).toBe(1)
    buf.col = 4
    buf.moveUp()
    expect(buf.row).toBe(0)
    expect(buf.col).toBe(2)
    const down = make("abcdefghi\nab{xyz}cd")
    down.row = 0
    down.col = 5
    down.moveDown()
    expect(down.col).toBe(2)
  })
})

describe("EditorBuffer spans: delete", () => {
  it("deleteBackward after a span removes the whole span", () => {
    const buf = make("ab{xyz}cd", 7)
    expect(buf.deleteBackward()).toBe(true)
    expect(buf.toString()).toBe("abcd")
    expect(buf.col).toBe(2)
  })

  it("deleteForward before a span removes the whole span", () => {
    const buf = make("ab{xyz}cd", 2)
    expect(buf.deleteForward()).toBe(true)
    expect(buf.toString()).toBe("abcd")
    expect(buf.col).toBe(2)
  })

  it("a plain character next to a span deletes as one", () => {
    const buf = make("ab{xyz}cd", 8)
    buf.deleteBackward()
    expect(buf.toString()).toBe("ab{xyz}d")
  })

  it("a line join that makes a span keeps the cursor out of it", () => {
    const buf = make("ab{x\nyz}cd")
    buf.row = 1
    buf.col = 0
    buf.deleteBackward()
    expect(buf.toString()).toBe("ab{xyz}cd")
    expect(inside(buf)).toBe(false)
    expect(buf.col).toBe(2)
  })
})

describe("EditorBuffer spans: words and kills", () => {
  it("a word scan counts a span as one word", () => {
    const buf = make("ab{x y}cd", 9)
    buf.moveWordLeft()
    expect(buf.col).toBe(7)
    buf.moveWordLeft()
    expect(buf.col).toBe(2)
    buf.moveWordLeft()
    expect(buf.col).toBe(0)
    buf.moveWordRight()
    expect(buf.col).toBe(2)
    buf.moveWordRight()
    expect(buf.col).toBe(7)
    buf.moveWordRight()
    expect(buf.col).toBe(9)
  })

  it("a word scan over white space stops at a span", () => {
    const buf = make("{a b}   x", 8)
    buf.moveWordLeft()
    expect(buf.col).toBe(0)
  })

  it("deleteWordBackward removes the span only", () => {
    const buf = make("go {a b}", 8)
    buf.deleteWordBackward()
    expect(buf.toString()).toBe("go ")
  })

  it("a kill never cuts a span", () => {
    const end = make("ab{xyz}cd", 2)
    end.killToLineEnd()
    expect(end.toString()).toBe("ab")
    const start = make("ab{xyz}cd", 7)
    start.killToLineStart()
    expect(start.toString()).toBe("cd")
  })
})

describe("EditorBuffer spans: the cursor is never inside a span (W-1)", () => {
  it("the col setter snaps forward when it moves right, else back", () => {
    const buf = make("ab{xyz}cd", 0)
    buf.col = 4
    expect(buf.col).toBe(7)
    buf.col = 9
    buf.col = 5
    expect(buf.col).toBe(2)
  })

  it("the row setter snaps back", () => {
    const buf = make("ab{xyz}cd\nabcde")
    buf.col = 4
    buf.row = 0
    expect(buf.col).toBe(2)
  })

  it("insert keeps the cursor out of a new span", () => {
    const buf = make("ab", 2)
    buf.insert("{x")
    buf.insert("y}")
    expect(buf.col).toBe(6)
    expect(buf.spansOfRow(0)).toEqual([{ start: 2, end: 6, label: "C" }])
  })

  it("spans are computed again when a line changes and after clear", () => {
    const buf = make("{a}")
    expect(buf.spansOfRow(0).length).toBe(1)
    buf.deleteBackward()
    expect(buf.spansOfRow(0)).toEqual([])
    buf.insert("{b}{c}")
    expect(buf.spansOfRow(0).length).toBe(2)
    buf.clear()
    expect(buf.spansOfRow(0)).toEqual([])
  })

  it("bad spans from a source are dropped; a throwing source gives none", () => {
    const bad = new EditorBuffer(() => [
      { start: 3, end: 2, label: "x" },
      { start: 0, end: 99, label: "x" },
      { start: 1, end: 3, label: "ok" },
      { start: 2, end: 4, label: "overlap" },
    ])
    bad.insert("abcd")
    expect(bad.spansOfRow(0)).toEqual([{ start: 1, end: 3, label: "ok" }])
    const boom = new EditorBuffer(() => {
      throw new Error("x")
    })
    boom.insert("abc")
    expect(boom.spansOfRow(0)).toEqual([])
    expect(boom.col).toBe(3)
  })

  it("no span source: each code point is one unit (old behavior)", () => {
    const buf = new EditorBuffer()
    buf.insert("ab{xyz}cd")
    buf.col = 4
    expect(buf.col).toBe(4)
    buf.deleteBackward()
    expect(buf.toString()).toBe("ab{yz}cd")
  })

  it("setSpanSource drops the cache and snaps the cursor back", () => {
    const buf = new EditorBuffer()
    buf.insert("ab{xyz}cd")
    buf.col = 4
    buf.setSpanSource(braces)
    expect(buf.col).toBe(2)
  })
})

describe.skipIf(!sidebandFixturePresent())("EditorBuffer spans: real codec", () => {
  it("a peer mention and a paste ref are atomic", () => {
    const chips = new ChipRegistry()
    const buf = new EditorBuffer((line) => chips.spansOf(line, sb))
    const peer = sb.render("intercom-peer", { attrs: { name: "bob", sid: "s1" }, body: "@bob" })
    const ref = sb.render("paste", { attrs: { id: "ab1cd", bytes: 12, lines: 1 } })
    buf.insert(`${peer} hi ${ref}`)
    // The buffer keeps the codec form.
    expect(buf.toString()).toBe(`${peer} hi ${ref}`)
    buf.deleteBackward()
    expect(buf.toString()).toBe(`${peer} hi `)
    buf.moveLineStart()
    buf.moveRight()
    expect(buf.col).toBe(Array.from(peer).length)
    buf.moveLineStart()
    buf.deleteForward()
    expect(buf.toString()).toBe(" hi ")
  })
})
