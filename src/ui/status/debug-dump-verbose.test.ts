/**
 * `--debug --verbose` request dump: real lines, a line-number gutter, and one
 * reference line per part and per subpart.
 *
 * @module ui/status/debug-dump-verbose.test
 */

import { describe, expect, it } from "bun:test"
import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"
import { type FixtureRow, fakeOrigins, VERBOSE_ROWS } from "./debug-dump.fixtures.ts"
import { RequestDumpCollector, renderDumpBlock } from "./debug-dump.ts"

/** Strip SGR so assertions can look for text, not escapes. */
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

/** Feed fixture rows through the collector; return the one block. */
function collect(rows: readonly FixtureRow[]) {
  const collector = new RequestDumpCollector()
  const done = []
  for (let i = 0; i < rows.length; i++) {
    const [text, data] = rows[i]
    const sd = { row: i, ...data, ...(i === rows.length - 1 ? { last: true } : {}) }
    const block = collector.push(text, sd)
    if (block !== null) done.push(block)
  }
  expect(done).toHaveLength(1)
  return done[0]
}

const block = collect(VERBOSE_ROWS)
const plain = renderDumpBlock(block, undefined, { origins: fakeOrigins() }).map(strip)

describe("verbose dump: real lines", () => {
  it("prints each source line on its own line with a gutter", () => {
    expect(plain).toContain("      #1 user")
    expect(plain).toContain("         1 │ fix this:")
    expect(plain).toContain("         2 │     indented line")
    // The one-line preview of the labelled row is not repeated.
    expect(plain.join("\n")).not.toContain("⏎")
  })

  it("restarts the numbers at 1 for each part", () => {
    const i = plain.indexOf("      #2 assistant")
    expect(plain.slice(i)).toContain("         1 │ {")
    expect(plain).toContain('         2 │   "command": "ls"')
    expect(plain).toContain("         1 │ README.md")
    expect(plain).toContain("         1 │ Discover, inspect and load an Agent Skill.")
    expect(plain).toContain("         1 │ Run a command")
  })

  it("right-aligns the gutter to the widest number of the part", () => {
    const text = Array.from({ length: 12 }, (_, i) => `l${i + 1}`)
    const rows: FixtureRow[] = [
      ["--- POST m ---"],
      ["  Body:"],
      ["    system: [1 block(s)]"],
      ["      block 0: l1 ⏎ …", { kind: "part", section: "system", part: 0 }],
      ...text.map(
        (t, i): FixtureRow => [t, { kind: "line", section: "system", part: 0, line: i + 1 }],
      ),
    ]
    const out = renderDumpBlock(collect(rows)).map(strip)
    expect(out).toContain("          1 │ l1")
    expect(out).toContain("         12 │ l12")
  })

  it("prints an empty line as a bare gutter", () => {
    expect(plain).toContain("         4 │")
  })

  it("keeps the cache marker on the part header", () => {
    expect(plain).toContain("      #3 user [← cached prefix ends here]")
    expect(plain).toContain("      block 0 [cached]")
    expect(plain).toContain("      Skill")
  })

  it("strips C0 controls and a trailing CR, and expands a tab to fixed spaces", () => {
    const rows: FixtureRow[] = [
      ["--- POST m ---"],
      ["  Body:"],
      ["    tools: [1 tool(s)]"],
      ["      T: x", { kind: "part", section: "tools", part: 0 }],
      ["a\x1b[31mb\tc\r", { kind: "line", section: "tools", part: 0, line: 1 }],
    ]
    const out = renderDumpBlock(collect(rows))
    // A kept tab counts 0 cells but paints up to 8, so it drifts the gutter.
    expect(out.map(strip)).toContain("         1 │ a[31mb    c")
    expect(out.map(strip).join("\n")).not.toContain("\t")
  })

  it("strips C1 controls, so a UTF-8 CSI cannot start a sequence", () => {
    // U+009B is the single-character CSI of ECMA-48: stripping only ESC
    // leaves a working escape-sequence opener.
    const rows: FixtureRow[] = [
      ["--- POST m ---"],
      ["  Body:"],
      ["    tools: [1 tool(s)]"],
      ["      T: x", { kind: "part", section: "tools", part: 0 }],
      ["\u009b31mC1", { kind: "line", section: "tools", part: 0, line: 1 }],
    ]
    const raw = renderDumpBlock(collect(rows)).join("\n")
    expect(raw).not.toContain("\u009b")
    expect(raw).toContain("31mC1")
    // Same for every other C1 byte.
    expect(raw).not.toMatch(/[\u0080-\u009f]/)
  })

  it("cuts a too-long line to the room it has, not to the whole line", () => {
    const rows: FixtureRow[] = [
      ["--- POST m ---"],
      ["  Body:"],
      ["    tools: [1 tool(s)]"],
      ["      T: x", { kind: "part", section: "tools", part: 0 }],
      ["x".repeat(40), { kind: "line", section: "tools", part: 0, line: 1 }],
    ]
    const b = collect(rows)
    /** Only the gutter and ref lines: the section header is clipped by `width`. */
    const fitted = (raw: string[]): string[] =>
      raw.map(strip).filter((l) => l.includes(" │ ") || l.includes("↳"))
    // 13 cells leave 1 cell before the bar and none after it: the line clips.
    const narrow = fitted(renderDumpBlock(b, undefined, { wrapWidth: 13 }))
    for (const l of narrow) expect(displayWidth(l)).toBeLessThanOrEqual(13)
    expect(narrow.join("\n")).not.toContain("xxxx")
    expect(narrow).toContain("         1 │ ")
    // 20 cells leave 7 for text, which is what gets painted.
    const wide = fitted(renderDumpBlock(b, undefined, { wrapWidth: 20 }))
    expect(wide).toContain(`         1 │ ${"x".repeat(7)}`)
    expect(wide).toContain(`           │ ${"x".repeat(7)}`)
    for (const l of wide) expect(displayWidth(l)).toBeLessThanOrEqual(20)
  })

  it("strips control bytes out of a plugin tool name before styling it", () => {
    const rows: FixtureRow[] = [
      ["--- POST m ---"],
      ["  Body:"],
      ["    tools: [1 tool(s)]"],
      ["      Ev\u001b[31mil\u009b0m: x", { kind: "part", section: "tools", part: 0 }],
      ["x", { kind: "line", section: "tools", part: 0, line: 1 }],
    ]
    const raw = renderDumpBlock(collect(rows)).join("\n")
    expect(raw).not.toContain("\u001b[31mil")
    expect(raw).not.toContain("\u009b")
    expect(raw).toContain("\x1b[35mEv[31mil0m\x1b[39m")
  })

  it("strips control bytes out of a message role and a system block label", () => {
    const rows: FixtureRow[] = [
      ["--- POST m ---"],
      ["  Body:"],
      ["    messages: [1 message(s)]"],
      ['      us\u001b[31mer: "hi"', { kind: "part", section: "messages", part: 0 }],
      ['"hi"', { kind: "line", section: "messages", part: 0, line: 1 }],
      ["    system: [1 block(s)]"],
      ["      bl\u009b1mock 0 [cached]: x", { kind: "part", section: "system", part: 0 }],
      ["x", { kind: "line", section: "system", part: 0, line: 1 }],
    ]
    const raw = renderDumpBlock(collect(rows)).join("\n")
    expect(raw).not.toMatch(/[\u0080-\u009f]/)
    expect(raw).not.toContain("\u001b[31mer")
    expect(raw).toContain("\x1b[32mus[31mer\x1b[39m")
    expect(raw).toContain("\x1b[35mbl1mock 0\x1b[39m")
  })

  it("strips control bytes out of every reference-line source", () => {
    const rows: FixtureRow[] = [
      ["--- POST m ---"],
      ["  Body:"],
      ["    messages: [2 message(s)]"],
      ['      user: "x"', { kind: "part", section: "messages", part: 0 }],
      [
        "        block 0 tool_use",
        {
          kind: "block",
          section: "messages",
          part: 0,
          block: 0,
          blockType: "tool_use",
          toolUseId: "a\u001b[31m1",
          toolName: "Ba\u009bsh",
        },
      ],
      ["{}", { kind: "line", section: "messages", part: 0, block: 0, line: 1 }],
      ["      user: y", { kind: "part", section: "messages", part: 1 }],
      [
        "        block 0 tool_result",
        {
          kind: "block",
          section: "messages",
          part: 1,
          block: 0,
          blockType: "tool_result",
          toolUseId: "a\u001b[31m1",
          isError: false,
        },
      ],
      ["y", { kind: "line", section: "messages", part: 1, block: 0, line: 1 }],
      ["    system: [1 block(s)]"],
      [
        '      block 0: <ma::sys::tool name="\u009bX">',
        { kind: "part", section: "system", part: 0 },
      ],
      ['<ma::sys::tool name="\u009bX">', { kind: "line", section: "system", part: 0, line: 1 }],
      ["    tools: [1 tool(s)]"],
      ["      T\u009b: x", { kind: "part", section: "tools", part: 0 }],
      ["x", { kind: "line", section: "tools", part: 0, line: 1 }],
    ]
    const origins = {
      ...fakeOrigins(),
      toolOwners: () => new Map([["T", { pluginId: "p\u001b[31mid", packageDir: "/x" }]]),
      getPromptProvenance: () => ({
        afterInstructions: [],
        sessionContext: [],
      }),
    }
    const raw = renderDumpBlock(collect(rows), undefined, { origins }).map(strip).join("\n")
    expect(raw).not.toMatch(/[\u0080-\u009f]/)
    expect(raw).not.toContain("\u001b[31m1")
    expect(raw).toContain("↳ tool_use · Bash · #a[31m1")
    expect(raw).toContain("↳ tool_result · from tool_use Bash #a[31m1")
    expect(raw).toContain('↳ <ma::sys::tool name="X"> · origin not recorded')
    expect(raw).toContain("↳ p[31mid")
  })

  it("fits a reference line to the wrap width", () => {
    const rows: FixtureRow[] = [
      ["--- POST m ---"],
      ["  Body:"],
      ["    system: [1 block(s)]"],
      ['      block 0: <ma::sys::tool name="Skill">', { kind: "part", section: "system", part: 0 }],
      ['<ma::sys::tool name="Skill">', { kind: "line", section: "system", part: 0, line: 1 }],
    ]
    const narrow = renderDumpBlock(collect(rows), undefined, {
      origins: fakeOrigins(),
      wrapWidth: 30,
    }).map(strip)
    for (const l of narrow) expect(displayWidth(l)).toBeLessThanOrEqual(30)
    // A ref names one origin, so it truncates instead of wrapping.
    expect(narrow).toContain("         ↳ ma-skills-plugin ·…")
    expect(narrow).not.toContain('         ↳ ma-skills-plugin · <ma::sys::tool name="Skill">')
  })
})

