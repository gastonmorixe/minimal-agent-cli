import { describe, expect, test } from "bun:test"

import { displayWidth, stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { c } from "../style/ansi.ts"
import { type HelpSection, minSummaryWidth, renderHelpSections, wrapHelpText } from "./render.ts"

const ESC = "\u001b"

const LONG =
  "Constrain the final answer to a JSON Schema and exit non-zero when the answer is absent"

const SECTIONS: HelpSection[] = [
  {
    title: c.bold("Options"),
    note: c.dim("(a note that is long enough to wrap at a small width for sure)"),
    rows: [
      { term: `${c.cyan("-m")}, ${c.cyan("--model")} ${c.dim("<id>")}`, summary: "Select model" },
      { term: c.cyan("--output-schema <file>"), summary: LONG },
      {
        term: c.cyan("auth-status plan [<credential>] [--all] [--table] [--parallel <n>]"),
        summary: "Show plan, seat, role, and usage limits",
      },
      {
        term: c.cyan("--x"),
        summary: `see minimum/maxLength/pattern/anyOf/oneOf/allOf/not/$ref/format/const ${c.dim("(dim)")}`,
      },
      { term: "", summary: c.dim("continuation row with an empty term") },
    ],
  },
]

function maxWidth(lines: readonly string[]): number {
  return Math.max(...lines.map(displayWidth))
}

/**
 * Lines wider than `width`. SPEC-HELP V-2 allows only one kind: a line that
 * holds a single unbreakable token.
 */
function overWidth(lines: readonly string[], width: number): string[] {
  return lines.filter((l) => displayWidth(l) > width)
}

function tokenCount(line: string): number {
  return stripAnsi(line).trim().split(/\s+/u).length
}

describe("renderHelpSections without a width", () => {
  test("aligns summaries to the widest term and does not wrap", () => {
    const lines = renderHelpSections([
      {
        title: "T",
        rows: [
          { term: c.cyan("-a"), summary: "one" },
          { term: c.cyan("--long"), summary: "two" },
        ],
      },
    ])
    expect(lines.map(stripAnsi)).toEqual(["  T", "    -a      one", "    --long  two"])
  })

  test("keeps ANSI by default", () => {
    expect(renderHelpSections(SECTIONS).join("\n")).toContain(ESC)
  })
})

describe("renderHelpSections with a width (SPEC-HELP R-28)", () => {
  for (const width of [40, 60, 80, 120]) {
    test(`no line is wider than ${width} except a single-token line, with and without color`, () => {
      for (const color of [true, false]) {
        for (const line of overWidth(renderHelpSections(SECTIONS, { width, color }), width)) {
          expect(tokenCount(line)).toBe(1)
        }
      }
    })
  }

  test("at 80 and 120 the sample has no line wider than the width", () => {
    for (const width of [80, 120]) {
      expect(maxWidth(renderHelpSections(SECTIONS, { width }))).toBeLessThanOrEqual(width)
    }
  })

  test("keeps every word in order", () => {
    const words = (s: string): string[] => stripAnsi(s).split(/\s+/u).filter(Boolean)
    const flat = SECTIONS.flatMap((s) => [
      s.title,
      s.note ?? "",
      ...s.rows.flatMap((r) => [r.term, r.summary]),
    ])
    const rendered = renderHelpSections(SECTIONS, { width: 80, color: false })
    expect(words(rendered.join(" "))).toEqual(words(flat.join(" ")))
  })

  test("a term that is too wide goes on its own line, the summary on the next", () => {
    const lines = renderHelpSections(SECTIONS, { width: 80, color: false })
    const at = lines.findIndex((l) => l.includes("auth-status plan"))
    expect(lines[at]).toBe("    auth-status plan [<credential>] [--all] [--table] [--parallel <n>]")
    expect(lines[at + 1]?.trimStart()).toBe("Show plan, seat, role, and usage limits")
    // The summary stays in the summary column of the section.
    const modelLine = lines.find((l) => l.includes("--model")) ?? ""
    const summaryCol = modelLine.indexOf("Select model")
    expect(lines[at + 1]?.indexOf("Show plan")).toBe(summaryCol)
  })

  test("wrapped summary lines start at the summary column", () => {
    const lines = renderHelpSections(SECTIONS, { width: 60, color: false })
    const at = lines.findIndex((l) => l.includes("--output-schema"))
    const col = (lines[at] ?? "").indexOf("Constrain")
    expect(col).toBeGreaterThan(0)
    expect(lines[at + 1]?.slice(0, col).trim()).toBe("")
    expect(lines[at + 1]?.charAt(col)).not.toBe(" ")
  })

  test("a summary word wider than the summary column moves the summary below the term", () => {
    const lines = renderHelpSections(SECTIONS, { width: 80, color: false })
    const at = lines.findIndex((l) => l.trim() === "--x")
    expect(at).toBeGreaterThan(-1)
    expect(lines[at + 1]).toBe(
      "        see minimum/maxLength/pattern/anyOf/oneOf/allOf/not/$ref/format/const",
    )
    expect(lines[at + 2]).toBe("        (dim)")
  })

  test("the term column leaves at least the minimum summary width", () => {
    expect(minSummaryWidth(80)).toBe(40)
    expect(minSummaryWidth(10)).toBe(10)
  })

  test("a word wider than the whole width stays whole on its own line (SPEC-HELP V-2)", () => {
    const url = "https://github.com/gastonmorixe/minimal-agent/blob/main/README.md"
    for (const color of [true, false]) {
      const lines = renderHelpSections(
        [{ title: "T", rows: [{ term: "x", summary: c.dim(`see ${url} for the rest`) }] }],
        { width: 30, color },
      )
      const plain = lines.map(stripAnsi)
      expect(plain.filter((l) => l.includes(url))).toHaveLength(1)
      const over = overWidth(lines, 30)
      expect(over).toHaveLength(1)
      expect(stripAnsi(over[0] ?? "").trim()).toBe(url)
      expect(plain.join(" ")).toContain("see")
      expect(plain.join(" ")).toContain("for the rest")
    }
  })

  test("wrapHelpText keeps a long token whole and carries the style onto it", () => {
    const lines = wrapHelpText(c.dim("a b github.com/gastonmorixe/minimal-agent c d"), {
      indent: 2,
      width: 20,
    })
    expect(lines.map(stripAnsi)).toEqual([
      "  a b",
      "  github.com/gastonmorixe/minimal-agent",
      "  c d",
    ])
    for (const line of lines) expect(line).toContain(`${ESC}[2m`)
    for (const line of lines) expect(line.endsWith(`${ESC}[0m`)).toBe(true)
  })

  test("every wrapped colored fragment is closed with a reset, the last one too", () => {
    const lines = renderHelpSections(
      [{ title: "T", rows: [{ term: "x", summary: c.dim("one two three four five six seven") }] }],
      { width: 24 },
    )
    expect(lines.length).toBeGreaterThan(2)
    for (const line of lines.slice(1)) expect(line.endsWith(`${ESC}[0m`)).toBe(true)
  })
})

describe("renderHelpSections color off (SPEC-HELP R-29)", () => {
  test("strips every escape from titles, notes, terms, and summaries", () => {
    for (const width of [undefined, 60]) {
      expect(renderHelpSections(SECTIONS, { width, color: false }).join("\n")).not.toContain(ESC)
    }
  })
})

describe("wrapHelpText", () => {
  test("indents and wraps free text", () => {
    expect(wrapHelpText("aa bb cc dd", { indent: 2, hang: 4, width: 9 })).toEqual([
      "  aa bb",
      "    cc dd",
    ])
  })

  test("returns the line unchanged without a width, and strips ANSI with color off", () => {
    expect(wrapHelpText(c.bold("x"), { indent: 2 })).toEqual([`  ${c.bold("x")}`])
    expect(wrapHelpText(c.bold("x"), { indent: 2, color: false })).toEqual(["  x"])
  })
})
