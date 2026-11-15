/**
 * Inline-script rendering in the Bash transcript header.
 *
 * Regression coverage for the reported bug: a one-line `python -c '…; …; …'`
 * rendered as a single header row cut at the terminal width, losing every
 * statement and everything after the cut. The same script written with real
 * newlines rendered fine, because the `\n` path owned it. The renderer now
 * decomposes the quoted payload itself, so shape depends on what the command
 * contains rather than on how the model happened to format it.
 */

import { describe, expect, it } from "bun:test"

import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"
import type { ToolUseBlock } from "@minimal-agent/core/sdk/messages"

import {
  BASH_CONT_MAX_LINES_SCRIPT,
  formatToolHeaderRows,
  formatToolInput,
  formatToolInputContinuation,
} from "./format.ts"

function tu(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: "tool_use", id: "test", name, input } as ToolUseBlock
}

/** The exact command from the bug report, trimmed to fit a test file. */
const REPORTED =
  `uv run --no-project python -c 'from pathlib import Path; ` +
  `p = Path("/Users/gaston/.agents/AGENTS.md"); s = p.read_text(); ` +
  `checks = {"accepted tags absent": "[accepted]" not in s}; ` +
  `[print(name) for name in checks]'`

describe("formatToolInput — inline script payload", () => {
  it("keeps only the prologue on the header row", () => {
    const out = formatToolInput(tu("Bash", { command: REPORTED }), 100)
    expect(out).toBe(`$ uv run --no-project python -c '`)
  })

  it("emits one row per depth-0 statement", () => {
    const rows = formatToolInputContinuation(tu("Bash", { command: REPORTED }), 100)
    expect(rows).toHaveLength(5)
    expect(rows[0]).toBe("> from pathlib import Path")
    expect(rows[1]).toBe(`> p = Path("/Users/gaston/.agents/AGENTS.md")`)
    expect(rows[2]).toBe(`> s = p.read_text()`)
    expect(rows[3]?.startsWith(`> checks = {`)).toBe(true)
    expect(rows[4]?.startsWith(`> [print(name)`)).toBe(true)
  })

  it("attaches the closing quote to the last row", () => {
    const rows = formatToolInputContinuation(tu("Bash", { command: REPORTED }), 200)
    expect(rows[rows.length - 1]?.endsWith("'")).toBe(true)
  })

  it("does NOT truncate the statements away at a narrow width", () => {
    // The reported symptom: everything past `Path("/Users…` was gone.
    const rows = formatToolInputContinuation(tu("Bash", { command: REPORTED }), 60)
    const joined = rows.join("\n")
    expect(joined).toContain("p.read_text()")
    expect(joined).not.toContain("...(+4")
  })

  it("keeps every rendered row inside the terminal width", () => {
    for (const cols of [60, 80, 100, 140, 200]) {
      for (const row of formatToolHeaderRows({ tool: tu("Bash", { command: REPORTED }), cols })) {
        expect(displayWidth(row)).toBeLessThanOrEqual(cols)
      }
    }
  })

  it("renders one row per statement, with or without a trailing newline shape", () => {
    // The invariant that was broken: identical content, different formatting,
    // wildly different transcripts. A `;`-joined payload now unwraps exactly
    // like the newline-separated one does on its tail rows.
    const semi = `python -c 'a = 1; b = 2; c = 3'`
    const nl = `python -c 'a = 1\nb = 2\nc = 3'`
    // Real newlines keep the long-standing contract: the first line headlines
    // the header, the rest become PS2 rows.
    expect(formatToolInput(tu("Bash", { command: nl }), 100)).toBe("$ python -c 'a = 1")
    // Semicolons keep the prologue-only header and pull the whole payload down
    // into rows, which is the shape that was previously unavailable.
    expect(formatToolInput(tu("Bash", { command: semi }), 100)).toBe("$ python -c '")
    expect(formatToolInputContinuation(tu("Bash", { command: semi }), 100)).toEqual([
      "> a = 1",
      "> b = 2",
      "> c = 3'",
    ])
    // Both cover all three statements, so nothing is silently lost.
    expect(formatToolInputContinuation(tu("Bash", { command: nl }), 100)).toEqual([
      "> b = 2",
      "> c = 3'",
    ])
  })

  it("unwraps a 3+ statement script that fits the terminal (structure beats width)", () => {
    const cmd = `node -e 'a(); b(); c()'`
    expect(formatToolInput(tu("Bash", { command: cmd }), 200)).toBe(`$ node -e '`)
    expect(formatToolInputContinuation(tu("Bash", { command: cmd }), 200)).toEqual([
      "> a()",
      "> b()",
      "> c()'",
    ])
  })

  it("leaves a 2-statement script inline when it fits", () => {
    const cmd = `node -e 'a(); b()'`
    expect(formatToolInput(tu("Bash", { command: cmd }), 200)).toBe(`$ ${cmd}`)
    expect(formatToolInputContinuation(tu("Bash", { command: cmd }), 200)).toEqual([])
  })

  it("caps script rows at BASH_CONT_MAX_LINES_SCRIPT, then reports the remainder", () => {
    const stmts = Array.from({ length: 40 }, (_, i) => `x${i} = ${i}`)
    const cmd = `python -c '${stmts.join("; ")}'`
    const rows = formatToolInputContinuation(tu("Bash", { command: cmd }), 100)
    expect(rows).toHaveLength(BASH_CONT_MAX_LINES_SCRIPT + 1)
    expect(rows[rows.length - 1]).toMatch(/^> \.\.\.\(\+\d+L\) more$/)
  })

  it("keeps a shell tail after the payload on the last row", () => {
    const cmd = `python -c 'a = 1; b = 2; c = 3' | head -5`
    const rows = formatToolInputContinuation(tu("Bash", { command: cmd }), 200)
    expect(rows[rows.length - 1]).toBe("> c = 3' | head -5")
  })

  it("stays a single header row when the width is unknown (non-TTY)", () => {
    // Piped output and most unit tests have no `cols`; they must keep the
    // historical single-line header shape.
    expect(formatToolInput(tu("Bash", { command: `node -e 'a(); b()'` }))).toBe(
      `$ node -e 'a(); b()'`,
    )
    expect(formatToolInputContinuation(tu("Bash", { command: `node -e 'a(); b()'` }))).toEqual([])
  })
})

