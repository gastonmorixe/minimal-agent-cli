/**
 * Paste plugin v3, D2 (U12, U13, I5): atomic chips through the editor
 * controller. Covers the writers of `buf.row` / `buf.col` (vertical nav and
 * the `editor.key` cursor result, W-1), `setBuffer` (resume draft and
 * `editor.buffer.set`), show-hidden (Ctrl+\) and the commit lines of a
 * submit (scrollback).
 */

import { describe, expect, it } from "bun:test"
import { NO_SIDEBAND } from "@minimal-agent/core/host/sideband"
import { Hooks } from "@minimal-agent/core/host-kit/hooks"
import type { EditorKeyPayload } from "./editor/types.ts"
import { make } from "./editor-controller.fixtures.ts"
import { CHIP_SGR, ChipRegistry, type ChipSpan } from "./paste/chip-registry.ts"
import { testSideband as sb, sidebandFixturePresent } from "./test-utils/sideband-fixture.ts"

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

/** Each `{...}` of a line is a span with the label `[c]`. */
function braces(line: string): ChipSpan[] {
  const chars = Array.from(line)
  const out: ChipSpan[] = []
  let open = -1
  chars.forEach((ch, i) => {
    if (ch === "{") open = i
    if (ch === "}" && open >= 0) {
      out.push({ start: open, end: i + 1, label: "[c]" })
      open = -1
    }
  })
  return out
}

const UP = "\x1b[A"
const DOWN = "\x1b[B"

describe("EditorController chips: row/col writers (W-1)", () => {
  it("vertical nav (no wrap) never lands inside a span", () => {
    const { ctrl, stdin } = make({ spanSource: braces })
    ctrl.start()
    ctrl.setBuffer("abcdefghij\nab{wxyz}cd")
    const buf = ctrl.buffer()
    // Row 1: "ab" at cells 2..3, the chip "[c]" at cells 4..6. Visual col 6
    // (row 0, col 4) falls inside the chip: the cursor lands at its start.
    buf.row = 0
    buf.col = 4
    stdin.send(DOWN)
    expect(buf.row).toBe(1)
    expect(buf.col).toBe(2)
    stdin.send(UP)
    expect(buf.row).toBe(0)
    expect(buf.col).toBe(4)
    ctrl.stop()
  })

  it("vertical nav inside a wrapped line steps over a chip row", () => {
    // 12 columns, prompt 2: row 0 holds "abcdefghij" (10 cells); the chip
    // does not fit after it, so physical row 1 is "[c]k".
    const { ctrl, stdin } = make({ spanSource: braces, columns: 12 })
    ctrl.start()
    ctrl.setBuffer("abcdefghij{wxyz}k")
    const buf = ctrl.buffer()
    buf.col = 0
    stdin.send(DOWN)
    // Visual col 2 is inside the chip label: the cursor lands at its start.
    expect(buf.row).toBe(0)
    expect(buf.col).toBe(10)
    stdin.send(UP)
    expect(buf.col).toBe(0)
    ctrl.stop()
  })

  it("an editor.key cursor result is snapped out of a span", () => {
    const hooks = new Hooks()
    hooks.on<EditorKeyPayload>(
      "editor.key",
      (p) => {
        if (p.key !== "ArrowUp") return
        p.result.halt = true
        p.result.buffer = "ab{wxyz}cd"
        p.result.cursor = { row: 0, col: 4 }
      },
      { caller: "plugin" },
    )
    const { ctrl, stdin } = make({ hooks, spanSource: braces })
    ctrl.start()
    stdin.send(UP)
    // The setBuffer left the cursor at the end (col 10), so col 4 moves back.
    expect(ctrl.buffer().col).toBe(2)
    ctrl.stop()
  })
})

