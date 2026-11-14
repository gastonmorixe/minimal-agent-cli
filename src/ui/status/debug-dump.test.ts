/**
 * `--debug` request dump rendering.
 *
 * Locks the behavior the TUI lost in the core/CLI split: a request arrives as
 * a sequence of Debug diagnostics and comes back out as ONE colored block,
 * with the parts the user asked for (messages, system blocks, tools, cache
 * breakpoints) each styled distinctly.
 *
 * @module ui/status/debug-dump.test
 */

import { describe, expect, it } from "bun:test"
import { isRequestDumpRow, RequestDumpCollector, renderDumpBlock } from "./debug-dump.ts"
import { rowKind } from "./debug-dump-contract.ts"

/** Structured-data key the transport stamps on each dump row. */
const DUMP_ROW_INDEX = "row"
/** Structured-data flag on the final row of a dump. */
const DUMP_LAST_ROW = "last"

/** A dump like the transport emits it: plain rows, one diagnostic each. */
const DUMP = [
  "--- POST claude-opus-4-8 ---",
  "  model: claude-opus-4-8",
  "  stream: true",
  "  max_tokens: 32000",
  "  request_type: conversation",
  "  Body:",
  "    messages: [2 message(s)]",
  '      user [← cached prefix ends here]: "hi there"',
  '      assistant: "hello"',
  "    system: [2 block(s)]",
  "      block 0 [cached]: You are minimal agent.",
  "      block 1: Tools are available.",
  "    tools: [2 tool(s)]",
  "      Bash: Run a command",
  "      Read: Read a file",
]

/** Feed a whole dump through the collector, returning finished blocks. */
function collect(rows: readonly string[]) {
  const collector = new RequestDumpCollector()
  const done = []
  for (let i = 0; i < rows.length; i++) {
    const structuredData = {
      [DUMP_ROW_INDEX]: i,
      ...(i === rows.length - 1 ? { [DUMP_LAST_ROW]: true } : {}),
    }
    const block = collector.push(rows[i], structuredData)
    if (block !== null) done.push(block)
  }
  return done
}

describe("isRequestDumpRow", () => {
  it("accepts the transport source with a row index", () => {
    expect(isRequestDumpRow("transport.request-dump", { row: 0 })).toBe(true)
  })

  it("rejects another source, or a row without an index", () => {
    expect(isRequestDumpRow("transport.request-dump", undefined)).toBe(false)
    expect(isRequestDumpRow("transport.request-dump", { foo: "bar" })).toBe(false)
    expect(isRequestDumpRow("auth.login", { row: 0 })).toBe(false)
  })
})

describe("rowKind", () => {
  it("accepts the four verbose kinds and nothing else", () => {
    for (const k of ["part", "block", "line", "elided"])
      expect(rowKind({ kind: k })).toBe(k as never)
    expect(rowKind({ kind: "other" })).toBeUndefined()
    expect(rowKind({})).toBeUndefined()
    expect(rowKind(undefined)).toBeUndefined()
  })
})

describe("RequestDumpCollector", () => {
  it("collects a whole dump into one block when `last` arrives", () => {
    const blocks = collect(DUMP)
    expect(blocks).toHaveLength(1)
    const block = blocks[0]
    expect(block.label).toBe("--- POST claude-opus-4-8 ---")
    expect(block.fields).toEqual([
      ["model", "claude-opus-4-8"],
      ["stream", "true"],
      ["max_tokens", "32000"],
      ["request_type", "conversation"],
    ])
    expect(block.sections.map((s) => s.name)).toEqual(["messages", "system", "tools"])
    expect(block.sections[0].rows).toEqual([
      'user [← cached prefix ends here]: "hi there"',
      'assistant: "hello"',
    ])
    expect(block.sections[1].count).toBe("[2 block(s)]")
  })

  it("splits two back-to-back dumps into two blocks", () => {
    const collector = new RequestDumpCollector()
    const blocks = []
    for (let i = 0; i < DUMP.length; i++) {
      const b = collector.push(DUMP[i], { row: i, last: i === DUMP.length - 1 })
      if (b) blocks.push(b)
    }
    // Second request starts immediately after the first; only the header is
    // buffered until flushed.
    for (let i = 0; i < DUMP.length; i++) {
      const b = collector.push(DUMP[i], { row: i, last: i === DUMP.length - 1 })
      if (b) blocks.push(b)
    }
    expect(blocks).toHaveLength(2)
  })

  it("recovers from a dump that never sets `last`", () => {
    const collector = new RequestDumpCollector()
    const blocks = []
    for (let i = 0; i < DUMP.length; i++) {
      const b = collector.push(DUMP[i], { row: i })
      if (b) blocks.push(b)
    }
    // No block yet: the tail is still buffered.
    expect(blocks).toHaveLength(0)
    // The next request's header flushes the previous one.
    const flushed = collector.push("--- POST other ---", { row: 0 })
    expect(flushed).not.toBeNull()
    expect(flushed?.label).toBe("--- POST claude-opus-4-8 ---")
  })

  it("does not treat a section header as a row", () => {
    const blocks = collect(DUMP)
    const messages = blocks[0].sections[0]
    // `messages: [2 message(s)]` is the header; only the two previews are rows.
    expect(messages.rows).toHaveLength(2)
  })
})