describe("formatToolInput — commander-style pipeline that also has a script", () => {
  it("still prefers operator rows for a plain shell pipeline", () => {
    // Guard against the script lane swallowing ordinary pipelines.
    const cmd = "cd /Users/dev/Projects && grep -n foo bar.md | head -10"
    expect(formatToolInput(tu("Bash", { command: cmd }), 80)).toBe("$ cd /Users/dev/Projects")
    expect(formatToolInputContinuation(tu("Bash", { command: cmd }), 80)).toEqual([
      "↳ && grep -n foo bar.md",
      "↳ | head -10",
    ])
  })
})

describe("formatToolInput — mid-elision for undecomposable commands", () => {
  it("keeps the tail of a long command visible", () => {
    // A long flag/value run with a meaningful tail. Middle elision keeps the
    // trailing arguments, since `--outfile=…` is the part that says what the
    // command actually produces.
    const cmd = `npx esbuild src/index.ts --bundle --minify ${"src/very/deep/module.ts ".repeat(6)}--outfile=dist/bundle.js`
    const out = formatToolInput(tu("Bash", { command: cmd }), 100)
    expect(out).toContain("--outfile=dist/bundle.js")
    expect(out).toContain("...(+")
    expect(displayWidth(out)).toBeLessThanOrEqual(100)
  })

  it("falls back to a right trim when there is no honest break point", () => {
    // A single unbreakable token: no tail to preserve, so the plain trim wins
    // rather than a mid-token sandwich.
    const cmd = `x${"y".repeat(400)}`
    const out = formatToolInput(tu("Bash", { command: cmd }), 100)
    expect(out).toMatch(/\.\.\.\(\+\d+ch\)$/)
    expect(displayWidth(out)).toBeLessThanOrEqual(100)
  })
})
