/**
 * The tool frame tint. A tool with a known presentation color gets a dim
 * version of that color on its frame glyphs (`╭ │ ┊ ╰`). A tool with no
 * presentation, no color, or an unknown color key keeps `c.dimCyan`, byte
 * for byte. Live and replay paint the same bytes.
 */

import { describe, expect, it } from "bun:test"
import type { ToolViewOutcome } from "@minimal-agent/core/host-kit/tool-executor-adapter"
import type { Message, ToolUseBlock } from "@minimal-agent/core/sdk/messages"
import { TOOL_PRESENTATION, toolPresentationMap } from "../../plugins-ui/tool-presentation.ts"
import { replayToScrollback } from "../../session-replay.ts"
import { ANSI_CODES } from "../../terminal-kit/ansi.ts"
import { PALETTE } from "../../terminal-kit/palette.ts"
import { c } from "../style/ansi.ts"
import {
  formatModeCloseRow,
  formatRefusalRows,
  formatStreamBodyRow,
  formatToolHeaderRows,
  formatToolPreview,
  frameCloseRow,
  isOuterFrameClose,
  renderFindingsPanel,
  renderStreamedTail,
  reopenFrameCloser,
} from "./format.ts"
import { frameTint } from "./frame-tint.ts"
import { createReplToolView } from "./tool-view.ts"

const DIM_CYAN_OPEN = "\x1b[2;36m"
const CLOSE = "\x1b[22;39m"
const gold = frameTint({ color: "gold" })
const violet = frameTint({ color: "violet" })

/** The SGR open of the frame glyph at the start of a row, or null. */
function frameOpen(row: string): string | null {
  return /^\n? {2}(\x1b\[[\d;]*m)[╭│┊╰]/.exec(row)?.[1] ?? null
}

const editTool: ToolUseBlock = {
  type: "tool_use",
  id: "e1",
  name: "Edit",
  input: { file_path: "/x/a.ts", old_string: "a", new_string: "b" },
}

describe("frameTint", () => {
  it("gives a dim palette color for a known key", () => {
    expect(gold("╭")).toBe(`${ANSI_CODES.DIM_GOLD}╭${CLOSE}`)
    expect(gold("╭")).toBe(`\x1b[2;38;5;214m╭${CLOSE}`)
    expect(violet("╰")).toBe(`${ANSI_CODES.DIM_VIOLET}╰${CLOSE}`)
    expect(violet("╰")).toBe(`\x1b[2;38;2;180;140;255m╰${CLOSE}`)
    expect(frameTint({ color: "cyan" })("│")).toBe(c.dimCyan("│"))
  })

  it("keeps c.dimCyan for no presentation, no color, or an unknown key", () => {
    const cases = [
      undefined,
      null,
      {},
      { icon: "x" },
      { color: "" },
      { color: "amber" }, // not a palette key
      { color: "bold" }, // a `c` key, not a color
      { color: "black" }, // a palette key with no `c` helper
      { color: "toString" },
      { color: "__proto__" },
    ]
    for (const pres of cases) {
      const tint = frameTint(pres)
      expect(tint).toBe(c.dimCyan)
      expect(tint("╭")).toBe(`${DIM_CYAN_OPEN}╭${CLOSE}`)
    }
  })

  it("gives each tool in the static map the dim form of its palette color", () => {
    for (const [name, pres] of TOOL_PRESENTATION) {
      const key = pres.color ?? ""
      // A color key that is not a `c` helper and a palette name silently
      // falls back (orange label, dim cyan frame). Every entry must be real.
      expect({ name, key, known: Object.hasOwn(c, key) && Object.hasOwn(PALETTE, key) }).toEqual({
        name,
        key,
        known: true,
      })
      const open = frameOpen(`  ${frameTint(pres)("│")}`)
      expect(open).toBe(`\x1b[2;${PALETTE[key as keyof typeof PALETTE].slice(2)}`)
    }
  })
})

describe("formatToolHeaderRows frame tint", () => {
  it("paints the Edit frame dim gold", () => {
    const rows = formatToolHeaderRows({
      tool: editTool,
      presentation: TOOL_PRESENTATION.get("Edit"),
      cols: 100,
    })
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows[0]!.startsWith(`  ${ANSI_CODES.DIM_GOLD}╭${CLOSE} `)).toBe(true)
    expect(rows.at(-1)).toBe(`  ${ANSI_CODES.DIM_GOLD}│${CLOSE}`)
    for (const row of rows) expect(row).not.toContain(DIM_CYAN_OPEN)
  })

  it("ignores an inherited Object key as a color: orange label, dim cyan frame, no throw", () => {
    const plain = formatToolHeaderRows({ tool: editTool, presentation: {}, cols: 100 })
    expect(plain[0]).toContain(c.bold(c.orange("Edit")))
    for (const color of ["valueOf", "toString", "__proto__", "hasOwnProperty"]) {
      const rows = formatToolHeaderRows({ tool: editTool, presentation: { color }, cols: 100 })
      expect({ color, rows }).toEqual({ color, rows: plain })
    }
  })

  it("keeps dimCyan for a tool with no presentation", () => {
    for (const presentation of [undefined, null, { icon: "x" }]) {
      const rows = formatToolHeaderRows({ tool: editTool, presentation, cols: 100 })
      expect(rows[0]!.startsWith(`  ${DIM_CYAN_OPEN}╭${CLOSE} `)).toBe(true)
      expect(rows.at(-1)).toBe(`  ${DIM_CYAN_OPEN}│${CLOSE}`)
    }
  })
})