/** Strip SGR so assertions can look for text, not escapes. */
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

describe("renderDumpBlock", () => {
  const block = collect(DUMP)[0]
  const lines = renderDumpBlock(block)
  const plain = strip(lines.join("\n"))

  it("keeps every part of the request visible", () => {
    for (const expected of [
      "POST claude-opus-4-8",
      "model:",
      "max_tokens:",
      "Body:",
      "messages:",
      "system:",
      "tools:",
      "block 0",
      "You are minimal agent.",
      "Bash:",
      "Read:",
      "cached prefix ends here",
    ]) {
      expect(plain).toContain(expected)
    }
  })

  it("colors the header, keys, sections and cache markers", () => {
    const joined = lines.join("\n")
    expect(joined).toContain("\x1b[1m\x1b[36m") // bold cyan header
    expect(joined).toContain("\x1b[2mmodel:\x1b[22m") // dim key
    expect(joined).toContain("\x1b[33mmessages\x1b[39m") // yellow section
    expect(joined).toContain("\x1b[32muser\x1b[39m") // green role
    expect(joined).toContain("\x1b[35mBash\x1b[39m") // magenta tool
    expect(joined).toContain("\x1b[1m\x1b[92m") // bright-green cache marker
  })

  it("styles the cache marker on a messages row", () => {
    // Regression: the marker sits BEFORE the colon, so a naive role split
    // dropped it and the whole row rendered dim.
    const cachedRow = lines.find((l) => l.includes("cached prefix")) ?? ""
    expect(cachedRow).toContain("\x1b[32muser\x1b[39m")
    expect(cachedRow).toContain("\x1b[1m\x1b[92m")
    expect(strip(cachedRow)).toContain('user [← cached prefix ends here]: "hi there"')
  })

  it("keeps the system cache marker green, not magenta", () => {
    // Regression: the marker was swallowed by the block name, so `[cached]`
    // lost its bright-green highlight and read as part of the magenta label.
    const blockRow = lines.find((l) => l.includes("block 0")) ?? ""
    expect(blockRow).toContain("\x1b[35mblock 0\x1b[39m")
    expect(blockRow).toContain("\x1b[1m\x1b[92m[cached]\x1b[39m\x1b[22m")
    expect(strip(blockRow)).toBe("      block 0 [cached]: You are minimal agent.")
  })

  it("renders one line per dump row plus headers", () => {
    // blank separator + label + 4 fields + Body + 3 section headers
    // + 6 rows (2 messages, 2 system blocks, 2 tools)
    expect(lines).toHaveLength(1 + 1 + 4 + 1 + 3 + 6)
  })

  // Regression: the section header claimed a count the body did not honor —
  // `system: [4 block(s)]` rendered only `block 0` because the other rows
  // carried newlines and the `^ {6}` row regex skipped them.
  it("renders as many rows as the section header claims", () => {
    const rows = [
      "--- POST m ---",
      "  Body:",
      "    system: [4 block(s)]",
      "      block 0: identity",
      "      block 1: # Instructions ⏎ - Be concise.",
      "      block 2: # Tools ⏎ Prefer dedicated tools.",
      "      block 3 [cached]: # Safety ⏎ Checkpoint.",
    ]
    const [block] = collect(rows)
    const system = block.sections.find((s) => s.name === "system")
    expect(system?.rows).toHaveLength(4)

    const rendered = renderDumpBlock(block).map(strip)
    expect(rendered).toContain("    system: [4 block(s)]")
    expect(rendered.filter((l) => /block \d/.test(l))).toHaveLength(4)
  })

  it("counts a label-free continuation row without inventing a label for it", () => {
    const rows = [
      "--- POST m ---",
      "  Body:",
      "    tools: [1 tool(s)]",
      "      Mode: short",
      "        the full untruncated description",
    ]
    const [block] = collect(rows)
    const tools = block.sections.find((s) => s.name === "tools")
    expect(tools?.rows).toHaveLength(1)
    expect(tools?.continuations).toBe(1)
    // The header count still matches the labelled rows.
    expect(renderDumpBlock(block).map(strip)).toContain("    tools: [1 tool(s)]")
  })

  // Regression: without `--verbose`, the transport sends a capped preview row
  // and then an 8-space continuation row with the full text. Real prompt text
  // contains `: `, so a separator test classified the continuation as a
  // labelled row and the TUI printed the full text anyway.
  it("hides an 8-space continuation row even when its text contains ': '", () => {
    const rows = [
      "--- POST m ---",
      "  Body:",
      "    messages: [1 message(s)]",
      '      user: "what is...(+40ch)',
      '        user: "what is this? note: a colon"',
      "    system: [1 block(s)]",
      "      block 0 [cached]: # Rules ⏎ CORE-01: write...(+90ch)",
      "        # Rules ⏎ CORE-01: write short sentences.",
      "    tools: [1 tool(s)]",
      "      Bash: Executes a given...(+20ch)",
      "        Executes a given bash command. Output: capped.",
    ]
    const [block] = collect(rows)
    for (const name of ["messages", "system", "tools"]) {
      const section = block.sections.find((s) => s.name === name)
      expect(section?.rows).toHaveLength(1)
      expect(section?.continuations).toBe(1)
    }
    const rendered = renderDumpBlock(block).map(strip).join("\n")
    expect(rendered).not.toContain("note: a colon")
    expect(rendered).not.toContain("write short sentences.")
    expect(rendered).not.toContain("Output: capped.")
  })

  // Regression: core caps a preview at 80 chars, but the label and indent come
  // on top, so a row overflowed and wrapped in a 93-column terminal.
  it("fits every line to the width and folds the cut into the core hint", () => {
    const rows = [
      "--- POST m ---",
      "  output_config: " + "o".repeat(60),
      "  Body:",
      "    messages: [1 message(s)]",
      `      user [← cached prefix ends here]: "${"u".repeat(60)}"`,
      "    system: [1 block(s)]",
      `      block 3 [cached]: # Schema ${"s".repeat(60)}...(+31189ch)`,
      "    tools: [2 tool(s)]",
      `      Bash: Executes ${"b".repeat(60)}...(+2334ch)`,
      "      Write: short",
    ]
    const [block] = collect(rows)
    const width = 50
    const lines = renderDumpBlock(block, width).map(strip)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(width)
    const block3 = lines.find((l) => l.includes("block 3")) ?? ""
    const bash = lines.find((l) => l.includes("Bash:")) ?? ""
    // One hint, and its count covers what core cut plus what we cut.
    expect(block3.match(/\.\.\.\(\+/g)).toHaveLength(1)
    expect(Number(/\(\+(\d+)ch\)$/.exec(block3)?.[1])).toBeGreaterThan(31189)
    expect(Number(/\(\+(\d+)ch\)$/.exec(bash)?.[1])).toBeGreaterThan(2334)
    expect(lines).toContain("      Write: short")
    expect(lines.some((l) => l.includes("[← cached prefix ends here]"))).toBe(true)
    // No width: nothing is clipped (`--verbose`, or no TTY).
    expect(renderDumpBlock(block).map(strip).join("\n")).toContain("s".repeat(60))
  })

  it("numbers message rows in non-verbose", () => {
    const rows = [
      "--- POST m ---",
      "  Body:",
      "    messages: [3 message(s)]",
      '      user: "fix this: ⏎ indented line"',
      "      assistant: tool_use(Bash#a1b2c3){command}",
      '      user [← cached prefix ends here]: tool_result(a1b2c3) "README.md ⏎ src"',
      "    system: [1 block(s)]",
      "      block 0: x",
    ]
    const out = renderDumpBlock(collect(rows)[0]).map(strip)
    expect(out).toContain('      #1 user: "fix this: ⏎ indented line"')
    expect(out).toContain("      #2 assistant: tool_use(Bash#a1b2c3){command}")
    expect(out).toContain(
      '      #3 user [← cached prefix ends here]: tool_result(a1b2c3) "README.md ⏎ src"',
    )
    // System and tools rows get no number.
    expect(out).toContain("      block 0: x")
    // The number counts toward the width fit.
    for (const l of renderDumpBlock(collect(rows)[0], 30).map(strip)) {
      expect(l.length).toBeLessThanOrEqual(30)
    }
  })

  it("a line row that reads `--- POST x ---` stays a line", () => {
    const collector = new RequestDumpCollector()
    const rows: Array<[string, Record<string, string | number | boolean>]> = [
      ["--- POST m ---", {}],
      ["  Body:", {}],
      ["    system: [1 block(s)]", {}],
      ["      block 0: a ⏎ …", { kind: "part", section: "system", part: 0 }],
      ["--- POST x ---", { kind: "line", section: "system", part: 0, line: 1 }],
      ["  Body:", { kind: "line", section: "system", part: 0, line: 2 }],
      ["    tools: [9 tool(s)]", { kind: "line", section: "system", part: 0, line: 3 }],
      ["  model: evil", { kind: "line", section: "system", part: 0, line: 4 }],
    ]
    const done = []
    for (let i = 0; i < rows.length; i++) {
      const sd = { row: i, ...rows[i][1], ...(i === rows.length - 1 ? { last: true } : {}) }
      const b = collector.push(rows[i][0], sd)
      if (b !== null) done.push(b)
    }
    expect(done).toHaveLength(1)
    const [block] = done
    expect(block.label).toBe("--- POST m ---")
    expect(block.fields).toEqual([])
    expect(block.sections.map((s) => s.name)).toEqual(["system"])
    const out = renderDumpBlock(block).map(strip)
    expect(out).toContain("         1 │ --- POST x ---")
    expect(out).toContain("         2 │   Body:")
    expect(out).toContain("         3 │     tools: [9 tool(s)]")
    expect(out).toContain("         4 │   model: evil")
  })

  // Regression: `rowKind` did not know `elided`, so an `elided` row fell
  // through to the legacy `absorb()` path. There a row with empty text was
  // classified as an unlabelled continuation and counted as an extra row.
  it("does not let an elided row fall through to the legacy path", () => {
    const rows: Array<[string, Record<string, string | number | boolean> | undefined]> = [
      ["--- POST m ---", undefined],
      ["  Body:", undefined],
      ["    tools: [1 tool(s)]", undefined],
      ["      Bash: Run a command", { kind: "part", section: "tools", part: 0 }],
      ["a", { kind: "line", section: "tools", part: 0, line: 1 }],
      // The `elided` row core emits: empty text, count only.
      ["", { kind: "elided", section: "tools", part: 0, hiddenLines: 7 }],
    ]
    const collector = new RequestDumpCollector()
    let block = null
    for (let i = 0; i < rows.length; i++) {
      const b = collector.push(rows[i][0], {
        row: i,
        ...rows[i][1],
        ...(i === rows.length - 1 ? { last: true } : {}),
      })
      if (b !== null) block = b
    }
    const tools = block?.sections[0]
    // The legacy path would have made this a continuation row.
    expect(tools?.rows).toEqual([])
    expect(tools?.continuations).toBeUndefined()
    // The count is kept as data, on the part, not lost.
    expect(tools?.parts?.[0].elided).toEqual([{ hiddenLines: 7 }])
    // Non-verbose: no extra blank row for the elided row.
    const compact = renderDumpBlock(block as never, undefined, { enabled: false }).map(strip)
    expect(compact).toEqual([
      "",
      "--- POST m ---",
      "  Body:",
      "    tools: [1 tool(s)]",
      "      Bash",
      "      a",
    ])
  })

  it("degrades to dim text for a row it cannot parse", () => {
    const odd = renderDumpBlock({
      label: "--- POST x ---",
      fields: [],
      sections: [{ name: "messages", count: undefined, rows: ["???not a role???"] }],
    })
    expect(odd.join("\n")).toContain("???not a role???")
  })

  // Regression: the non-verbose path is the DEFAULT mode and it printed every
  // core- and model-controlled string raw, so a prompt that contained an ESC
  // could recolor or move the cursor.
  it("strips control bytes from every non-verbose field", () => {
    const rows = [
      "--- POST m\u001b[31m ---",
      "  model: m\u001b[31m1",
      "  Body:",
      "    messages: [1 message(s)]",
      '      us\u009ber: "hi\u001b[31mthere"',
      "    system: [1 block(s)]",
      "      bl\u001b[31mock 0 [cached]: yo\u009bu",
      "    tools: [1 tool(s)]",
      "      Ba\u009bsh: Run a comm\u001b[31mand",
    ]
    const out = renderDumpBlock(collect(rows)[0]).join("\n")
    expect(out).not.toMatch(/[\u0080-\u009f]/)
    // The strip must not swallow the text around the byte.
    expect(strip(out)).toContain("--- POST m[31m ---")
    expect(strip(out)).toContain("model: m[31m1")
    expect(strip(out)).toContain("messages: [1 message(s)]")
    expect(strip(out)).toContain('      #1 user: "hi[31mthere"')
    expect(strip(out)).toContain("bl[31mock 0 [cached]: you")
    expect(strip(out)).toContain("Bash: Run a comm[31mand")
  })

  // Regression: the compact form shipped at the base commit, so the strip must
  // be output-identical for text that has no control bytes. The literal below
  // is the frozen output of that commit.
  it("changes nothing for text with no control bytes", () => {
    const clean = collect(DUMP)[0]
    expect(renderDumpBlock(clean).map(strip)).toEqual([
      "",
      "--- POST claude-opus-4-8 ---",
      "  model: claude-opus-4-8",
      "  stream: true",
      "  max_tokens: 32000",
      "  request_type: conversation",
      "  Body:",
      "    messages: [2 message(s)]",
      '      #1 user [← cached prefix ends here]: "hi there"',
      '      #2 assistant: "hello"',
      "    system: [2 block(s)]",
      "      block 0 [cached]: You are minimal agent.",
      "      block 1: Tools are available.",
      "    tools: [2 tool(s)]",
      "      Bash: Run a command",
      "      Read: Read a file",
    ])
  })

  // The verbose form is an explicit decision. A core that always emits `kind`
  // rows must not turn the compact dump into the gutter form on its own.
  it("keeps the compact form when verbose is switched off explicitly", () => {
    const typed: Array<[string, Record<string, string | number>]> = [
      ["--- POST m ---", {}],
      ["  Body:", {}],
      ["    tools: [1 tool(s)]", {}],
      ["      Bash: Run a command", { kind: "part", section: "tools", part: 0 }],
      ["Run a command", { kind: "line", section: "tools", part: 0, line: 1 }],
    ]
    const collector = new RequestDumpCollector()
    let block = null
    for (let i = 0; i < typed.length; i++) {
      const b = collector.push(typed[i][0], {
        row: i,
        ...typed[i][1],
        ...(i === typed.length - 1 ? { last: true } : {}),
      })
      if (b !== null) block = b
    }
    expect(block?.sections[0].parts).toHaveLength(1)
    const off = renderDumpBlock(block as never, undefined, { enabled: false }).map(strip)
    expect(off.join("\n")).not.toContain(" │ ")
    expect(off.join("\n")).not.toContain("↳")
    expect(off).toContain("    tools: [1 tool(s)]")
    // Omitted keeps the historical default: typed parts render verbosely.
    expect(
      renderDumpBlock(block as never)
        .map(strip)
        .join("\n"),
    ).toContain(" │ Run a command")
  })
})
