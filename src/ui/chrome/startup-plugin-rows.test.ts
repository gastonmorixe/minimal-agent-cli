import { describe, expect, test } from "bun:test"

import { displayWidth, stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { c } from "../style/ansi.ts"

import { renderStartupPluginRows, type StartupRow } from "./startup-plugin-rows.ts"

const PLAIN = { cols: 200, plain: true }
const COLOR = { cols: 200, plain: false }

const HOOKS: StartupRow = {
  label: "hooks",
  summary: [
    { text: "3 active", tone: "ok" },
    { text: "1 untrusted", tone: "warn" },
  ],
  children: [
    {
      label: "turn.willStart",
      value: [{ text: "timestamp.sh", tone: "accent" }, { text: "before" }],
    },
    {
      label: "tool.willInvoke",
      value: [{ text: "Bash → guard.sh", tone: "accent" }, { text: "claude" }],
    },
    {
      label: "turn.willStop",
      value: [
        { text: "Stop → run-tests.sh", tone: "accent" },
        { text: "claude" },
        { text: "untrusted", tone: "warn" },
      ],
    },
  ],
}

function manyChildren(n: number): StartupRow {
  return {
    label: "hooks",
    summary: [{ text: `${n} active` }],
    children: Array.from({ length: n }, (_, i) => ({
      label: `ch${i}`,
      value: [{ text: `v${i}` }],
    })),
  }
}

describe("renderStartupPluginRows", () => {
  test("reproduces the H1 design sample in plain mode", () => {
    const out = renderStartupPluginRows([HOOKS], PLAIN).join("\n")
    expect(out).toBe(
      [
        "  │ hooks      3 active · 1 untrusted",
        "  │   ├ turn.willStart   timestamp.sh  before",
        "  │   ├ tool.willInvoke  Bash → guard.sh  claude",
        "  │   └ turn.willStop    Stop → run-tests.sh  claude · untrusted",
      ].join("\n"),
    )
  })

  test("draws ├ for inner children and └ for the last child", () => {
    const lines = renderStartupPluginRows([HOOKS], PLAIN)
    expect(lines[1]).toContain("├ ")
    expect(lines[2]).toContain("├ ")
    expect(lines[3]).toContain("└ ")
  })

  test("pads child labels to the widest label in the group", () => {
    const row: StartupRow = {
      label: "x",
      summary: [{ text: "s" }],
      children: [
        { label: "a", value: [{ text: "one" }] },
        { label: "abcdef", value: [{ text: "two" }] },
      ],
    }
    const lines = renderStartupPluginRows([row], PLAIN)
    expect(lines[1]!.indexOf("one")).toBe(lines[2]!.indexOf("two"))
    expect(lines[2]).toBe("  │   └ abcdef  two")
  })

  test("truncates every line to cols", () => {
    const lines = renderStartupPluginRows([HOOKS], { cols: 30, plain: false })
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(30)
    expect(stripAnsi(lines[3]!).endsWith("...")).toBe(true)
  })

  test("caps children at 8 and adds a more line", () => {
    const lines = renderStartupPluginRows([manyChildren(10)], PLAIN)
    expect(lines).toHaveLength(1 + 8 + 1)
    expect(lines[8]).toBe("  │   ├ ch7  v7")
    expect(lines[9]).toBe("  │   └ … 2 more")
  })

  test("plain mode has no ESC character", () => {
    const out = renderStartupPluginRows([HOOKS, manyChildren(10)], { ...PLAIN, last: true })
    expect(out.join("\n").includes("\x1b")).toBe(false)
  })

  test("tones map to theme styles in color mode", () => {
    const row: StartupRow = {
      label: "t",
      summary: [
        { text: "d" },
        { text: "m", tone: "dim" },
        { text: "a", tone: "accent" },
        { text: "w", tone: "warn" },
        { text: "o", tone: "ok" },
      ],
    }
    const [line] = renderStartupPluginRows([row], COLOR)
    const sep = c.dim(" · ")
    expect(line).toContain(`d${sep}${c.dim("m")}${sep}${c.sky("a")}${sep}${c.yellow("w")}`)
    expect(line).toContain(`${sep}${c.green("o")}`)
    expect(line).toContain(c.faintWhite("│"))
    expect(line).toContain(c.sky("t".padEnd(9)))
  })

  test("omits a row with an empty summary and no children", () => {
    const rows: StartupRow[] = [
      { label: "empty", summary: [] },
      { label: "kids", summary: [], children: [] },
      { label: "kept", summary: [{ text: "ok" }] },
    ]
    expect(renderStartupPluginRows(rows, PLAIN)).toEqual(["  │ kept       ok"])
  })

  test("sorts by order, unordered rows keep input order after", () => {
    const rows: StartupRow[] = [
      { label: "u1", summary: [{ text: "x" }] },
      { label: "o5", summary: [{ text: "x" }], order: 5 },
      { label: "u2", summary: [{ text: "x" }] },
      { label: "o1", summary: [{ text: "x" }], order: 1 },
    ]
    const labels = renderStartupPluginRows(rows, PLAIN).map((l) => l.slice(4, 6))
    expect(labels).toEqual(["o1", "o5", "u1", "u2"])
  })

  test("last closes the final row with ╰ and no │ under it", () => {
    const rows: StartupRow[] = [{ label: "a", summary: [{ text: "x" }] }, HOOKS]
    const lines = renderStartupPluginRows(rows, { ...PLAIN, last: true })
    expect(lines[0]).toBe("  │ a          x")
    expect(lines[1]).toBe("  ╰ hooks      3 active · 1 untrusted")
    for (const line of lines.slice(2)) expect(line.startsWith("      ")).toBe(true)
    expect(lines.slice(2).join("").includes("│")).toBe(false)
  })

  test("an unknown tone renders as default in color mode", () => {
    const row = { label: "t", summary: [{ text: "r", tone: "red" }] } as unknown as StartupRow
    const [line] = renderStartupPluginRows([row], COLOR)
    expect(line).toContain("  r")
    expect(stripAnsi(line!)).toBe("  │ t          r")
  })

  test("pads child labels by display width (CJK)", () => {
    const row: StartupRow = {
      label: "x",
      summary: [{ text: "s" }],
      children: [
        { label: "日本", value: [{ text: "one" }] },
        { label: "abcdef", value: [{ text: "two" }] },
      ],
    }
    const lines = renderStartupPluginRows([row], PLAIN)
    expect(lines[1]).toBe("  │   ├ 日本    one")
    expect(displayWidth(lines[1]!.slice(0, lines[1]!.indexOf("one")))).toBe(
      displayWidth(lines[2]!.slice(0, lines[2]!.indexOf("two"))),
    )
  })
})
