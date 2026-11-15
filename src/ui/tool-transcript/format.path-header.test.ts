/**
 * Width-aware, path-aware tool headers for Read/Write/Edit/Glob/Grep.
 *
 * The header body is sized to the row, so the filename and the Grep pattern
 * stay visible instead of being lost to the end-cut `...(+Nch)` marker of
 * the row clamp. Every case passes an explicit `pathContext`, so no result
 * depends on the host cwd or home dir.
 */
import { describe, expect, it } from "bun:test"
import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"
import type { ToolUseBlock } from "@minimal-agent/core/sdk/messages"

import { formatToolHeaderRows, formatToolInput } from "./format.ts"

const CTX = { cwd: "/Users/dev/Projects/mono", home: "/Users/dev" }
const CLI_FILE = "/Users/dev/Projects/mono/minimal-agent-cli/src/ui/tool-transcript/format.ts"

function tu(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: "tool_use", id: "test", name, input } as ToolUseBlock
}

/** Strip SGR escapes so assertions read the visible text. */
function plain(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR escapes are the point.
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

/** The visible header row for `tool` at `cols`. */
function header(tool: ToolUseBlock, cols: number | undefined, timeText?: string): string {
  return formatToolHeaderRows({ tool, cols, timeText, pathContext: CTX })[0] ?? ""
}

describe("Read header path compaction", () => {
  it.each([80, 60, 40])("keeps the filename visible and fits %i cols", (cols) => {
    const row = header(tu("Read", { file_path: CLI_FILE }), cols)
    expect(plain(row)).toContain("format.ts")
    expect(row).not.toContain("...(+")
    expect(displayWidth(row)).toBeLessThanOrEqual(cols)
  })

  it("shows the relativized path in full when it fits", () => {
    expect(plain(header(tu("Read", { file_path: CLI_FILE }), 80))).toBe(
      "  ╭ ◆ Read  minimal-agent-cli/src/ui/tool-transcript/format.ts",
    )
  })

  it("keeps the line range suffix when the path shrinks", () => {
    const row = plain(header(tu("Read", { file_path: CLI_FILE, offset: 9, limit: 41 }), 50))
    expect(row).toEndWith("format.ts · L10-50")
    expect(displayWidth(row)).toBeLessThanOrEqual(50)
  })

  it("keeps the `from L` suffix and the time suffix", () => {
    const row = plain(header(tu("Read", { file_path: CLI_FILE, offset: 99 }), 60, "12:00:00"))
    expect(row).toContain("format.ts · from L100")
    expect(row).toEndWith(" · 12:00:00")
    expect(displayWidth(row)).toBeLessThanOrEqual(60)
  })
})

describe("Edit header path compaction", () => {
  it("keeps the sed-style `· g` suffix", () => {
    const tool = tu("Edit", {
      file_path: CLI_FILE.replace("format.ts", "format.path-header.test.ts"),
      old_string: "a",
      new_string: "b",
      replace_all: true,
    })
    for (const cols of [100, 70, 50]) {
      const row = plain(header(tool, cols))
      expect(row).toEndWith("format.path-header.test.ts · g")
      expect(displayWidth(row)).toBeLessThanOrEqual(cols)
    }
  })
})

describe("Glob header path compaction", () => {
  it("keeps the pattern whole and compacts the `in <dir>` part", () => {
    const tool = tu("Glob", {
      pattern: "**/*.test.ts",
      path: "/Users/dev/Projects/mono/minimal-agent-cli/src/ui/tool-transcript",
    })
    expect(plain(header(tool, 100))).toBe(
      "  ╭ ◆ Glob  **/*.test.ts · in minimal-agent-cli/src/ui/tool-transcript",
    )
    const row = plain(header(tool, 50))
    expect(row).toStartWith("  ╭ ◆ Glob  **/*.test.ts · in ")
    expect(row).toEndWith("tool-transcript")
    expect(displayWidth(row)).toBeLessThanOrEqual(50)
  })
})

describe("Grep header compaction", () => {
  const tool = tu("Grep", {
    pattern: "formatToolHeaderRows|formatToolInput|clampTranscriptRow|planBashInput",
    "-i": true,
    path: "/Users/dev/Projects/mono/minimal-agent-cli/src/ui",
    glob: "*.ts",
    "-C": 3,
    head_limit: 50,
  })

  it("at 100 cols keeps whole alternatives, the path, and every modifier", () => {
    const row = plain(header(tool, 100))
    expect(row).toContain("/formatToolHeaderRows|formatToolInput|…/i · in ")
    expect(row).toContain(" · *.ts · ↕3 · ≤50")
    expect(row).not.toContain("...(+")
    expect(displayWidth(row)).toBeLessThanOrEqual(100)
  })

  it("at 70 cols shortens the pattern at a `|` and keeps the closing `/flags`", () => {
    const row = plain(header(tool, 70))
    expect(row).toContain("/formatToolHeaderRows|…/i · in ")
    expect(row).toEndWith(" · *.ts · ↕3 · ≤50")
    expect(row).not.toContain("...(+")
    expect(displayWidth(row)).toBeLessThanOrEqual(70)
  })

  it("at 60 cols drops the modifiers lowest first and counts the drops", () => {
    const wide = tu("Grep", { ...tool.input, output_mode: "count" })
    const row = plain(header(wide, 60))
    expect(row).toContain("/formatToolHeaderRows|…/i · in ")
    // `count` is the lowest modifier and goes first, `*.ts` is the highest.
    expect(row).not.toContain("count")
    expect(row).toMatch(/ · \+\d+$/)
    expect(row).not.toContain("...(+")
    expect(displayWidth(row)).toBeLessThanOrEqual(60)
  })

  it("drops modifiers only from the low end", () => {
    const wide = tu("Grep", { ...tool.input, output_mode: "count" })
    const order = ["*.ts", "↕3", "≤50", "count"]
    for (const cols of [100, 80, 70, 60, 50]) {
      const row = plain(header(wide, cols))
      const kept = order.map((m) => row.includes(` · ${m}`))
      // Once a modifier is gone, every lower one is gone too.
      expect(kept).toEqual([...kept].sort((a, b) => Number(b) - Number(a)))
      expect(row).toMatch(/\/i( · |$)/)
    }
  })

  it("cuts the middle of a pattern with no `|`", () => {
    const long = tu("Grep", { pattern: `export function ${"x".repeat(80)}End`, path: "/src" })
    const row = plain(header(long, 60))
    expect(row).toContain("…")
    expect(row).toMatch(/End\/ · in \/src$/)
    expect(displayWidth(row)).toBeLessThanOrEqual(60)
  })

  it("keeps the full chain when it fits", () => {
    const short = tu("Grep", { pattern: "foo", path: "/src", glob: "*.ts", output_mode: "count" })
    expect(plain(header(short, 100))).toBe("  ╭ ◆ Grep  /foo/ · in /src · *.ts · count")
  })
})

describe("Grep header final fit (review fix 1)", () => {
  const heavy = tu("Grep", {
    pattern: `${"q".repeat(58)}needle${"z".repeat(56)}`,
    "-i": true,
    path: "/opt/vendor/some/very/long/library/path/that/goes/on/and/on/src",
    glob: "**/*.{ts,tsx}",
    "-C": 3,
    head_limit: 250,
    output_mode: "count",
  })
  const widths = Array.from({ length: 101 }, (_, i) => i + 20)

  it.each([undefined, "12:00:00"])("fits every width from 20 to 120 (time %p)", (time) => {
    for (const cols of widths) {
      const row = header(heavy, cols, time)
      expect(displayWidth(row)).toBeLessThanOrEqual(cols)
      if (cols >= 30) {
        expect(row).not.toContain("...(+")
        expect(plain(row)).toContain("/i")
      }
    }
  })
})

describe("Grep pattern split at top-level `|` only (review fix 2)", () => {
  const body = (pattern: string, cols = 50): string =>
    plain(header(tu("Grep", { pattern }), cols)).replace(/^ {2}╭ ◆ Grep {2}/, "")

  it("does not split inside a character class", () => {
    const out = body(`[|]${"x".repeat(80)}`)
    expect(out).not.toMatch(/^\/\[\|…\//)
    expect(out).toContain("…")
  })

  it("does not cut inside a group", () => {
    const out = body(`(foo|bar|baz)qux${"y".repeat(80)}`)
    expect(out).not.toMatch(/^\/\(foo\|…/)
    expect(out).not.toMatch(/^\/\(foo\|bar\|…/)
  })

  it("does not cut at an escaped `\\|`", () => {
    const out = body(`a\\|b\\|c${"w".repeat(80)}`)
    expect(out).not.toMatch(/^\/a\\\|…/)
    expect(out).not.toMatch(/^\/a\\\|b\\\|…/)
  })

  it("still cuts at whole top-level alternatives", () => {
    const out = body(`alpha|beta|gamma|${"long".repeat(20)}`)
    expect(out).toMatch(/^\/alpha\|beta\|(gamma\|)?…\/$/)
  })
})

describe("tiny widths (review fix 3)", () => {
  it.each([20, 25, 30])("a Read header fits %i cols with no clamp marker", (cols) => {
    const row = header(tu("Read", { file_path: CLI_FILE }), cols)
    expect(row).not.toContain("...(+")
    expect(displayWidth(row)).toBeLessThanOrEqual(cols)
  })

  it.each([20, 25, 30])("a Read header with a time hint fits %i cols", (cols) => {
    const row = header(tu("Read", { file_path: CLI_FILE }), cols, "12:00:00")
    expect(row).not.toContain("...(+")
    expect(displayWidth(row)).toBeLessThanOrEqual(cols)
  })
})

describe("paths outside cwd and home", () => {
  const outside = "/opt/vendor/lib/deep/nested/module/index.ts"

  it("stays absolute when it fits", () => {
    expect(plain(header(tu("Read", { file_path: outside }), 100))).toBe(`  ╭ ◆ Read  ${outside}`)
  })

  it("is compacted when it does not fit", () => {
    const row = plain(header(tu("Read", { file_path: outside }), 40))
    expect(row).toEndWith("index.ts")
    expect(row).not.toContain(outside)
    expect(displayWidth(row)).toBeLessThanOrEqual(40)
  })
})

describe("unknown width", () => {
  it("returns the full relativized path with no width cut", () => {
    expect(formatToolInput(tu("Read", { file_path: CLI_FILE }), undefined, undefined, CTX)).toBe(
      "minimal-agent-cli/src/ui/tool-transcript/format.ts",
    )
    expect(plain(header(tu("Read", { file_path: CLI_FILE }), undefined))).toBe(
      "  ╭ ◆ Read  minimal-agent-cli/src/ui/tool-transcript/format.ts",
    )
  })

  it("relativizes a home path to `~`", () => {
    expect(
      formatToolInput(tu("Write", { file_path: "/Users/dev/a/b.md" }), undefined, undefined, CTX),
    ).toBe("~/a/b.md")
  })
})
