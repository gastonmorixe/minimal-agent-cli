/**
 * The tool header time hint (moved from core, spec S24). The REPL tool view
 * owns the `ToolTimeTracker`. With a tracker, the first header ends with
 * ` · Mon DD HH:MM:SS` and a later header on the same day ends with
 * ` · HH:MM:SS`. With no tracker, a header has no time hint.
 */

import { describe, expect, it } from "bun:test"

import { ToolTimeTracker } from "@minimal-agent/core/host/tool-time"
import { ToolFeedbackTracker } from "@minimal-agent/core/host-kit/feedback-tracker"
import { ToolExecutorAdapter } from "@minimal-agent/core/host-kit/tool-executor-adapter"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { createReplToolView } from "./tool-view.ts"

const TIME_RE = /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2}/

async function headers(tracker: ToolTimeTracker | null, calls: number): Promise<string[]> {
  const rows: string[] = []
  const executor = new ToolExecutorAdapter({
    toolView: createReplToolView({
      writeTranscript: (line) => rows.push(line),
      presentation: new Map(),
      toolTimeTracker: tracker,
    }),
    loader: null,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    model: "test-model",
  })
  for (let i = 0; i < calls; i++) {
    await executor.execute({
      type: "tool_use",
      id: `t${i}`,
      name: "Bash",
      input: { command: "true" },
    })
  }
  return rows.filter((l) => l.includes("╭")).map((l) => stripAnsi(l).trim())
}

describe("REPL tool view: header time hint", () => {
  it("shows the date on the first header and only the time on the next", async () => {
    const [first, second] = await headers(new ToolTimeTracker(), 2)
    expect(first).toMatch(new RegExp(` · ${TIME_RE.source}$`))
    expect(second).toMatch(/ · \d{2}:\d{2}:\d{2}$/)
    expect(second).not.toMatch(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/)
  })

  it("shows no time hint with no tracker", async () => {
    const [first] = await headers(null, 1)
    expect(first).toMatch(/\$ true$/)
    expect(first).not.toMatch(/\d{2}:\d{2}:\d{2}/)
  })
})