describe("verbose dump: wrap", () => {
  it("wraps a long line with a hanging indent under the text column", () => {
    const rows: FixtureRow[] = [
      ["--- POST m ---"],
      ["  Body:"],
      ["    tools: [1 tool(s)]"],
      ["      T: x", { kind: "part", section: "tools", part: 0 }],
      ["x".repeat(40), { kind: "line", section: "tools", part: 0, line: 1 }],
    ]
    const b = collect(rows)
    const out = renderDumpBlock(b, undefined, { wrapWidth: 30 }).map(strip)
    const i = out.findIndex((l) => l.startsWith("         1 │ "))
    expect(out[i]).toBe(`         1 │ ${"x".repeat(17)}`)
    expect(out[i + 1]).toBe(`           │ ${"x".repeat(17)}`)
    expect(out[i + 2]).toBe(`           │ ${"x".repeat(6)}`)
    for (const l of out) expect(l.length).toBeLessThanOrEqual(30)
    // No wrap width: the line stays whole.
    expect(renderDumpBlock(b).map(strip)).toContain(`         1 │ ${"x".repeat(40)}`)
  })
})

describe("verbose dump: elided rows", () => {
  /** A tools part with `shown` lines and one truncation hint. */
  const capped = (shown: number, hidden: number): FixtureRow[] => [
    ["--- POST m ---"],
    ["  Body:"],
    ["    tools: [1 tool(s)]"],
    ["      Bash: Run a command", { kind: "part", section: "tools", part: 0 }],
    ...Array.from(
      { length: shown },
      (_, i): FixtureRow => [`l${i + 1}`, { kind: "line", section: "tools", part: 0, line: i + 1 }],
    ),
    ["", { kind: "elided", section: "tools", part: 0, hiddenLines: hidden }],
  ]

  it("prints one hint line after the shown lines, with the hidden count", () => {
    const out = renderDumpBlock(collect(capped(200, 4800))).map(strip)
    // The gutter stays faithful for every shown line.
    expect(out).toContain("           1 │ l1")
    expect(out).toContain("         200 │ l200")
    expect(out.filter((l) => l.includes(" │ l"))).toHaveLength(200)
    // Exactly one hint, and it names the count core sent as data.
    const hints = out.filter((l) => l.includes("4800"))
    expect(hints).toHaveLength(1)
    expect(hints[0]).toBe("           ⋯ │ 4800 more lines")
    // The hint comes AFTER the last shown line, never inside the gutter run.
    expect(out[out.indexOf("         200 │ l200") + 1]).toBe("           ⋯ │ 4800 more lines")
    expect(out.indexOf("           ⋯ │ 4800 more lines")).toBeGreaterThan(
      out.indexOf("         200 │ l200"),
    )
  })

  it("says `line` for one hidden line and `lines` above one", () => {
    const one = renderDumpBlock(collect(capped(1, 1))).map(strip)
    expect(one).toContain("         1 │ l1")
    expect(one).toContain("         ⋯ │ 1 more line")
    const many = renderDumpBlock(collect(capped(1, 2))).map(strip)
    expect(many).toContain("         ⋯ │ 2 more lines")
  })

  it("wraps the hint under the text column of the gutter", () => {
    const out = renderDumpBlock(collect(capped(2, 4800)), undefined, {
      wrapWidth: 20,
    }).map(strip)
    // The section header is not part of the gutter form, so only the gutter
    // lines are measured.
    for (const l of out.filter((x) => x.includes(" │ ")))
      expect(displayWidth(l)).toBeLessThanOrEqual(20)
    // room = 20 - (9 indent + 1 digit + 3 bar) = 7 cells of hint per line.
    expect(out).toContain("         ⋯ │ 4800 mo")
    expect(out).toContain("           │ re line")
    expect(out).toContain("           │ s")
    // The line numbering of the shown lines did not move.
    expect(out).toContain("         1 │ l1")
    expect(out).toContain("         2 │ l2")
  })

  it("renders exactly as before when no elided row arrived", () => {
    const rows: FixtureRow[] = [
      ["--- POST m ---"],
      ["  Body:"],
      ["    tools: [1 tool(s)]"],
      ["      Bash: Run a command", { kind: "part", section: "tools", part: 0 }],
      ["a", { kind: "line", section: "tools", part: 0, line: 1 }],
      ["b", { kind: "line", section: "tools", part: 0, line: 2 }],
    ]
    const b = collect(rows)
    // `elided` stays absent, not an empty array: the part shape is unchanged.
    expect(b.sections[0].parts?.[0]).not.toHaveProperty("elided")
    expect(renderDumpBlock(b).map(strip)).toEqual([
      "",
      "--- POST m ---",
      "  Body:",
      "    tools: [1 tool(s)]",
      "      Bash",
      "         ↳ core · built-in",
      "         1 │ a",
      "         2 │ b",
    ])
  })

  it("drops an elided row that arrives before any part row", () => {
    const rows: FixtureRow[] = [
      ["--- POST m ---"],
      ["  Body:"],
      ["    tools: [1 tool(s)]"],
      ["", { kind: "elided", section: "tools", part: 0, hiddenLines: 9 }],
      ["      Bash: Run a command", { kind: "part", section: "tools", part: 0 }],
      ["x", { kind: "line", section: "tools", part: 0, line: 1 }],
    ]
    const b = collect(rows)
    expect(b.sections[0].parts?.[0]).not.toHaveProperty("elided")
    const out = renderDumpBlock(b).map(strip).join("\n")
    expect(out).not.toContain("9 more")
    expect(out).toContain("         1 │ x")
  })

  it("shows no hint in the compact form", () => {
    const b = collect(capped(2, 4800))
    const compact = renderDumpBlock(b, undefined, { enabled: false }).map(strip)
    expect(compact.join("\n")).not.toContain("4800")
    expect(compact.join("\n")).not.toContain("⋯")
    // The part label and its lines still print, so no text is lost.
    expect(compact).toContain("      Bash")
    expect(compact).toContain("      l1")
    expect(compact).toContain("      l2")
  })
})

