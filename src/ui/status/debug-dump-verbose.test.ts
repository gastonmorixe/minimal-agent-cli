/**
 * `--debug --verbose` request dump: real lines, a line-number gutter, and one
 * reference line per part and per subpart.
 *
 * @module ui/status/debug-dump-verbose.test
 */

import { describe, expect, it } from "bun:test"
import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"
import type { DumpView } from "../../logging/request-dump-model.ts"
import { stripSizeLabels } from "../../logging/request-dump-size.fixtures.ts"
import {
  CACHE,
  fakeOrigins,
  type SnapInput,
  tool,
  VERBOSE_REQUEST,
  viewOf,
} from "./debug-dump.fixtures.ts"
import { renderDumpBlock } from "./debug-dump.ts"
import type { VerboseRenderOptions } from "./debug-dump-verbose.ts"

/** Strip SGR so assertions can look for text, not escapes. */
const strip = (s: string): string => stripSizeLabels(s.replace(/\x1b\[[0-9;]*m/g, ""))

/** Render a view in verbose form. */
function verbose(view: DumpView, opts: VerboseRenderOptions = {}): string[] {
  return renderDumpBlock(view, undefined, { ...opts, enabled: true })
}

/** A request with one tool whose description is `text`. */
const oneTool = (text: string, name = "T"): SnapInput => ({ tools: [tool(name, text)] })

const block = viewOf(VERBOSE_REQUEST)
const plain = verbose(block, { origins: fakeOrigins() }).map(strip)

describe("verbose dump: real lines", () => {
  it("prints each source line on its own line with a gutter", () => {
    expect(plain).toContain("  │       #1 user")
    expect(plain).toContain("  │          1 │ fix this:")
    expect(plain).toContain("  │          2 │     indented line")
    // The one-line preview of the labelled row is not repeated.
    expect(plain.join("\n")).not.toContain("⏎")
  })

  it("restarts the numbers at 1 for each part", () => {
    const i = plain.indexOf("  │       #2 assistant")
    expect(plain.slice(i)).toContain("  │          1 │ {")
    expect(plain).toContain('  │          2 │   "command": "ls"')
    expect(plain).toContain("  │          1 │ README.md")
    expect(plain).toContain("  │          1 │ Discover, inspect and load an Agent Skill.")
    expect(plain).toContain("  │          1 │ Run a command")
  })

  it("right-aligns the gutter to the widest number of the part", () => {
    const text = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n")
    const out = verbose(viewOf({ system: [{ type: "text", text }] })).map(strip)
    expect(out).toContain("  │           1 │ l1")
    expect(out).toContain("  │          12 │ l12")
  })

  it("prints an empty line as a bare gutter", () => {
    expect(plain).toContain("  │          4 │")
  })

  it("keeps the cache marker on the part header", () => {
    expect(plain).toContain("  │       #3 user [← cached prefix ends here]")
    expect(plain).toContain("  │       block 0 [cached]")
    expect(plain).toContain("  │       Skill")
  })

  it("strips C0 controls and a trailing CR, and expands a tab to fixed spaces", () => {
    const out = verbose(viewOf(oneTool("a\x1b[31mb\tc\r")))
    // A kept tab counts 0 cells but paints up to 8, so it drifts the gutter.
    expect(out.map(strip)).toContain("  │          1 │ a[31mb    c")
    expect(out.map(strip).join("\n")).not.toContain("\t")
  })

  it("strips C1 controls, so a UTF-8 CSI cannot start a sequence", () => {
    // U+009B is the single-character CSI of ECMA-48: stripping only ESC
    // leaves a working escape-sequence opener.
    const raw = verbose(viewOf(oneTool("\u009b31mC1"))).join("\n")
    expect(raw).not.toContain("\u009b")
    expect(raw).toContain("31mC1")
    // Same for every other C1 byte.
    expect(raw).not.toMatch(/[\u0080-\u009f]/)
  })

  it("cuts a too-long line to the room it has, not to the whole line", () => {
    const b = viewOf(oneTool("x".repeat(40)))
    /** Only the gutter and ref lines: the section header is clipped by `width`. */
    const fitted = (raw: string[]): string[] =>
      raw.map(strip).filter((l) => /│.*[\d⋯ ] │ /.test(l) || l.includes("↳"))
    // 17 cells (4 of frame gutter) leave 1 cell before the bar and none after it: the line clips.
    const narrow = fitted(verbose(b, { wrapWidth: 17 }))
    for (const l of narrow) expect(displayWidth(l)).toBeLessThanOrEqual(17)
    expect(narrow.join("\n")).not.toContain("xxxx")
    expect(narrow).toContain("  │          1 │ ")
    // 24 cells (4 of frame gutter) leave 7 for text, which is what gets painted.
    const wide = fitted(verbose(b, { wrapWidth: 24 }))
    expect(wide).toContain(`  │          1 │ ${"x".repeat(7)}`)
    expect(wide).toContain(`  │            │ ${"x".repeat(7)}`)
    for (const l of wide) expect(displayWidth(l)).toBeLessThanOrEqual(24)
  })

  it("strips control bytes out of a plugin tool name before styling it", () => {
    const raw = verbose(viewOf(oneTool("x", "Ev\u001b[31mil\u009b0m"))).join("\n")
    expect(raw).not.toContain("\u001b[31mil")
    expect(raw).not.toContain("\u009b")
    expect(raw).toContain("\x1b[35mEv[31mil0m\x1b[39m")
  })

  it("strips control bytes out of a message role; draws the system cache label from data", () => {
    const raw = verbose(
      viewOf({
        messages: [{ role: "us\u001b[31mer\u009b", content: '"hi"' }],
        system: [{ type: "text", text: "x", ...CACHE }],
      }),
    ).join("\n")
    expect(raw).not.toMatch(/[\u0080-\u009f]/)
    expect(raw).not.toContain("\u001b[31mer")
    expect(raw).toContain("\x1b[32mus[31mer\x1b[39m")
    // The system name is CLI-built (`block <i>`); the label comes from `cached`.
    expect(raw).toContain("\x1b[35mblock 0\x1b[39m \x1b[1m\x1b[92m[cached]\x1b[39m\x1b[22m")
  })

  it("strips control bytes out of every reference-line source", () => {
    const request: SnapInput = {
      messages: [
        {
          role: "user",
          content: [{ type: "tool_use", id: "a\u001b[31m1", name: "Ba\u009bsh", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "a\u001b[31m1", content: "y", is_error: false },
          ],
        },
      ],
      system: [{ type: "text", text: '<ma::sys::tool name="\u009bX">' }],
      tools: [tool("T\u009b", "x")],
    }
    const origins = {
      ...fakeOrigins(),
      toolOwners: () => new Map([["T", { pluginId: "p\u001b[31mid", packageDir: "/x" }]]),
      getPromptProvenance: () => ({
        afterInstructions: [],
        sessionContext: [],
      }),
    }
    const raw = verbose(viewOf(request), { origins }).map(strip).join("\n")
    expect(raw).not.toMatch(/[\u0080-\u009f]/)
    expect(raw).not.toContain("\u001b[31m1")
    expect(raw).toContain("↳ tool_use · Bash · #a[31m1")
    expect(raw).toContain("↳ tool_result · from tool_use Bash #a[31m1")
    expect(raw).toContain('↳ <ma::sys::tool name="X"> · origin not recorded')
    expect(raw).toContain("↳ p[31mid")
  })

  it("fits a reference line to the wrap width", () => {
    const narrow = verbose(
      viewOf({ system: [{ type: "text", text: '<ma::sys::tool name="Skill">' }] }),
      {
        origins: fakeOrigins(),
        wrapWidth: 34,
      },
    ).map(strip)
    for (const l of narrow.filter((x) => x.includes("↳") || /│.*[\d⋯ ] │ /.test(x)))
      expect(displayWidth(l)).toBeLessThanOrEqual(34)
    // A ref names one origin, so it truncates instead of wrapping.
    expect(narrow).toContain("  │          ↳ ma-skills-plugin ·…")
    expect(narrow).not.toContain('  │          ↳ ma-skills-plugin · <ma::sys::tool name="Skill">')
  })
})

describe("verbose dump: wrap", () => {
  it("wraps a long line with a hanging indent under the text column", () => {
    const b = viewOf(oneTool("x".repeat(40)))
    const out = verbose(b, { wrapWidth: 30 }).map(strip)
    const i = out.findIndex((l) => l.startsWith("  │          1 │ "))
    expect(out[i]).toBe(`  │          1 │ ${"x".repeat(13)}`)
    expect(out[i + 1]).toBe(`  │            │ ${"x".repeat(13)}`)
    expect(out[i + 2]).toBe(`  │            │ ${"x".repeat(13)}`)
    for (const l of out.filter((x) => /│.*[\d⋯ ] │ /.test(x)))
      expect(l.length).toBeLessThanOrEqual(30)
    // No wrap width: the line stays whole.
    expect(verbose(b).map(strip)).toContain(`  │          1 │ ${"x".repeat(40)}`)
  })
})

describe("verbose dump: elided lines", () => {
  /**
   * A view with one `Bash` tool: `shown` lines and one hint for `hidden` more.
   * Built by hand: the model caps at 200 lines, so a small cap needs a
   * hand-made view (the view is plain typed data).
   */
  const capped = (shown: number, hidden: number): DumpView => ({
    model: "m",
    fields: [],
    kv: [],
    sections: [
      {
        name: "tools",
        parts: [
          {
            index: 0,
            section: "tools",
            name: "Bash",
            cached: false,
            full: "Run a command",
            blocks: [],
            lines: Array.from({ length: shown }, (_, i) => ({ line: i + 1, text: `l${i + 1}` })),
            elided: [{ hiddenLines: hidden }],
          },
        ],
      },
    ],
  })

  it("prints one hint line after the shown lines, with the hidden count", () => {
    // The real cap: 5000 lines give 200 shown and 4800 hidden.
    const text = Array.from({ length: 5000 }, (_, i) => `l${i + 1}`).join("\n")
    const out = verbose(viewOf(oneTool(text, "Bash"))).map(strip)
    // The gutter stays faithful for every shown line.
    expect(out).toContain("  │            1 │ l1")
    expect(out).toContain("  │          200 │ l200")
    expect(out.filter((l) => l.includes(" │ l"))).toHaveLength(200)
    // Exactly one hint, and it names the count the model gives as data.
    const hints = out.filter((l) => l.includes("4800"))
    expect(hints).toHaveLength(1)
    expect(hints[0]).toBe("  │            ⋯ │ 4800 more lines")
    // The hint comes AFTER the last shown line, never inside the gutter run.
    expect(out[out.indexOf("  │          200 │ l200") + 1]).toBe(
      "  │            ⋯ │ 4800 more lines",
    )
  })

  it("says `line` for one hidden line and `lines` above one", () => {
    const one = verbose(capped(1, 1)).map(strip)
    expect(one).toContain("  │          1 │ l1")
    expect(one).toContain("  │          ⋯ │ 1 more line")
    const many = verbose(capped(1, 2)).map(strip)
    expect(many).toContain("  │          ⋯ │ 2 more lines")
  })

  it("wraps the hint under the text column of the gutter", () => {
    const out = verbose(capped(2, 4800), { wrapWidth: 24 }).map(strip)
    // The section header is not part of the gutter form, so only the gutter
    // lines are measured.
    for (const l of out.filter((x) => /│.*[\d⋯ ] │ /.test(x)))
      expect(displayWidth(l)).toBeLessThanOrEqual(24)
    // room = 24 - 4 frame - (9 indent + 1 digit + 3 bar) = 7 cells of hint per
    // line. The hint word-wraps: each break is at a space.
    expect(out).toContain("  │          ⋯ │ 4800")
    expect(out).toContain("  │            │ more")
    expect(out).toContain("  │            │ lines")
    // The line numbering of the shown lines did not move.
    expect(out).toContain("  │          1 │ l1")
    expect(out).toContain("  │          2 │ l2")
  })

  it("has no hint and no `elided` key when no block hit the cap", () => {
    const b = viewOf(oneTool("a\nb", "Bash"))
    // `elided` stays absent, not an empty array.
    expect(b.sections[0].parts[0]).not.toHaveProperty("elided")
    expect(verbose(b).map(strip)).toEqual([
      "",
      "  ╭ ◆ request  (default model) · stream · 1 tools · 0 msgs",
      "  │   stream: true",
      "  │   request_type: conversation",
      "  │   Body:",
      "  │     tools: [1 tool(s)]",
      "  │       Bash",
      "  │          ↳ core · built-in",
      "  │          1 │ a",
      "  │          2 │ b",
      // `messages` is always there (the view's rule).
      "  │     messages: [0 message(s)]",
      "  ╰",
    ])
  })

  it("shows no hint in the compact form", () => {
    const compact = renderDumpBlock(capped(2, 4800), undefined, { enabled: false }).map(strip)
    expect(compact.join("\n")).not.toContain("4800")
    expect(compact.join("\n")).not.toContain("⋯")
    expect(compact.join("\n")).not.toMatch(/\d │ /)
    expect(compact).toContain("  │       Bash: Run a command")
  })
})

describe("verbose dump: reference lines", () => {
  it("names the block type of each message", () => {
    expect(plain).toContain("  │          ↳ text")
    expect(plain).toContain("  │          ↳ tool_use · Bash · #a1")
  })

  it("names the tool of a tool_result through its tool_use id", () => {
    expect(plain).toContain("  │          ↳ tool_result · from tool_use Bash #a1")
  })

  it("names the core slot and each plugin section of a system block", () => {
    const i = plain.indexOf("  │          ↳ core · sessionContext")
    expect(i).toBeGreaterThan(0)
    const skill = plain.indexOf(
      '  │          ↳ ma-skills-plugin · <ma::sys::tool name="Skill"> · plugins/ma-skills-plugin',
    )
    expect(skill).toBe(i + 1)
    expect(plain[skill + 1]).toBe('  │          1 │ <ma::sys::tool name="Skill">')
    const env = plain.indexOf(
      '  │          ↳ ma-env-info-plugin · <ma::sys::context name="environment"> · plugins/ma-env-info-plugin',
    )
    expect(plain[env + 1]).toBe('  │          5 │ <ma::sys::context name="environment">')
  })

  it("names the owner of each tool", () => {
    expect(plain).toContain("  │          ↳ ma-skills-plugin · plugins/ma-skills-plugin")
    expect(plain).toContain("  │          ↳ core · built-in")
    const i = plain.indexOf("  │       Mystery")
    expect(plain[i + 1]).toBe("  │          ↳ origin not recorded")
  })

  it("names a <ma::agent::NAME> attachment", () => {
    const out = verbose(
      viewOf({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "<ma::agent::tasks>\n</ma::agent::tasks>" }],
          },
        ],
      }),
    ).map(strip)
    expect(out).toContain("  │          ↳ attachment · <ma::agent::tasks>")
  })

  it("prints 'origin not recorded' when the loader has no data", () => {
    const bare = verbose(block).map(strip)
    const sys = bare.indexOf("  │       block 0 [cached]")
    expect(bare[sys + 1]).toBe("  │          ↳ origin not recorded")
    expect(bare).toContain('  │          ↳ <ma::sys::tool name="Skill"> · origin not recorded')
    const skill = bare.indexOf("  │       Skill")
    expect(bare[skill + 1]).toBe("  │          ↳ origin not recorded")
    // Message refs come from the dump itself, so they stay.
    expect(bare).toContain("  │          ↳ tool_result · from tool_use Bash #a1")
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
    expect(() => verbose(block, { origins: broken })).not.toThrow()
  })
})
