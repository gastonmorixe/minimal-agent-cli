/** The `headers` and `body` sections of the `--debug` request dump. */

import { describe, expect, it } from "bun:test"
import type { RequestSnapshot } from "@minimal-agent/core/host/request-inspector"

import { renderDumpBlock } from "../ui/status/debug-dump.ts"
import { isRedacted, kvSections } from "./request-dump-kv.ts"
import { dumpView } from "./request-dump-model.ts"
import { requestDumpTextRows } from "./request-dump-text.ts"

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

function snap(): RequestSnapshot {
  return {
    model: "m",
    stream: true,
    requestType: "conversation",
    tools: [],
    system: [],
    messages: [],
    cache: { system: [], messages: [] },
    headers: {
      "x-api-key": "…abcd",
      authorization: "Bearer <redacted:10 chars>",
      "content-type": "application/json",
      "anthropic-beta": "b".repeat(100),
    },
    body: {
      temperature: 0.5,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      metadata: { user_id: "<redacted:40 chars>" },
    },
  }
}

describe("kvSections", () => {
  it("sorts keys, and marks masked values", () => {
    const [h, b] = kvSections(snap())
    expect(h.rows.map((r) => r.key)).toEqual([
      "anthropic-beta",
      "authorization",
      "content-type",
      "x-api-key",
    ])
    expect(h.rows.map((r) => r.redacted)).toEqual([false, true, false, true])
    expect(b.rows.map((r) => r.key)).toEqual(["metadata", "temperature", "tool_choice"])
    expect(b.rows[2].pretty?.length).toBeGreaterThan(1)
  })

  it("isRedacted knows only core masks", () => {
    expect(isRedacted("<redacted:3 chars>")).toBe(true)
    expect(isRedacted("Bearer …wxyz")).toBe(true)
    expect(isRedacted("application/json")).toBe(false)
  })

  it("leaves out empty sections", () => {
    expect(kvSections({ ...snap(), headers: undefined, body: {} })).toEqual([])
  })
})

describe("plain-text rows", () => {
  it("compact: aligned one-line rows before tools, with the cut hint", () => {
    const rows = requestDumpTextRows(dumpView(snap(), { lines: false }), false).map((r) => r.text)
    expect(rows).toContain("    headers: [4 header(s)]")
    expect(rows).toContain("      authorization   Bearer <redacted:10 chars>")
    expect(rows).toContain('      tool_choice  {"type":"auto","disable_parallel_tool_use":true}')
    expect(rows.find((r) => r.startsWith("      anthropic-beta"))).toContain("...(+20ch)")
    expect(rows.indexOf("    body: [3 field(s)]")).toBeLessThan(
      rows.indexOf("    messages: [0 message(s)]"),
    )
  })

  it("verbose: full values and pretty JSON behind the gutter", () => {
    const rows = requestDumpTextRows(dumpView(snap(), { lines: true }), true)
    const texts = rows.map((r) => r.text)
    expect(texts.find((r) => r.startsWith("      anthropic-beta"))).toContain("b".repeat(100))
    expect(texts).toContain("      tool_choice")
    expect(texts).toContain('        ┆   "type": "auto",')
    expect(rows.find((r) => r.text === "      tool_choice")?.data).toEqual({
      kind: "field",
      section: "body",
      key: "tool_choice",
    })
  })
})

describe("REPL block", () => {
  it("paints keys cyan and masked values dim italic", () => {
    const lines = renderDumpBlock(dumpView(snap(), { lines: false }), 80)
    const auth = lines.find((l) => strip(l).includes("authorization")) ?? ""
    expect(auth).toContain("\x1b[3m")
    expect(auth).toContain("\x1b[2m")
    const ct = lines.find((l) => strip(l).includes("content-type")) ?? ""
    expect(ct).not.toContain("\x1b[3m")
    for (const l of lines) expect(strip(l).length).toBeLessThanOrEqual(80)
  })

  it("verbose: pretty JSON lines with the gutter", () => {
    const lines = renderDumpBlock(dumpView(snap(), { lines: true }), undefined, { enabled: true })
    expect(lines.map(strip)).toContain('        ┆   "disable_parallel_tool_use": true')
  })
})