describe("frame renderers take the tint", () => {
  it("formatToolPreview paints each frame glyph", () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")
    const rows = formatToolPreview(body, false, undefined, { tool: "Bash", tint: gold })
    expect(rows.some((r) => r.includes("┊"))).toBe(true)
    for (const row of rows) expect(frameOpen(row)).toBe(ANSI_CODES.DIM_GOLD)
    const display = formatToolPreview("", false, "a\nb", { tool: "Task", footer: "f", tint: gold })
    for (const row of display) expect(frameOpen(row)).toBe(ANSI_CODES.DIM_GOLD)
    const plain = formatToolPreview(body, false, undefined, { tool: "Bash" })
    for (const row of plain) expect(frameOpen(row)).toBe(DIM_CYAN_OPEN)
  })

  it("refusal, mode close, stream body and streamed tail rows", () => {
    for (const row of formatRefusalRows("no", "ASK", gold)) {
      expect(frameOpen(row)).toBe(ANSI_CODES.DIM_GOLD)
    }
    expect(frameOpen(formatModeCloseRow("ASK", gold))).toBe(ANSI_CODES.DIM_GOLD)
    expect(frameOpen(formatStreamBodyRow("x", gold))).toBe(ANSI_CODES.DIM_GOLD)
    const out: string[] = []
    renderStreamedTail({
      bufferedLastLine: "last",
      streamedLineCount: 20,
      budget: 10,
      writeTranscript: (line) => out.push(line),
      tint: gold,
    })
    expect(out.length).toBe(3)
    for (const row of out) expect(frameOpen(row)).toBe(ANSI_CODES.DIM_GOLD)
    // The defaults keep the old bytes.
    expect(formatModeCloseRow("ASK")).toBe(`  ${c.dimCyan("╰")} ${c.dim("active mode: ASK")}`)
    expect(formatStreamBodyRow("x")).toBe(`  ${c.dimCyan("│")} ${c.dim("x")}`)
  })

  it("the diagnostics panel takes the tint of its tool block", () => {
    const findings = [{ severity: "warning" as const, message: "unused", line: 1, source: "lint" }]
    for (const row of renderFindingsPanel(findings, { tint: gold })) {
      expect(frameOpen(row)).toBe(ANSI_CODES.DIM_GOLD)
    }
    for (const row of renderFindingsPanel(findings)) expect(frameOpen(row)).toBe(DIM_CYAN_OPEN)
  })
})