describe("EditorController chips: paint, show-hidden, commit", () => {
  it("setBuffer computes the spans; the live area shows the chip", () => {
    const { ctrl, compositor } = make({ spanSource: braces })
    ctrl.start()
    ctrl.setBuffer("go {x}")
    expect(ctrl.buffer().toString()).toBe("go {x}")
    const live = compositor.last()!
    expect(live.lines.some((l) => l.includes(`${CHIP_SGR}[c]`))).toBe(true)
    expect(live.cursor).toEqual({ row: live.cursor!.row, col: 8 })
    ctrl.stop()
  })

  it("Ctrl+\\ shows the raw text, and again the chip", () => {
    const { ctrl, stdin, compositor } = make({ spanSource: braces })
    ctrl.start()
    ctrl.setBuffer("go {x}")
    stdin.send("\x1c")
    expect(compositor.last()!.lines.some((l) => plain(l).includes("{x}"))).toBe(true)
    stdin.send("\x1c")
    expect(compositor.last()!.lines.some((l) => plain(l).includes("go·[c]"))).toBe(false)
    expect(compositor.last()!.lines.some((l) => plain(l).includes("go [c]"))).toBe(true)
    ctrl.stop()
  })

  it("show-hidden: Up/Down use the raw text layout, as the paint does", () => {
    // The raw span is 24 cells, its label 3. With cols 12, the raw line wraps
    // and the chip line does not.
    const raw = `a{${"y".repeat(22)}}`
    const chips = make({ spanSource: braces, columns: 12 })
    chips.ctrl.start()
    chips.ctrl.setBuffer(`top\n${raw}`)
    chips.stdin.send(UP)
    // Chips: the line is one row, so Up goes to the line above.
    expect(chips.ctrl.buffer().row).toBe(0)
    chips.ctrl.stop()

    const hidden = make({ spanSource: braces, columns: 12 })
    hidden.ctrl.start()
    hidden.ctrl.setBuffer(`top\n${raw}`)
    hidden.stdin.send("\x1c")
    hidden.stdin.send(UP)
    // Raw text: the line wraps, so Up moves one visual row in the same line.
    expect(hidden.ctrl.buffer().row).toBe(1)
    hidden.ctrl.stop()
  })

  it("refreshSpans repaints with the new spans", () => {
    let spans = (_line: string): ChipSpan[] => []
    const { ctrl, compositor } = make({ spanSource: (l) => spans(l) })
    ctrl.start()
    ctrl.setBuffer("go {x}")
    expect(compositor.last()!.lines.some((l) => l.includes(`${CHIP_SGR}[c]`))).toBe(false)
    spans = braces
    ctrl.refreshSpans()
    expect(compositor.last()!.lines.some((l) => l.includes(`${CHIP_SGR}[c]`))).toBe(true)
    ctrl.stop()
  })

  it("commitLines (scrollback) paint the chip; the submit text keeps the raw form", () => {
    const { ctrl, stdin } = make({ spanSource: braces })
    const seen: { text: string; lines: string[] }[] = []
    ctrl.on("submit", (text: string, lines: string[]) => seen.push({ text, lines }))
    ctrl.start()
    ctrl.setBuffer("see {x}\nnext")
    stdin.send("\r")
    expect(seen.length).toBe(1)
    expect(seen[0]!.text).toBe("see {x}\nnext")
    expect(seen[0]!.lines.map(plain)).toEqual(["> see [c]", "  next"])
    expect(seen[0]!.lines[0]).toContain(`${CHIP_SGR}[c]`)
    ctrl.stop()
  })
})

describe.skipIf(!sidebandFixturePresent())("EditorController chips (real codec)", () => {
  it("a resume draft with a peer mention shows the chip, keeps the codec form", () => {
    const chips = new ChipRegistry()
    const { ctrl, compositor } = make({ spanSource: (l) => chips.spansOf(l, sb) })
    const peer = sb.render("intercom-peer", { attrs: { name: "bob", sid: "s1" }, body: "@bob" })
    const draft = `${peer} please check ${sb.render("paste", { attrs: { id: "ab1cd" } })}`
    // live-repl.ts sets the draft before start; the first paint shows it.
    ctrl.setBuffer(draft)
    ctrl.start()
    expect(ctrl.buffer().toString()).toBe(draft)
    const shown = compositor.last()!.lines.map(plain).join("\n")
    expect(shown).toContain("> @bob please check [paste]")
    expect(shown).not.toContain("intercom")
    ctrl.stop()
  })

  it("no codec: the draft shows as plain text", () => {
    const chips = new ChipRegistry()
    const { ctrl, compositor } = make({
      spanSource: (l) => chips.spansOf(l, NO_SIDEBAND),
      columns: 400,
    })
    const peer = sb.render("intercom-peer", { attrs: { name: "bob", sid: "s1" }, body: "@bob" })
    ctrl.setBuffer(peer)
    ctrl.start()
    expect(compositor.last()!.lines.map(plain).join("")).toContain(peer)
    ctrl.stop()
  })
})
