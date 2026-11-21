/**
 * Parity tests of the plain-text request dump.
 *
 * Each expectation is a port of core's old `llm/transport/debug.test.ts`
 * (`requestDumpLines` / `requestDumpRows`), with the request given as a
 * `RequestSnapshot` instead of `SendOptions`. The rows must stay
 * byte-identical to the rows core wrote before `llm.requestWillSend`.
 *
 * @module logging/request-dump-text.test
 */

import { describe, expect, it } from "bun:test"
import type { RequestSnapshot } from "@minimal-agent/core/host/request-inspector"
import { dumpView, MAX_LINE_ROWS } from "./request-dump-model.ts"
import { stripRowSizeLabels, stripSizeLabels } from "./request-dump-size.fixtures.ts"
import { type RequestDumpTextRow, requestDumpTextRows } from "./request-dump-text.ts"

/** A loose request shape for the fixtures (casts like the core tests do). */
interface SnapInput {
  readonly model?: string
  readonly stream?: boolean
  readonly maxTokens?: number
  readonly requestType?: string
  readonly thinking?: unknown
  readonly outputConfig?: unknown
  readonly speed?: "normal" | "fast"
  readonly tools?: readonly unknown[]
  readonly system?: readonly unknown[]
  readonly messages?: readonly unknown[]
}

/** True when a block-like value has a truthy `cache_control` (core `requestSnapshot` rule). */
const hasCache = (b: unknown): boolean =>
  Boolean((b as { cache_control?: unknown } | undefined)?.cache_control)

/** Build a snapshot the way core's `requestSnapshot` does. */
function snap(input: SnapInput): RequestSnapshot {
  const system = (input.system ?? []) as RequestSnapshot["system"]
  const messages = (input.messages ?? []) as RequestSnapshot["messages"]
  const cacheSystem = system.flatMap((b, i) => (hasCache(b) ? [i] : []))
  const cacheMessages = messages.flatMap((m, i) =>
    typeof m.content !== "string" && hasCache(m.content[m.content.length - 1]) ? [i] : [],
  )
  return {
    model: input.model,
    stream: input.stream ?? true,
    ...(input.maxTokens != null ? { maxTokens: input.maxTokens } : {}),
    requestType: (input.requestType ?? "conversation") as RequestSnapshot["requestType"],
    ...(input.thinking ? { thinking: input.thinking as RequestSnapshot["thinking"] } : {}),
    ...(input.outputConfig
      ? { outputConfig: input.outputConfig as RequestSnapshot["outputConfig"] }
      : {}),
    ...(input.speed ? { speed: input.speed } : {}),
    tools: (input.tools ?? []) as RequestSnapshot["tools"],
    system,
    messages,
    cache: { system: cacheSystem, messages: cacheMessages },
  }
}

const REQUEST: SnapInput = {
  model: "test-model",
  maxTokens: 100,
  messages: [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
    },
  ],
  system: [{ type: "text", text: "system text", cache_control: { type: "ephemeral" } }],
  tools: [{ name: "Read", description: "read a file" }],
}

/** The rows of a request. */
function rows(input: SnapInput, verbose: boolean): RequestDumpTextRow[] {
  return requestDumpTextRows(dumpView(snap(input), { lines: verbose }), verbose).map(
    stripRowSizeLabels,
  )
}

/** The row texts of a request. */
function lines(input: SnapInput, verbose = false): string[] {
  return rows(input, verbose).map((r) => stripSizeLabels(r.text))
}

const lineRows = (all: readonly RequestDumpTextRow[]) => all.filter((r) => r.data?.kind === "line")

const FOOTER = "  ╰"

const EXPECTED_REQUEST_LINES = [
  "  ╭ ◆ request  test-model · stream · 1 tools · 2 msgs",
  "  │   model: test-model",
  "  │   stream: true",
  "  │   max_tokens: 100",
  "  │   request_type: conversation",
  "  │   Body:",
  "  │     tools: [1 tool(s)]",
  "  │       Read: read a file",
  "  │     system: [1 block(s)]",
  "  │       block 0 [cached]: system text",
  "  │     messages: [2 message(s)]",
  "  │       user: hello",
  '  │       assistant [← cached prefix ends here]: "hi"',
  FOOTER,
]