describe("frame rows that only some inputs reach take the tint", () => {
  // Each case pins one glyph site. A site that goes back to `c.dimCyan`
  // gives a dim cyan open on that row, and the case fails.
  const bash = (command: string): ToolUseBlock => ({
    type: "tool_use",
    id: "b1",
    name: "Bash",
    input: { command },
  })
  const orange = frameTint(TOOL_PRESENTATION.get("Bash"))
  const DIM_ORANGE = "\x1b[2;38;5;208m"

  it("header continuation rows of a multi-line Bash command (G2)", () => {
    const rows = formatToolHeaderRows({
      tool: bash("echo one\necho two\necho three"),
      presentation: TOOL_PRESENTATION.get("Bash"),
      cols: 100,
    })
    // Open row, 2 continuation rows, the bare gutter row.
    expect(rows.length).toBe(4)
    expect(orange("╭")).toBe(`${DIM_ORANGE}╭${CLOSE}`)
    for (const row of rows) expect(frameOpen(row)).toBe(DIM_ORANGE)
  })

  it("the empty display closer (G3)", () => {
    expect(formatToolPreview("", false, "", { tool: "Task", tint: gold })).toEqual([
      `  ${gold("╰")}`,
    ])
  })

  it("the cut row before the footer of a new-file Write (G4)", () => {
    const display = `${c.dim("new file · 12 lines")}\n1\ta\n2\tb`
    const rows = formatToolPreview("m", false, display, {
      tool: "Write",
      footer: c.dim("shown 10/12 L"),
      tint: gold,
    })
    expect(rows.some((r) => r === `  ${gold("┊")}`)).toBe(true)
    for (const row of rows) expect(frameOpen(row)).toBe(ANSI_CODES.DIM_GOLD)
  })

  it("the streamed tail with no buffered line (G5)", () => {
    const out: string[] = []
    renderStreamedTail({
      bufferedLastLine: null,
      streamedLineCount: 0,
      budget: 10,
      writeTranscript: (line) => out.push(line),
      tint: gold,
    })
    expect(out).toEqual([`  ${gold("╰")} ${c.dim("(no output)")}`])
  })

  it("the +N more row of the diagnostics panel (G8)", () => {
    const findings = Array.from({ length: 4 }, (_, i) => ({
      severity: "warning" as const,
      message: `unused ${i}`,
      line: i + 1,
      source: "lint",
    }))
    const rows = renderFindingsPanel(findings, { maxRows: 2, tint: gold })
    const more = rows.find((r) => r.includes("+2 more"))
    expect(more?.startsWith(`  ${gold("┊")} `)).toBe(true)
    for (const row of rows) expect(frameOpen(row)).toBe(ANSI_CODES.DIM_GOLD)
  })
})

describe("outer frame closer with a tint", () => {
  it("isOuterFrameClose matches a gold and a violet truecolor closer", () => {
    expect(isOuterFrameClose(frameCloseRow("", gold))).toBe(true)
    expect(isOuterFrameClose(frameCloseRow("shown 2/9 L", gold))).toBe(true)
    expect(isOuterFrameClose(frameCloseRow("", violet))).toBe(true)
    expect(isOuterFrameClose(frameCloseRow("x", violet))).toBe(true)
    expect(isOuterFrameClose(`  ${violet("│")} ╰ in the body`)).toBe(false)
  })

  it("reopenFrameCloser keeps the tint", () => {
    expect(reopenFrameCloser(frameCloseRow("x", gold))).toBe(`  ${gold("│")} x`)
  })
})

describe("replay frame rows that only some sessions reach", () => {
  it("the (no result on disk) closer takes the tint of its tool (G1)", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [editTool] },
    ]
    let replay = ""
    await replayToScrollback(
      messages,
      { write: (s: string) => (replay += s) },
      { toolPresentation: toolPresentationMap() },
    )
    const closer = replay.split("\n").find((l) => l.includes("(no result on disk)"))
    expect(closer).toBe(`  ${gold("╰")} ${c.dim("(no result on disk)")}`)
  })
})

