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

  it("degrades to dim text for a row it cannot parse", () => {
    const odd = renderDumpBlock({
      label: "--- POST x ---",
      fields: [],
      sections: [{ name: "messages", count: undefined, rows: ["???not a role???"] }],
    })
    expect(odd.join("\n")).toContain("???not a role???")
  })
})
