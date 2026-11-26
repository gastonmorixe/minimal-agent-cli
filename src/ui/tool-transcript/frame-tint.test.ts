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
      { color: "amber" }, // ChromeCDP: not a palette key
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
    for (const [, pres] of TOOL_PRESENTATION) {
      const open = frameOpen(`  ${frameTint(pres)("│")}`)
      const key = pres.color ?? ""
      const expected = Object.hasOwn(PALETTE, key)
        ? `\x1b[2;${PALETTE[key as keyof typeof PALETTE].slice(2)}`
        : DIM_CYAN_OPEN
      expect(open).toBe(expected)
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
})