describe("requestDumpTextRows (compact)", () => {
  it("renders the header and the body preview as plain text", () => {
    expect(lines(REQUEST)).toEqual(EXPECTED_REQUEST_LINES)
  })

  it("has no ANSI escapes", () => {
    expect(lines(REQUEST).join("\n")).not.toContain("\u001b")
  })

  it("renders the optional header fields with the same rules", () => {
    const out = lines({
      messages: [],
      stream: false,
      requestType: "title",
      thinking: { type: "adaptive", display: "summarized" },
      outputConfig: { effort: "high" },
      speed: "fast",
    })
    expect(out.slice(0, 6)).toEqual([
      "  ╭ ◆ request  (default model) · no stream · 0 tools · 0 msgs",
      "  │   stream: false",
      "  │   request_type: title",
      '  │   thinking: {"type":"adaptive","display":"summarized"}',
      '  │   output_config: {"effort":"high"}',
      "  │   speed: fast",
    ])
    expect(lines({ messages: [], speed: "normal" })).not.toContain("  │   speed: normal")
  })

  it("keeps every row on a single line even when the source text is multi-line", () => {
    const multi: SnapInput = {
      ...REQUEST,
      system: [
        { type: "text", text: "identity" },
        { type: "text", text: "# Instructions\n\n- Be concise.\n- Be direct." },
        { type: "text", text: "# Tools\n\nPrefer dedicated tools." },
        { type: "text", text: "# Safety\n\nCheckpoint every 50 rounds." },
      ],
    }
    const out = lines(multi)
    expect(out.filter((l) => l.includes("\n"))).toEqual([])
    const blocks = out.filter((l) => /^ {2}│ {7}block \d/.test(l))
    expect(blocks).toHaveLength(4)
    expect(blocks[0]).toBe("  │       block 0: identity")
    expect(blocks.slice(1).every((l) => l.includes("⏎"))).toBe(true)
  })

  it("marks the newlines it collapses so the block structure stays legible", () => {
    const multi: SnapInput = {
      ...REQUEST,
      system: [{ type: "text", text: "line one\nline two" }],
      tools: [],
      messages: [{ role: "user", content: "hi" }],
    }
    const row = lines(multi).find((l) => l.includes("block 0")) ?? ""
    expect(row).toBe("  │       block 0: line one ⏎ line two")
  })

  it("emits a full continuation row when a preview is capped, and none when verbose", () => {
    const long = "x".repeat(300)
    const req: SnapInput = {
      ...REQUEST,
      tools: [{ name: "Mode", description: long }],
      messages: [{ role: "user", content: "hi" }],
      system: [],
    }
    const capped = lines(req, false)
    const rowIndex = capped.findIndex((l) => l.startsWith("  │       Mode: "))
    expect(capped[rowIndex]).toBe(`  │       Mode: ${"x".repeat(80)}...(+220ch)`)
    expect(capped[rowIndex + 1]).toBe(`  │         ${long}`)

    const verbose = lines(req, true)
    expect(verbose.some((l) => l.includes("...(+"))).toBe(false)
    const withLong = rows(req, true).filter((r) => r.text.includes(long))
    expect(withLong).toHaveLength(2)
    expect(withLong.filter((r) => r.text.startsWith("  │       Mode: "))).toHaveLength(1)
    expect(withLong.filter((r) => r.data?.kind === "line" && r.text === long)).toHaveLength(1)
  })

  it("previews message blocks as structural tokens", () => {
    const out = lines({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "abcd", signature: "s" },
            { type: "tool_use", id: "toolu_abc123", name: "Bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_abc123", content: "ok", is_error: true },
          ],
        },
      ],
    })
    expect(out.slice(-3, -1)).toEqual([
      "  │       assistant: thinking(4ch) ⟶ tool_use(Bash#abc123){command}",
      '  │       user: tool_result!(abc123) "ok"',
    ])
  })

  it("non-verbose rows carry no data", () => {
    const all = rows(REQUEST, false)
    expect(all.every((r) => r.data === undefined)).toBe(true)
    expect(all.map((r) => stripSizeLabels(r.text))).toEqual(EXPECTED_REQUEST_LINES)
  })
})

