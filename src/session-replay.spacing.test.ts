/**
 * Blank-row spacing of the resume replay: exactly one blank row between two
 * neighbor blocks (prompt, tool card, assistant text, thinking).
 */
import { describe, expect, it } from "bun:test"
import type { Message } from "@minimal-agent/core/sdk/messages"
import { replayToScrollback } from "./session-replay.ts"
import { DEFAULT_TOOL_ICON } from "./ui/tool-transcript/format.ts"

class CaptureSink {
  out = ""
  write(s: string): void {
    this.out += s
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

/** One Bash card. No presentation map is passed, so the header draws the default icon. */
const CARD = [`  ╭ ${DEFAULT_TOOL_ICON} Bash  $ ls`, "  │", "  ╰ a.txt"]

const prompt = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

const say = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] })

const toolUse = (id: string) =>
  ({ type: "tool_use", id, name: "Bash", input: { command: "ls" } }) as const

const toolResult = (id: string): Message => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "a.txt", is_error: false }],
})

async function replayRows(messages: Message[]): Promise<string[]> {
  const sink = new CaptureSink()
  await replayToScrollback(messages, sink)
  return stripAnsi(sink.out).split("\n")
}

describe("replayToScrollback blank rows", () => {
  it("puts one blank row between a tool card and the text of the next message", async () => {
    const rows = await replayRows([
      prompt("go"),
      { role: "assistant", content: [toolUse("t1")] },
      toolResult("t1"),
      say("END"),
    ])
    expect(rows).toEqual(["❯ go", "", ...CARD, "", "END", "", ""])
  })

  it("puts one blank row between a tool card and later text in the same message", async () => {
    const rows = await replayRows([
      prompt("go"),
      { role: "assistant", content: [toolUse("t1"), { type: "text", text: "END" }] },
      toolResult("t1"),
    ])
    expect(rows).toEqual(["❯ go", "", ...CARD, "", "END", "", ""])
  })

  it("keeps one blank row around each card in a mixed text and tool run", async () => {
    const rows = await replayRows([
      prompt("go"),
      { role: "assistant", content: [toolUse("t1")] },
      toolResult("t1"),
      { role: "assistant", content: [{ type: "text", text: "MID" }, toolUse("t2")] },
      toolResult("t2"),
      { role: "assistant", content: [toolUse("t3")] },
      toolResult("t3"),
      say("END"),
    ])
    expect(rows).toEqual([
      "❯ go",
      "",
      ...CARD,
      "",
      "MID",
      "",
      ...CARD,
      "",
      ...CARD,
      "",
      "END",
      "",
      "",
    ])
  })

  it("puts one blank row between a tool card and thinking", async () => {
    const rows = await replayRows([
      prompt("go"),
      { role: "assistant", content: [toolUse("t1")] },
      toolResult("t1"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "" },
          { type: "text", text: "END" },
        ],
      },
    ])
    expect(rows).toEqual(["❯ go", "", ...CARD, "", "hmm", "END", "", ""])
  })

  it("puts one blank row between a tool card and the next user prompt", async () => {
    const rows = await replayRows([
      prompt("go"),
      { role: "assistant", content: [toolUse("t1")] },
      toolResult("t1"),
      prompt("again"),
    ])
    expect(rows).toEqual(["❯ go", "", ...CARD, "", "❯ again", "", ""])
  })

  it("does not add a blank row between two text blocks of one message", async () => {
    const rows = await replayRows([
      prompt("go"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
        ],
      },
    ])
    expect(rows).toEqual(["❯ go", "", "A", "B", "", ""])
  })
})
