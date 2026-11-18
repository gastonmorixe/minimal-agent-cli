/**
 * M3-4 (T8, live parity): `formatToolPreview` cuts the body at
 * `opts.bodyEnd` (from `ToolViewOutcome.outcome.bodyEnd`) when it is valid.
 * The regex `findAnnotationStart` stays as the fallback. For the same
 * content, both paths give the same terminal rows.
 */

import { describe, expect, it } from "bun:test"
import type { ToolViewOutcome } from "@minimal-agent/core/host-kit/tool-executor-adapter"
import type {
  CodeHighlighter,
  CodeHighlightRequest,
} from "../formatter/mdstream-code-highlighter.ts"
import { formatToolPreview } from "./format.ts"
import { createReplToolView } from "./tool-view.ts"

const BODY = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n")

const ANNOTATIONS: Record<string, string> = {
  "output-truncated": "\n\n[truncated: 14 of 900 lines shown]",
  "output-streak": "\n\n[note: the same error came 3 times]",
  "output-preview":
    '\n\n<ma::agent::output-preview shown="10" total="14" tool="Bash">the user saw only a part of this output.</ma::agent::output-preview>',
  diagnostics: '\n\n<ma::agent::diagnostics count="1">src/a.ts:1 error</ma::agent::diagnostics>',
  "mode-active": '\n\n<ma::agent::mode-active id="plan" since="1" />',
}

const bashOpts = (bodyEnd?: number) => ({
  tool: "Bash",
  ...(bodyEnd === undefined ? {} : { bodyEnd }),
})

describe("formatToolPreview: bodyEnd parity with the regex cut", () => {
  it("0 annotations: bodyEnd = content.length gives the same rows", () => {
    expect(formatToolPreview(BODY, false, undefined, bashOpts(BODY.length))).toEqual(
      formatToolPreview(BODY, false, undefined, bashOpts()),
    )
  })

  for (const [kind, text] of Object.entries(ANNOTATIONS)) {
    it(`${kind}: bodyEnd gives the same rows as the regex`, () => {
      const content = BODY + text
      const withEnd = formatToolPreview(content, false, undefined, bashOpts(BODY.length))
      expect(withEnd).toEqual(formatToolPreview(content, false, undefined, bashOpts()))
      expect(withEnd.join("\n")).not.toContain("ma::agent")
      expect(withEnd.join("\n")).not.toContain("[truncated:")
    })
  }

  it("all annotations stacked in the fixed order: same rows", () => {
    const content = BODY + Object.values(ANNOTATIONS).join("")
    expect(formatToolPreview(content, false, undefined, bashOpts(BODY.length))).toEqual(
      formatToolPreview(content, false, undefined, bashOpts()),
    )
  })

  it("INTENDED FIX (R3, CLI display only): a body with a log line `\\n\\n[note:` is not cut by bodyEnd", () => {
    const body = "start\n\n[note: this is a log line]\nend"
    const content = body + ANNOTATIONS["output-truncated"]
    const regexRows = formatToolPreview(content, false, undefined, bashOpts()).join("\n")
    const endRows = formatToolPreview(content, false, undefined, bashOpts(body.length)).join("\n")
    // Known quirk: the regex finds the earliest prefix and cuts inside the body.
    expect(regexRows).not.toContain("end")
    // The bodyEnd path keeps the whole body.
    expect(endRows).toContain("[note: this is a log line]")
    expect(endRows).toContain("end")
    expect(endRows).not.toContain("[truncated:")
  })

  it("a bad bodyEnd gives the old result and never throws", () => {
    const content = BODY + ANNOTATIONS["output-truncated"]
    const old = formatToolPreview(content, false, undefined, bashOpts())
    const bad = [Number.NaN, -1, content.length + 5, 1.5, "3", Infinity, null] as unknown[]
    for (const value of bad) {
      const opts = { tool: "Bash", bodyEnd: value as number }
      expect(() => formatToolPreview(content, false, undefined, opts)).not.toThrow()
      expect(formatToolPreview(content, false, undefined, opts)).toEqual(old)
    }
  })
})

describe("REPL tool view: outcome.bodyEnd", () => {
  const run = async (content: string, withOutcome: boolean): Promise<string[]> => {
    const rows: string[] = []
    const view = createReplToolView({
      writeTranscript: (line) => rows.push(line),
      presentation: new Map(),
    })
    const bodyEnd = content.indexOf("\n\n[truncated:")
    const outcome: ToolViewOutcome = {
      content,
      isError: false,
      aborted: false,
      findings: [],
      ...(withOutcome ? { outcome: { bodyEnd, annotations: [] } } : {}),
    }
    const tool = { type: "tool_use" as const, id: "t1", name: "Bash", input: { command: "x" } }
    await view.onToolEvent({ type: "outcome", tool, outcome })
    return rows
  }

  it("shows the same rows with and without `outcome.outcome`", async () => {
    const content = BODY + ANNOTATIONS["output-truncated"]
    expect(await run(content, true)).toEqual(await run(content, false))
  })
})

describe("REPL tool view: Read highlight with `outcome.bodyEnd`", () => {
  // A Read body is `cat -n` text: `<number>\t<code>`.
  const CODE = [
    "const a = 1",
    "function f(x: number) {",
    "  return x + a",
    "}",
    "export { f }",
    "// end",
  ]
  const READ_BODY = CODE.map((line, i) => `${i + 1}\t${line}`).join("\n")
  const FOOTER = "\n\n[truncated: 6 of 900 lines shown]"

  // Deterministic fake: wraps each code line in one ANSI colour code and
  // records the code text that it received.
  const makeHighlighter = (calls: string[]): CodeHighlighter => ({
    warmup: async () => true,
    async highlight({ code }: CodeHighlightRequest) {
      calls.push(code)
      return code
        .split("\n")
        .map((line) => `\x1b[38;2;10;20;30m${line}\x1b[0m`)
        .join("\n")
    },
    close: async () => {},
  })

  const run = async (content: string, outcomeCut: ToolViewOutcome["outcome"]) => {
    const rows: string[] = []
    const calls: string[] = []
    const view = createReplToolView({
      writeTranscript: (line) => rows.push(line),
      presentation: new Map(),
      codeHighlighter: makeHighlighter(calls),
    })
    const outcome: ToolViewOutcome = {
      content,
      isError: false,
      aborted: false,
      findings: [],
      ...(outcomeCut ? { outcome: outcomeCut } : {}),
    }
    const tool = {
      type: "tool_use" as const,
      id: "r1",
      name: "Read",
      input: { file_path: "a.ts" },
    }
    await view.onToolEvent({ type: "outcome", tool, outcome })
    return { rows, calls }
  }

  it("shows the same rows with and without `outcome.outcome`, and highlights the body only", async () => {
    const content = READ_BODY + FOOTER
    const bodyEnd = content.indexOf(FOOTER)
    expect(bodyEnd).toBe(READ_BODY.length)

    const withOutcome = await run(content, {
      bodyEnd,
      annotations: [{ kind: "output-truncated", start: bodyEnd, end: content.length }],
    })
    const without = await run(content, undefined)

    expect(withOutcome.rows).toEqual(without.rows)
    // The highlighter gets the code of the body only, never the footer.
    const expectedCode = CODE.join("\n")
    expect(withOutcome.calls).toEqual([expectedCode])
    expect(without.calls).toEqual([expectedCode])
    // The highlight ran (ANSI is in the rows) and the footer is not shown.
    const text = withOutcome.rows.join("\n")
    expect(text).toContain("\x1b[38;2;10;20;30m")
    expect(text).not.toContain("[truncated:")
  })
})
