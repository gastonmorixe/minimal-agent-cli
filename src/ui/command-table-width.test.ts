import { describe, expect, it } from "bun:test"
import { join } from "node:path"

import { displayWidth, stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"
import { sessionTableSpec } from "./__fixtures__/command-table-sessions.ts"
import { renderCommandTable, writeCommandTable } from "./command-table.ts"
import type { CommandTableRow, CommandTableSpan, CommandTableSpec } from "./command-table-types.ts"
import { renderWidthTable, treePrefixes } from "./command-table-width.ts"

const SGR = /\u001b\[/u
const GOLDEN_DIR = join(import.meta.dir, "__golden__")

describe("width mode: golden snapshots", () => {
  for (const width of [60, 80, 100, 140]) {
    it(`matches the recommended mockup at width ${width}`, async () => {
      const golden = await Bun.file(join(GOLDEN_DIR, `command-table-sessions-w${width}.txt`)).text()
      const rows = renderCommandTable(sessionTableSpec(width))
      expect(`${rows.join("\n")}\n`).toBe(golden)
    })

    it(`paints the same layout at width ${width}`, async () => {
      const golden = await Bun.file(join(GOLDEN_DIR, `command-table-sessions-w${width}.txt`)).text()
      const rows = renderCommandTable(sessionTableSpec(width, true))
      expect(rows.some((row) => SGR.test(row))).toBe(true)
      expect(`${rows.map(stripAnsi).join("\n")}\n`).toBe(golden)
      for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(width)
    })
  }

  it("drops cost and model first, then start", () => {
    const head = (w: number): string => renderCommandTable(sessionTableSpec(w))[1] ?? ""
    expect(head(80)).toContain("model")
    expect(head(60)).not.toContain("cost")
    expect(head(60)).not.toContain("model")
    expect(head(60)).toContain("start")
    expect(head(52)).not.toContain("start")
    expect(head(52)).toContain("dur")
  })
})

describe("width mode: color policy", () => {
  it("has no SGR with color off", () => {
    for (const row of renderCommandTable(sessionTableSpec(100, false))) {
      expect(SGR.test(row)).toBe(false)
    }
  })

  it("strips SGR that a caller put in a cell when color is off", () => {
    const rows = renderCommandTable({
      width: 40,
      color: false,
      columns: [{ key: "a" }, { key: "b", flex: true }],
      sections: [
        { title: "\u001b[1mT\u001b[0m", rows: [{ cells: { a: "\u001b[36mx\u001b[0m", b: "y" } }] },
      ],
    })
    for (const row of rows) expect(SGR.test(row)).toBe(false)
  })

  it("writeCommandTable keeps width mode and drops SGR for a pipe", () => {
    let out = ""
    const stream = { isTTY: false, write: (s: string) => ((out += s), true) }
    writeCommandTable({ ...sessionTableSpec(80), color: undefined }, stream)
    expect(SGR.test(out)).toBe(false)
    expect(out).toContain("├ ○ ecb565ab")
  })
})

describe("width input and spacing (review items 3, 5, 6, 7)", () => {
  const titled = (width: number | undefined): CommandTableSpec => ({
    width,
    color: false,
    columns: [{ key: "a" }, { key: "b", flex: true }],
    sections: [{ title: "group", rows: [{ cells: { a: "x", b: "y" } }] }],
  })

  it("uses the compact layout for a width that is not finite", () => {
    const compact = renderCommandTable(titled(undefined))
    for (const width of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      expect(() => renderCommandTable(titled(width))).not.toThrow()
      expect(renderCommandTable(titled(width))).toEqual(compact)
    }
  })

  it("renderWidthTable gives a clear error for a width that is not finite", () => {
    expect(() => renderWidthTable(titled(80), Number.NaN)).toThrow(/width must be finite/u)
    expect(() => renderWidthTable(titled(80), Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  it("compact mode measures a tab as one space, so columns align", () => {
    const rows = renderCommandTable({
      color: false,
      columns: [{ key: "a" }, { key: "b" }],
      sections: [{ rows: [{ cells: { a: "x\ty", b: "1" } }, { cells: { a: "xyz", b: "2" } }] }],
    })
    expect(rows).toEqual(["", "  x y 1", "  xyz 2"])
  })

  it("compact mode strips caller SGR from a section title when color is off", () => {
    const rows = renderCommandTable({
      color: false,
      columns: [{ key: "a" }],
      sections: [{ title: "\u001b[1mT\u001b[0m", rows: [{ cells: { a: "x" } }] }],
    })
    for (const row of rows) expect(SGR.test(row)).toBe(false)
    expect(rows[1]).toBe("  T")
  })

  it("rounds a fractional gap and indent down to whole cells", () => {
    const base: CommandTableSpec = {
      width: 30,
      color: false,
      columns: [
        { key: "a", width: 5 },
        { key: "b", flex: true },
        { key: "c", width: 4, align: "r" },
      ],
      sections: [{ title: "t", rows: [{ cells: { a: "aaaaa", b: "b".repeat(40), c: "cccc" } }] }],
    }
    const whole = renderCommandTable({ ...base, gap: 2, indent: 1 })
    const fraction = renderCommandTable({ ...base, gap: 2.7, indent: 1.9 })
    expect(fraction).toEqual(whole)
    for (const row of fraction) expect(displayWidth(row)).toBeLessThanOrEqual(30)
    // Each data row fills the width exactly: no cut by the final clamp.
    expect(fraction.at(-1)).toBe(" aaaaa  bbbbbbbbbbbbbbb…  cccc")
  })
})

describe("width mode: sections and tree rows", () => {
  it("draws a dim ruler to the full width after a title", () => {
    const rows = renderCommandTable(sessionTableSpec(70))
    const ruler = rows.find((row) => row.startsWith("  today "))
    expect(ruler).toBeDefined()
    expect(displayWidth(ruler ?? "")).toBe(70)
    expect(ruler?.endsWith("─")).toBe(true)
  })

  it("can turn off the ruler", () => {
    const rows = renderCommandTable({
      width: 40,
      color: false,
      columns: [{ key: "a" }],
      sections: [{ title: "group", ruler: false, rows: [{ cells: { a: "x" } }] }],
    })
    expect(rows).toContain("  group")
  })

  it("derives arms from siblings, with deeper levels", () => {
    const depths = [0, 1, 2, 2, 1, 0, 1]
    const rows: CommandTableRow[] = depths.map((depth) => ({ depth, cells: {} }))
    expect(treePrefixes(rows)).toEqual(["", "├ ", "│ ├ ", "│ ╰ ", "╰ ", "", "╰ "])
  })

  it("keeps the first column one width at each depth", () => {
    const spec: CommandTableSpec = {
      width: 60,
      color: false,
      columns: [{ key: "id" }, { key: "n", align: "r" }],
      sections: [
        {
          rows: [
            { cells: { id: "root", n: "1" } },
            { depth: 1, cells: { id: "child", n: "22" } },
            { depth: 2, cells: { id: "grandchild", n: "333" } },
          ],
        },
      ],
    }
    expect(renderCommandTable(spec).slice(1)).toEqual([
      "  root              1",
      "  ╰ child          22",
      "    ╰ grandchild  333",
    ])
  })
})

describe("width mode: alignment across depth and CJK", () => {
  const spec = (width: number): CommandTableSpec => ({
    width,
    color: true,
    columns: [
      { key: "id", width: 12 },
      { key: "prompt", flex: true, minWidth: 8 },
      { key: "tokens", align: "r", width: 6, dropPriority: 2 },
      { key: "cost", align: "r", width: 6, dropPriority: 1 },
    ],
    sections: [
      {
        title: "今日 🙂",
        rows: [
          {
            cells: {
              id: "● 日本",
              prompt: "日本語のテキスト 🙂 wide",
              tokens: "10.7M",
              cost: "$6.12",
            },
          },
          { depth: 1, cells: { id: "○ ab", prompt: "short", tokens: "4.5k", cost: "$0.01" } },
          {
            depth: 1,
            cells: { id: "○ 漢字漢字漢字", prompt: "🙂🙂🙂🙂🙂🙂🙂🙂", tokens: "1", cost: "" },
          },
          { cells: { id: "○ x", prompt: "ascii", tokens: "275k", cost: "$12.40" } },
        ],
      },
    ],
  })

  /** Right edge (cells) of each non-empty right-aligned cell, by column. */
  const rightEdges = (
    row: string,
    starts: readonly number[],
    widths: readonly number[],
  ): number[] =>
    starts.map((start, i) => {
      const cells = Array.from(stripAnsi(row))
      let col = 0
      let edge = -1
      for (const ch of cells) {
        const w = displayWidth(ch)
        if (col >= start && col < start + (widths[i] ?? 0) && ch !== " ") edge = col + w
        col += w
      }
      return edge
    })

  for (const width of [40, 60, 80, 120]) {
    it(`right-aligned columns end at one edge at depth 0 and 1 (width ${width})`, () => {
      const rows = renderCommandTable(spec(width)).slice(2)
      // Data rows only: indent 2, id 12, gap 2 → prompt starts at 16.
      const promptWidth = width - 2 - 12 - 2 - 2 - 6 - 2 - 6
      const tokensStart = 16 + promptWidth + 2
      const edges = rows
        .filter((row) => row.length > 0)
        .map((row) => rightEdges(row, [tokensStart, tokensStart + 8], [6, 6]))
      expect(edges).toHaveLength(4)
      expect(new Set(edges.map((e) => e[0]))).toEqual(new Set([tokensStart + 6]))
      const costEdges = new Set(edges.map((e) => e[1]).filter((e) => e !== -1))
      expect(costEdges).toEqual(new Set([tokensStart + 8 + 6]))
      for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(width)
    })
  }
})

describe("width mode: property — no row is wider than the width", () => {
  /** Small deterministic PRNG (mulberry32), so a failure can repeat. */
  function rng(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const ALPHABET = [
    "a",
    "Z",
    "7",
    " ",
    "-",
    "日",
    "本",
    "語",
    "漢",
    "한",
    "🙂",
    "🚀",
    "é",
    "·",
    "…",
    "\t",
  ]

  const COLORS = ["cyan", "dim", "bold", "green", "red", "yellow", "none", undefined] as const

  it("holds for 1500 random tables: widths 1-200, gap, indent, spans, depth 0-4", () => {
    const next = rng(0x5eed)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
    const text = (max: number): string =>
      Array.from({ length: Math.floor(next() * max) }, () => pick(ALPHABET)).join("")
    const spans = (): CommandTableSpan[] =>
      Array.from({ length: 1 + Math.floor(next() * 3) }, () => ({
        text: text(10),
        color: pick(COLORS),
      }))
    const started = performance.now()
    for (let n = 0; n < 1500; n++) {
      // A third of the cases are narrow (1-39), where every column drops.
      const width = next() < 0.33 ? 1 + Math.floor(next() * 39) : 40 + Math.floor(next() * 161)
      const rows: CommandTableRow[] = Array.from({ length: 1 + Math.floor(next() * 6) }, () => ({
        depth: Math.floor(next() * 5),
        cells: { id: text(14), prompt: text(120), tokens: text(8), model: text(12) },
        spans: next() < 0.5 ? { id: spans(), prompt: spans() } : undefined,
      }))
      const spec: CommandTableSpec = {
        width,
        color: next() < 0.5,
        // Fractions on purpose: the renderer rounds them down (item 7).
        gap: next() < 0.3 ? undefined : next() * 5,
        indent: next() < 0.3 ? undefined : next() * 6,
        columns: [
          { key: "id", header: "session", width: 12 },
          { key: "prompt", header: "prompt", flex: true, minWidth: 1 + Math.floor(next() * 25) },
          { key: "tokens", header: "tokens", align: "r", maxWidth: 10, dropPriority: 2 },
          { key: "model", header: text(12), dropPriority: 1 },
        ],
        sections: [
          { title: text(80), rows },
          { title: next() < 0.5 ? text(20) : undefined, ruler: next() < 0.8, rows: rows.slice(1) },
        ],
        summary: text(240),
      }
      for (const row of renderCommandTable(spec)) {
        if (displayWidth(row) > width) {
          throw new Error(
            `case ${n}: width ${width}, row ${displayWidth(row)}: ${JSON.stringify(row)}`,
          )
        }
      }
    }
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it("holds when no column can drop and the width is very short", () => {
    const spec: CommandTableSpec = {
      width: 40,
      color: true,
      columns: [
        { key: "a", width: 20 },
        { key: "b", width: 20 },
        { key: "c", flex: true, minWidth: 20 },
      ],
      sections: [
        { rows: [{ cells: { a: "日本語".repeat(9), b: "x".repeat(30), c: "🙂".repeat(30) } }] },
      ],
    }
    for (const row of renderCommandTable(spec)) expect(displayWidth(row)).toBeLessThanOrEqual(40)
  })
})