describe("verbose dump: reference lines", () => {
  it("names the block type of each message", () => {
    expect(plain).toContain("         ↳ text")
    expect(plain).toContain("         ↳ tool_use · Bash · #a1")
  })

  it("names the tool of a tool_result through its tool_use id", () => {
    expect(plain).toContain("         ↳ tool_result · from tool_use Bash #a1")
  })

  it("names the core slot and each plugin section of a system block", () => {
    const i = plain.indexOf("         ↳ core · sessionContext")
    expect(i).toBeGreaterThan(0)
    const skill = plain.indexOf(
      '         ↳ ma-skills-plugin · <ma::sys::tool name="Skill"> · plugins/ma-skills-plugin',
    )
    expect(skill).toBe(i + 1)
    expect(plain[skill + 1]).toBe('         1 │ <ma::sys::tool name="Skill">')
    const env = plain.indexOf(
      '         ↳ ma-env-info-plugin · <ma::sys::context name="environment"> · plugins/ma-env-info-plugin',
    )
    expect(plain[env + 1]).toBe('         5 │ <ma::sys::context name="environment">')
  })

  it("names the owner of each tool", () => {
    expect(plain).toContain("         ↳ ma-skills-plugin · plugins/ma-skills-plugin")
    expect(plain).toContain("         ↳ core · built-in")
    const i = plain.indexOf("      Mystery")
    expect(plain[i + 1]).toBe("         ↳ origin not recorded")
  })

  it("names a <ma::agent::NAME> attachment", () => {
    const rows: FixtureRow[] = [
      ["--- POST m ---"],
      ["  Body:"],
      ["    messages: [1 message(s)]"],
      ['      user: "<ma::agent::tasks> …"', { kind: "part", section: "messages", part: 0 }],
      [
        "        block 0 text",
        { kind: "block", section: "messages", part: 0, block: 0, blockType: "text" },
      ],
      ["<ma::agent::tasks>", { kind: "line", section: "messages", part: 0, block: 0, line: 1 }],
      ["</ma::agent::tasks>", { kind: "line", section: "messages", part: 0, block: 0, line: 2 }],
    ]
    const out = renderDumpBlock(collect(rows)).map(strip)
    expect(out).toContain("         ↳ attachment · <ma::agent::tasks>")
  })

  it("prints 'origin not recorded' when the loader has no data", () => {
    const bare = renderDumpBlock(block).map(strip)
    const sys = bare.indexOf("      block 0 [cached]")
    expect(bare[sys + 1]).toBe("         ↳ origin not recorded")
    expect(bare).toContain('         ↳ <ma::sys::tool name="Skill"> · origin not recorded')
    const skill = bare.indexOf("      Skill")
    expect(bare[skill + 1]).toBe("         ↳ origin not recorded")
    // Message refs come from the dump itself, so they stay.
    expect(bare).toContain("         ↳ tool_result · from tool_use Bash #a1")
  })

  it("never throws on a loader whose getters throw", () => {
    const broken = {
      loadedPackages: () => {
        throw new Error("boom")
      },
      toolOwners: () => {
        throw new Error("boom")
      },
    }
    expect(() => renderDumpBlock(block, undefined, { origins: broken })).not.toThrow()
  })
})