describe("requestDumpTextRows (verbose)", () => {
  it("one line row per source line, indentation kept", () => {
    const req: SnapInput = {
      ...REQUEST,
      messages: [],
      system: [{ type: "text", text: "a\n  b\n\nc" }],
      tools: [],
    }
    const out = lineRows(rows(req, true))
    expect(out.map((r) => stripSizeLabels(r.text))).toEqual(["a", "  b", "", "c"])
    expect(out.map((r) => r.data?.line)).toEqual([1, 2, 3, 4])
    expect(out.every((r) => r.data?.section === "system" && r.data?.part === 0)).toBe(true)
  })

  it("labelled rows carry kind part, and lines follow their part", () => {
    const all = rows(REQUEST, true)
    const parts = all.filter((r) => r.data?.kind === "part")
    expect(parts.map((r) => [r.data?.section, r.data?.part])).toEqual([
      ["tools", 0],
      ["system", 0],
      ["messages", 0],
      ["messages", 1],
    ])
    const sysPart = all.findIndex((r) => r.data?.kind === "part" && r.data.section === "system")
    expect(all[sysPart + 1]).toEqual({
      text: "system text",
      data: { kind: "line", section: "system", part: 0, line: 1 },
    })
  })

  it("the full verbose dump of the base request", () => {
    expect(rows(REQUEST, true)).toEqual([
      { text: "  ╭ ◆ request  test-model · stream · 1 tools · 2 msgs" },
      { text: "  │   model: test-model" },
      { text: "  │   stream: true" },
      { text: "  │   max_tokens: 100" },
      { text: "  │   request_type: conversation" },
      { text: "  │   Body:" },
      { text: "  │     tools: [1 tool(s)]" },
      { text: "  │       Read: read a file", data: { kind: "part", section: "tools", part: 0 } },
      { text: "read a file", data: { section: "tools", part: 0, kind: "line", line: 1 } },
      { text: "  │     system: [1 block(s)]" },
      {
        text: "  │       block 0 [cached]: system text",
        data: { kind: "part", section: "system", part: 0 },
      },
      { text: "system text", data: { section: "system", part: 0, kind: "line", line: 1 } },
      { text: "  │     messages: [2 message(s)]" },
      { text: "  │       user: hello", data: { kind: "part", section: "messages", part: 0 } },
      {
        text: "  │         block 0 text",
        data: { kind: "block", section: "messages", part: 0, block: 0, blockType: "text" },
      },
      {
        text: "hello",
        data: { section: "messages", part: 0, block: 0, kind: "line", line: 1 },
      },
      {
        text: '  │       assistant [← cached prefix ends here]: "hi"',
        data: { kind: "part", section: "messages", part: 1 },
      },
      {
        text: "  │         block 0 text",
        data: { kind: "block", section: "messages", part: 1, block: 0, blockType: "text" },
      },
      { text: "hi", data: { section: "messages", part: 1, block: 0, kind: "line", line: 1 } },
      { text: FOOTER },
    ])
  })

  it("no row contains a newline", () => {
    const req: SnapInput = {
      ...REQUEST,
      messages: [
        { role: "user", content: "one\ntwo\n  three" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "t1\nt2", signature: "s" },
            { type: "text", text: "x\ny" },
            { type: "tool_use", id: "toolu_abc123", name: "Bash", input: { command: "ls\n-la" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_abc123",
              content: [{ type: "text", text: "r1\nr2" }],
            },
          ],
        },
      ],
      system: [{ type: "text", text: "# H\n\n- a\n- b" }],
      tools: [{ name: "Read", description: "line 1\nline 2" }],
    }
    const all = rows(req, true)
    expect(all.filter((r) => r.text.includes("\n"))).toEqual([])
    const texts = lineRows(all).map((r) => stripSizeLabels(r.text))
    expect(texts).toContain('  "command": "ls\\n-la"')
    expect(texts).toContain("  three")
    expect(texts).toContain("r2")
    expect(texts).toContain("line 2")
    const msg1 = lineRows(all).filter((r) => r.data?.section === "messages" && r.data.part === 1)
    expect(msg1.map((r) => r.data?.line)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(msg1.map((r) => r.data?.block)).toEqual([0, 0, 1, 1, 2, 2, 2])
  })

  it("block rows carry tool ids", () => {
    const req: SnapInput = {
      ...REQUEST,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_a1b2c3", name: "Bash", input: { c: 1 } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a1b2c3", content: "ok", is_error: true },
          ],
        },
      ],
      system: [],
      tools: [],
    }
    const blocks = rows(req, true).filter((r) => r.data?.kind === "block")
    expect(blocks).toEqual([
      {
        text: "  │         block 0 tool_use",
        data: {
          kind: "block",
          section: "messages",
          part: 0,
          block: 0,
          blockType: "tool_use",
          toolUseId: "toolu_a1b2c3",
          toolName: "Bash",
        },
      },
      {
        text: "  │         block 0 tool_result",
        data: {
          kind: "block",
          section: "messages",
          part: 1,
          block: 0,
          blockType: "tool_result",
          toolUseId: "toolu_a1b2c3",
          isError: true,
        },
      },
    ])
  })

  it("a cyclic tool input produces a row instead of throwing", () => {
    const cyclic: Record<string, unknown> = { command: "ls" }
    cyclic.self = cyclic
    const req: SnapInput = {
      ...REQUEST,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_cyc001", name: "Bash", input: cyclic }],
        },
      ],
      system: [],
      tools: [],
    }
    let all: RequestDumpTextRow[] = []
    expect(() => {
      all = rows(req, true)
    }).not.toThrow()
    expect(all.length).toBeGreaterThan(0)
    expect(lineRows(all).map((r) => stripSizeLabels(r.text))).toContain('  "self": "[Circular]"')
  })

  it("a BigInt tool input produces a row instead of throwing", () => {
    const req: SnapInput = {
      ...REQUEST,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_big001",
              name: "Bash",
              input: { bytes: 9007199254740993n },
            },
          ],
        },
      ],
      system: [],
      tools: [],
    }
    let all: RequestDumpTextRow[] = []
    expect(() => {
      all = rows(req, true)
    }).not.toThrow()
    expect(lineRows(all).map((r) => stripSizeLabels(r.text))).toContain(
      '  "bytes": "9007199254740993n"',
    )
  })

  it("a huge block stops at MAX_LINE_ROWS and reports the hidden count", () => {
    const total = 5000
    const text = Array.from({ length: total }, (_, i) => `l${i + 1}`).join("\n")
    const req: SnapInput = {
      ...REQUEST,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_big", content: text }],
        },
      ],
      system: [],
      tools: [],
    }
    const all = rows(req, true)
    expect(lineRows(all).length).toBe(MAX_LINE_ROWS)
    const elided = all.filter((r) => r.data?.kind === "elided")
    expect(elided).toEqual([
      {
        text: "",
        data: {
          section: "messages",
          part: 0,
          block: 0,
          kind: "elided",
          hiddenLines: total - MAX_LINE_ROWS,
        },
      },
    ])
    expect(all.filter((r) => r.text.includes("...(+")).map((r) => stripSizeLabels(r.text))).toEqual(
      [],
    )
  })

  it("the elided row follows the last line row of its block", () => {
    const text = Array.from({ length: MAX_LINE_ROWS + 3 }, (_, i) => `l${i}`).join("\n")
    const all = rows({ messages: [], system: [{ type: "text", text }] }, true)
    const at = all.findIndex((r) => r.data?.kind === "elided")
    expect(all[at - 1].data).toEqual({
      section: "system",
      part: 0,
      kind: "line",
      line: MAX_LINE_ROWS,
    })
    expect(all[at].data).toEqual({ section: "system", part: 0, kind: "elided", hiddenLines: 3 })
  })
})

describe("dumpView", () => {
  it("names hold no marker, and the cache breakpoint is typed", () => {
    const view = dumpView(snap(REQUEST), { lines: false })
    const parts = view.sections.flatMap((s) => s.parts)
    expect(parts.map((p) => [p.section, p.name, p.cached])).toEqual([
      ["tools", "Read", false],
      ["system", "block 0", true],
      ["messages", "user", false],
      ["messages", "assistant", true],
    ])
    expect(parts.every((p) => p.blocks.length === 0 && p.lines.length === 0)).toBe(true)
  })

  it("omits empty tools and system sections, and always keeps messages", () => {
    const view = dumpView(snap({ messages: [] }), { lines: false })
    expect(view.sections.map((s) => s.name)).toEqual(["messages"])
  })
})
