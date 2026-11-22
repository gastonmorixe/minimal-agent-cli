import { describe, expect, it } from "bun:test"

import { NO_SIDEBAND } from "@minimal-agent/core/host/sideband"

import { testSideband as sb, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"
import { CHIP_LABEL_MAX, ChipRegistry, fallbackChipLabel } from "./chip-registry.ts"

const peer = () => sb.render("intercom-peer", { attrs: { name: "bob", sid: "s1" }, body: "@bob" })
const paste = () => sb.render("paste", { attrs: { id: "ab1cd", bytes: 1200, lines: 30 } })

describe("fallbackChipLabel", () => {
  it("gives a short one-line body", () => {
    expect(fallbackChipLabel({ kind: "k", body: " @bob " })).toBe("@bob")
  })
  it("gives [kind] for no body, a long body or a multi-line body", () => {
    expect(fallbackChipLabel({ kind: "paste" })).toBe("[paste]")
    expect(fallbackChipLabel({ kind: "paste", body: "x".repeat(33) })).toBe("[paste]")
    expect(fallbackChipLabel({ kind: "paste", body: "a\nb" })).toBe("[paste]")
  })
})

describe.skipIf(!sidebandFixturePresent())("ChipRegistry (real codec)", () => {
  it("spansOf gives code-point offsets and fallback labels", () => {
    const chips = new ChipRegistry()
    const p = peer()
    const r = paste()
    // The emoji is two UTF-16 units and one code point.
    const line = `😀 ${p} and ${r}!`
    const spans = chips.spansOf(line, sb)
    const cpLen = (s: string) => Array.from(s).length
    expect(spans).toEqual([
      { start: 2, end: 2 + cpLen(p), label: "@bob" },
      { start: 2 + cpLen(p) + 5, end: 2 + cpLen(p) + 5 + cpLen(r), label: "[paste]" },
    ])
  })

  it("a registered label wins; unregister gives the fallback again", () => {
    const chips = new ChipRegistry()
    let calls = 0
    chips.subscribe(() => {
      calls += 1
    })
    const off = chips.register({
      kind: "paste",
      label: (attrs, _body, known) =>
        `P#${String(attrs.id)} ${String(attrs.lines)}L${known === undefined ? "" : "?"}`,
    })
    expect(chips.spansOf(paste(), sb)[0]?.label).toBe("P#ab1cd 30L")
    off()
    expect(chips.spansOf(paste(), sb)[0]?.label).toBe("[paste]")
    expect(calls).toBe(2)
  })

  it("a label that throws or is empty gives the fallback; a long label is cut", () => {
    const chips = new ChipRegistry()
    chips.register({
      kind: "paste",
      label: () => {
        throw new Error("boom")
      },
    })
    chips.register({ kind: "intercom-peer", label: () => "x\ty".repeat(100) })
    const spans = chips.spansOf(`${paste()} ${peer()}`, sb)
    expect(spans[0]?.label).toBe("[paste]")
    expect(Array.from(spans[1]!.label).length).toBe(CHIP_LABEL_MAX)
    expect(spans[1]!.label.endsWith("…")).toBe(true)
    expect(spans[1]!.label.includes("\t")).toBe(false)
  })

  it("only inline to-model kinds are chips", () => {
    const chips = new ChipRegistry()
    const mode = sb.render("mode-change", { attrs: { from: "default", to: "ask" } })
    expect(sb.kindInfo("mode-change")?.placement).not.toBe("inline")
    expect(chips.spansOf(`a ${mode} b`, sb)).toEqual([])
    expect(chips.renderText(`a ${mode} b`, sb)).toBe(`a ${mode} b`)
  })

  it("renderText swaps each chip node for its label (display only)", () => {
    const chips = new ChipRegistry()
    const text = `${peer()} see ${paste()}`
    expect(chips.renderText(text, sb)).toBe("@bob see [paste]")
    expect(chips.renderText(text, sb, (l) => `<${l}>`)).toBe("<@bob> see <[paste]>")
  })

  it("no codec: no spans, plain text", () => {
    const chips = new ChipRegistry()
    const text = `${peer()} see ${paste()}`
    expect(chips.spansOf(text, NO_SIDEBAND)).toEqual([])
    expect(chips.spansOf(text, null)).toEqual([])
    expect(chips.renderText(text, NO_SIDEBAND)).toBe(text)
  })
})
