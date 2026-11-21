/**
 * `--debug` request dump rendering.
 *
 * A request arrives as a typed `DumpView` (from core's `llm.requestWillSend`
 * snapshot) and comes back out as ONE colored block, with the parts the user
 * asked for (messages, system blocks, tools, cache breakpoints) each styled
 * distinctly.
 *
 * @module ui/status/debug-dump.test
 */

import { describe, expect, it } from "bun:test"
import { stripSizeLabels } from "../../logging/request-dump-size.fixtures.ts"
import { CACHE, type SnapInput, tool, viewOf } from "./debug-dump.fixtures.ts"
import { renderDumpBlock } from "./debug-dump.ts"

/** A request like the old hand-made dump: 2 messages, 2 system blocks, 2 tools. */
const REQUEST: SnapInput = {
  model: "claude-opus-4-8",
  maxTokens: 32000,
  messages: [
    { role: "user", content: [{ type: "text", text: "hi there", ...CACHE }] },
    { role: "assistant", content: "hello" },
  ],
  system: [
    { type: "text", text: "You are minimal agent.", ...CACHE },
    { type: "text", text: "Tools are available." },
  ],
  tools: [tool("Bash", "Run a command"), tool("Read", "Read a file")],
}

/** Strip SGR so assertions can look for text, not escapes. */
const strip = (s: string): string => stripSizeLabels(s.replace(/\x1b\[[0-9;]*m/g, ""))

describe("renderDumpBlock", () => {
  const view = viewOf(REQUEST, false)
  const lines = renderDumpBlock(view)
  const plain = strip(lines.join("\n"))

  it("keeps every part of the request visible", () => {
    for (const expected of [
      "request  claude-opus-4-8",
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
    expect(joined).toContain("\x1b[1m\x1b[38;5;208mrequest") // tool-header label paint
    expect(joined).toContain("\x1b[2mmodel:\x1b[22m") // dim key
    expect(joined).toContain("\x1b[33mmessages\x1b[39m") // yellow section
    expect(joined).toContain("\x1b[32muser\x1b[39m") // green role
    expect(joined).toContain("\x1b[35mBash\x1b[39m") // magenta tool
    expect(joined).toContain("\x1b[1m\x1b[92m") // bright-green cache marker
  })

  it("styles the cache marker on a messages row from `cached`", () => {
    const cachedRow = lines.find((l) => l.includes("cached prefix")) ?? ""
    expect(cachedRow).toContain("\x1b[32muser\x1b[39m")
    expect(cachedRow).toContain("\x1b[1m\x1b[92m[← cached prefix ends here]\x1b[39m\x1b[22m")
    expect(strip(cachedRow)).toBe('  │       #1 user [← cached prefix ends here]: "hi there"')
  })

  it("keeps the system cache marker green, not magenta", () => {
    const blockRow = lines.find((l) => l.includes("block 0")) ?? ""
    expect(blockRow).toContain("\x1b[35mblock 0\x1b[39m")
    expect(blockRow).toContain("\x1b[1m\x1b[92m[cached]\x1b[39m\x1b[22m")
    expect(strip(blockRow)).toBe("  │       block 0 [cached]: You are minimal agent.")
  })

  it("draws no marker for a part that is not a breakpoint, whatever its text", () => {
    // The marker is data now: a prompt that CONTAINS the marker text stays text.
    const out = renderDumpBlock(
      viewOf(
        {
          messages: [{ role: "user", content: "x [← cached prefix ends here]: y" }],
          system: [{ type: "text", text: "[cached]" }],
        },
        false,
      ),
    )
    expect(out.join("\n")).not.toContain("\x1b[92m")
    expect(out.map(strip)).toContain("  │       #1 user: x [← cached prefix ends here]: y")
    expect(out.map(strip)).toContain("  │       block 0: [cached]")
  })

  it("renders one line per part plus headers", () => {
    // blank separator + header rule + 4 fields + Body + 3 section headers
    // + 6 rows (2 tools, 2 system blocks, 2 messages) + closing rule
    expect(lines).toHaveLength(1 + 1 + 4 + 1 + 3 + 6 + 1)
  })

  it("counts the parts of each section", () => {
    const out = renderDumpBlock(
      viewOf(
        {
          system: [
            { type: "text", text: "identity" },
            { type: "text", text: "# Instructions\n- Be concise." },
            { type: "text", text: "# Tools\nPrefer dedicated tools." },
            { type: "text", text: "# Safety\nCheckpoint.", ...CACHE },
          ],
        },
        false,
      ),
    ).map(strip)
    expect(out).toContain("  │     system: [4 block(s)]")
    expect(out.filter((l) => /block \d/.test(l))).toHaveLength(4)
    expect(out).toContain("  │       block 1: # Instructions ⏎ - Be concise.")
    expect(out).toContain("  │       block 3 [cached]: # Safety ⏎ Checkpoint.")
  })

  it("caps a compact preview at 80 characters, with one hint, and never prints the rest", () => {
    const long = `what is this? note: a colon ${"z".repeat(100)}`
    const out = renderDumpBlock(viewOf({ messages: [{ role: "user", content: long }] }, false))
      .map(strip)
      .join("\n")
    expect(out).toContain(`  │       #1 user: ${long.slice(0, 80)}...(+${long.length - 80}ch)`)
    expect(out).not.toContain(long)
  })

  it("fits every line to the width and folds the cut into the cap hint", () => {
    const view = viewOf(
      {
        model: "m",
        outputConfig: { effort: "o".repeat(60) },
        messages: [{ role: "user", content: [{ type: "text", text: "u".repeat(60), ...CACHE }] }],
        system: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
          { type: "text", text: "c" },
          { type: "text", text: `# Schema ${"s".repeat(31260)}`, ...CACHE },
        ],
        tools: [tool("Bash", `Executes ${"b".repeat(2400)}`), tool("Write", "short")],
      },
      false,
    )
    const width = 50
    const lines = renderDumpBlock(view, width).map(strip)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(width)
    const block3 = lines.find((l) => l.includes("block 3")) ?? ""
    const bash = lines.find((l) => l.includes("Bash:")) ?? ""
    // One hint, and its count covers what the cap cut plus what the width cut.
    expect(block3.match(/\.\.\.\(\+/g)).toHaveLength(1)
    expect(Number(/\(\+(\d+)ch\)$/.exec(block3)?.[1])).toBeGreaterThan(31189)
    expect(Number(/\(\+(\d+)ch\)$/.exec(bash)?.[1])).toBeGreaterThan(2334)
    expect(lines).toContain("  │       Write: short")
    expect(lines.some((l) => l.includes("[← cached prefix ends here]"))).toBe(true)
    // No width: nothing is clipped beyond the 80 cap.
    expect(renderDumpBlock(view).map(strip).join("\n")).toContain("s".repeat(60))
  })

  it("clips a preview that fits the cap but not the room", () => {
    const text = "y".repeat(70)
    const out = renderDumpBlock(viewOf({ tools: [tool("T", text)] }, false), 40).map(strip)
    const row = out.find((l) => l.startsWith("  │       T: ")) ?? ""
    expect(row.length).toBeLessThanOrEqual(40)
    const kept = /^ {2}│ {7}T: (y*)\.\.\.\(\+(\d+)ch\)$/.exec(row)
    expect(kept).not.toBeNull()
    expect((kept?.[1].length ?? 0) + Number(kept?.[2])).toBe(70)
  })

  it("numbers message rows in non-verbose", () => {
    const req: SnapInput = {
      model: "m",
      messages: [
        { role: "user", content: "fix this:\n    indented line" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "a1b2c3", name: "Bash", input: { command: "ls" } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "a1b2c3", content: "README.md\nsrc", ...CACHE },
          ],
        },
      ],
      system: [{ type: "text", text: "x" }],
    }
    const out = renderDumpBlock(viewOf(req, false)).map(strip)
    expect(out).toContain("  │       #1 user: fix this: ⏎ indented line")
    expect(out).toContain("  │       #2 assistant: tool_use(Bash#a1b2c3){command}")
    expect(out).toContain(
      '  │       #3 user [← cached prefix ends here]: tool_result(a1b2c3) "README.md\\nsrc"',
    )
    // System and tools rows get no number.
    expect(out).toContain("  │       block 0: x")
    // The number counts toward the width fit.
    for (const l of renderDumpBlock(viewOf(req, false), 30).map(strip)) {
      expect(l.length).toBeLessThanOrEqual(30)
    }
  })

  it("a source line that reads like a dump header stays a line", () => {
    const text = ["--- POST x ---", "  Body:", "    tools: [9 tool(s)]", "  model: evil"].join("\n")
    const out = renderDumpBlock(
      viewOf({ model: "m", system: [{ type: "text", text }] }),
      undefined,
      {
        enabled: true,
      },
    ).map(strip)
    expect(out[1]).toBe("  ╭ ◆ request  m · stream · 0 tools · 0 msgs")
    expect(out.filter((l) => /^ {2}│ {5}\w+: \[/.test(l))).toEqual([
      "  │     system: [1 block(s)]",
      "  │     messages: [0 message(s)]",
    ])
    expect(out).toContain("  │          1 │ --- POST x ---")
    expect(out).toContain("  │          2 │   Body:")
    expect(out).toContain("  │          3 │     tools: [9 tool(s)]")
    expect(out).toContain("  │          4 │   model: evil")
  })

  it("names the default model when the request has none", () => {
    expect(strip(renderDumpBlock(viewOf({}, false))[1] ?? "")).toBe(
      "  ╭ ◆ request  (default model) · stream · 0 tools · 0 msgs",
    )
  })

  // Regression: the non-verbose path is the DEFAULT mode and it printed every
  // core- and model-controlled string raw, so a prompt that contained an ESC
  // could recolor or move the cursor.
  it("strips control bytes from every non-verbose field", () => {
    const req: SnapInput = {
      model: "m\u001b[31m1",
      messages: [{ role: "us\u009ber", content: 'hi\u001b[31mthere"' }],
      system: [{ type: "text", text: "yo\u009bu", ...CACHE }],
      tools: [tool("Ba\u009bsh", "Run a comm\u001b[31mand")],
    }
    const out = renderDumpBlock(viewOf(req, false)).join("\n")
    expect(out).not.toMatch(/[\u0080-\u009f]/)
    expect(out).not.toContain("\u001b[31m1")
    // The strip must not swallow the text around the byte.
    expect(strip(out)).toContain("╭ ◆ request  m[31m1 · ")
    expect(strip(out)).toContain("model: m[31m1")
    expect(strip(out)).toContain("messages: [1 message(s)]")
    expect(strip(out)).toContain('  │       #1 user: hi[31mthere"')
    expect(strip(out)).toContain("block 0 [cached]: you")
    expect(strip(out)).toContain("Bash: Run a comm[31mand")
  })

  // The compact form is frozen: the literal below is the output of the
  // renderer before the move to the typed event (see also the goldens).
  it("renders the frozen compact form", () => {
    expect(renderDumpBlock(view).map(strip)).toEqual([
      "",
      "  ╭ ◆ request  claude-opus-4-8 · stream · 2 tools · 2 msgs",
      "  │   model: claude-opus-4-8",
      "  │   stream: true",
      "  │   max_tokens: 32000",
      "  │   request_type: conversation",
      "  │   Body:",
      "  │     tools: [2 tool(s)]",
      "  │       Bash: Run a command",
      "  │       Read: Read a file",
      "  │     system: [2 block(s)]",
      "  │       block 0 [cached]: You are minimal agent.",
      "  │       block 1: Tools are available.",
      "  │     messages: [2 message(s)]",
      '  │       #1 user [← cached prefix ends here]: "hi there"',
      "  │       #2 assistant: hello",
      "  ╰",
    ])
  })

  // The verbose form is an explicit decision of the CLI.
  it("keeps the compact form unless verbose is switched on", () => {
    const full = viewOf({ tools: [tool("Bash", "Run a command")] }, true)
    for (const opts of [{}, { enabled: false }]) {
      const off = renderDumpBlock(full, undefined, opts).map(strip)
      expect(off.join("\n")).not.toMatch(/\d │ /)
      expect(off.join("\n")).not.toContain("↳")
      expect(off).toContain("  │       Bash: Run a command")
    }
    expect(renderDumpBlock(full, undefined, { enabled: true }).map(strip).join("\n")).toContain(
      " │ Run a command",
    )
  })
})