describe("live and replay frame parity", () => {
  it("paints the same bytes for one Read block", async () => {
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "r1",
      name: "Read",
      input: { file_path: "a.ts" },
    }
    const content = "1\tconst a = 1\n2\texport { a }"
    const live: string[] = []
    const view = createReplToolView({
      writeTranscript: (line) => live.push(line),
      presentation: TOOL_PRESENTATION,
      columns: () => process.stdout.columns,
    })
    const outcome: ToolViewOutcome = { content, isError: false, aborted: false, findings: [] }
    await view.onToolEvent({ type: "started", tool, pluginTool: false })
    await view.onToolEvent({ type: "outcome", tool, outcome })

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [tool] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "r1", content, is_error: false }],
      },
    ]
    let replay = ""
    await replayToScrollback(
      messages,
      { write: (s: string) => (replay += s) },
      { toolPresentation: toolPresentationMap() },
    )
    const sky = frameTint(TOOL_PRESENTATION.get("Read"))
    expect(live[0]).toContain(sky("╭"))
    expect(live.at(-1)!.startsWith(`  ${sky("╰")}`)).toBe(true)
    expect(replay).toContain(`${live.join("\n")}\n`)
  })

  /** The live rows of one call: the events go to a real REPL tool view. */
  async function liveRows(
    tool: ToolUseBlock,
    events: (
      tool: ToolUseBlock,
    ) => Parameters<ReturnType<typeof createReplToolView>["onToolEvent"]>[0][],
  ): Promise<string[]> {
    const rows: string[] = []
    const view = createReplToolView({
      writeTranscript: (line) => rows.push(line),
      presentation: TOOL_PRESENTATION,
      columns: () => process.stdout.columns,
    })
    for (const event of events(tool)) await view.onToolEvent(event)
    return rows
  }

  /** The replay text of one call and its stored result. */
  async function replayText(
    tool: ToolUseBlock,
    content: string,
    isError: boolean,
    display?: string,
  ): Promise<string> {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [tool] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: tool.id, content, is_error: isError }],
      },
    ]
    let out = ""
    await replayToScrollback(
      messages,
      { write: (s: string) => (out += s) },
      {
        toolPresentation: toolPresentationMap(),
        ...(display === undefined ? {} : { toolDisplays: new Map([[tool.id, { display }]]) }),
      },
    )
    return out
  }

  it("paints the same bytes for one Edit block with a diff display", async () => {
    const display = `${c.dim("1 line changed")}\n@@ -1 +1 @@\n-a\n+b`
    const outcome: ToolViewOutcome = {
      content: "edited",
      isError: false,
      aborted: false,
      findings: [],
      display,
    }
    const live = await liveRows(editTool, (tool) => [
      { type: "started", tool, pluginTool: false },
      { type: "outcome", tool, outcome },
    ])
    const replay = await replayText(editTool, "edited", false, display)
    for (const row of live) expect(frameOpen(row)).toBe(ANSI_CODES.DIM_GOLD)
    expect(replay).toContain(`${live.join("\n")}\n`)
  })

  it("paints the same bytes for one streamed Bash block with a cut", async () => {
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "s1",
      name: "Bash",
      input: { command: "seq 1 30" },
    }
    const content = Array.from({ length: 30 }, (_, i) => String(i + 1)).join("\n")
    const outcome: ToolViewOutcome = { content, isError: false, aborted: false, findings: [] }
    const live = await liveRows(tool, (t) => [
      { type: "started", tool: t, pluginTool: false },
      { type: "output", tool: t, chunk: `${content}\n` },
      { type: "executed", tool: t, isError: false },
      { type: "outcome", tool: t, outcome },
    ])
    const replay = await replayText(tool, content, false)
    const orangeOpen = "\x1b[2;38;5;208m"
    expect(live.some((r) => r.includes("┊"))).toBe(true)
    for (const row of live) expect(frameOpen(row)).toBe(orangeOpen)
    expect(replay).toContain(`${live.join("\n")}\n`)
  })

  it("paints the same header and frame color for one refused Bash call", async () => {
    // Replay has no refusal row: the stored result is an error result, so
    // the body differs. The header rows and the frame color must not.
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "x1",
      name: "Bash",
      input: { command: "rm x" },
    }
    const live = await liveRows(tool, (t) => [
      { type: "refused", tool: t, message: "Bash is not allowed", refusedBy: "ask" },
    ])
    const replay = await replayText(tool, "Bash is not allowed", true)
    const replayRows = replay.split("\n")
    const start = replayRows.findIndex((r) => r.includes("rm x"))
    const block = replayRows.slice(start, replayRows.indexOf("", start + 1))
    const orangeOpen = "\x1b[2;38;5;208m"
    expect(live[0]).toBe(`\n${block[0]}`)
    expect(live[1]).toBe(block[1])
    for (const row of [...live, ...block]) expect(frameOpen(row)).toBe(orangeOpen)
  })
})
