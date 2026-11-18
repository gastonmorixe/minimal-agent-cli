/**
 * SPEC v6.1 T7: a session file from before M2 (tool_result records with no
 * `outcome`) and the same session with a valid `outcome` on each tool_result
 * record replay in the CLI with the same view. The test goes through the CLI
 * resume path (`loadResumeState` in `startup/resume-load.ts`, which calls
 * `toolDisplaysFromRecords`) and the scrollback replay (`replayToScrollback`).
 */

import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SessionStore } from "@minimal-agent/core/host-kit/session-store"
import type { ToolResultBlock } from "@minimal-agent/core/sdk/messages"

import { replayToScrollback } from "./session-replay.ts"
import { loadResumeState } from "./startup/resume-load.ts"

const ANSI_RE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "")

const BASH_TEXT = "one\ntwo\n"
const EDIT_TEXT = "File edited: /tmp/a.txt (1 replacement)"
const T0 = Date.UTC(2026, 10, 17, 12, 0, 0)
const at = (s: number) => new Date(T0 + s * 1000)

/** A valid record form for a text with no annotations (SPEC D8). */
const outcomeFor = (text: string) => ({
  v: 1 as const,
  bodyEnd: text.length,
  annotations: [],
  data: { chars: text.length },
})

const homes: string[] = []
const prevHome = process.env.MINIMAL_AGENT_HOME
afterEach(() => {
  if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = prevHome
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

/** Write one session with a Bash round and an Edit round. */
function writeSession(dir: string, sid: string, withOutcome: boolean): void {
  const store = SessionStore.open({
    sid,
    dir,
    model: "test-model",
    cwd: "/tmp",
    systemHash: "h",
    toolsHash: "h",
    agentVersion: "test",
    now: () => at(0),
  })
  const result = (id: string, text: string, s: number) => {
    const block: ToolResultBlock = { type: "tool_result", tool_use_id: id, content: text }
    store.appendToolResult(block, at(s), undefined, withOutcome ? outcomeFor(text) : undefined)
  }
  store.appendUser("run the tools", at(1))
  store.appendAssistant(
    [
      {
        type: "tool_use",
        id: "tu_bash",
        name: "Bash",
        input: { command: "printf 'one\\ntwo\\n'" },
      },
    ],
    "tool_use",
    undefined,
    at(2),
  )
  result("tu_bash", BASH_TEXT, 3)
  store.appendAssistant(
    [
      {
        type: "tool_use",
        id: "tu_edit",
        name: "Edit",
        input: { file_path: "/tmp/a.txt", old_string: "OLD", new_string: "NEW" },
      },
    ],
    "tool_use",
    undefined,
    at(4),
  )
  result("tu_edit", EDIT_TEXT, 5)
  store.appendAssistant([{ type: "text", text: "all done" }], "end_turn", undefined, at(6))
}

/** Load the session through the CLI resume path and replay it to text. */
async function resumeView(withOutcome: boolean) {
  const home = mkdtempSync(join(tmpdir(), "cli-t7-"))
  homes.push(home)
  process.env.MINIMAL_AGENT_HOME = home
  const sid = withOutcome ? "t7-new" : "t7-old"
  writeSession(join(home, "sessions"), sid, withOutcome)
  const state = loadResumeState(sid, process.env)
  let out = ""
  await replayToScrollback(
    state.displayMessages,
    { write: (s: string) => (out += s) },
    {
      toolDisplays: state.toolDisplays,
      toolStartTimes: state.toolStartTimes,
      userTimestamps: state.userTimestamps,
      toolPresentation: new Map(),
    },
  )
  return { state, out, sid }
}

/** The tool_result blocks of a message list. */
const resultBlocks = (messages: readonly { content: unknown }[]) =>
  messages.flatMap((m) =>
    Array.isArray(m.content)
      ? (m.content as Array<Record<string, unknown>>).filter((b) => b.type === "tool_result")
      : [],
  )

/** The messages with the `outcome` key removed from each tool_result block. */
const withoutOutcome = (messages: readonly { content: unknown }[]) =>
  JSON.parse(JSON.stringify(messages), (k, v) => (k === "outcome" ? undefined : v))

describe("T7: tool_result records with and without outcome replay the same in the CLI", () => {
  it("the resume state and the scrollback replay are the same, with no crash", async () => {
    const oldView = await resumeView(false)
    const newView = await resumeView(true)

    // The new session really holds a stored outcome, and restore keeps it.
    const newBlocks = resultBlocks(newView.state.initialMessages)
    expect(newBlocks).toHaveLength(2)
    expect(newBlocks.every((b) => b.outcome !== undefined)).toBe(true)
    const oldBlocks = resultBlocks(oldView.state.initialMessages)
    expect(oldBlocks).toHaveLength(2)
    expect(oldBlocks.some((b) => "outcome" in b)).toBe(false)

    // The display map (toolDisplaysFromRecords) is the same.
    expect([...newView.state.toolDisplays.entries()]).toEqual([
      ...oldView.state.toolDisplays.entries(),
    ])
    expect(newView.state.toolDisplays.get("tu_edit")?.display).toContain("-OLD")

    // The other replay inputs are the same.
    expect([...newView.state.toolStartTimes]).toEqual([...oldView.state.toolStartTimes])
    expect(newView.state.userTimestamps).toEqual(oldView.state.userTimestamps)
    expect(newView.state.pendingDraft).toBe(oldView.state.pendingDraft)
    expect(withoutOutcome(newView.state.displayMessages)).toEqual(
      withoutOutcome(oldView.state.displayMessages),
    )
    expect(withoutOutcome(newView.state.initialMessages)).toEqual(
      withoutOutcome(oldView.state.initialMessages),
    )
    // The banner differs only in the session id.
    expect(newView.state.banner.replace(newView.sid, "SID")).toBe(
      oldView.state.banner.replace(oldView.sid, "SID"),
    )

    // The scrollback text is byte equal and shows the tool output.
    expect(newView.out).toBe(oldView.out)
    const plain = stripAnsi(newView.out)
    expect(plain).toContain("two")
    expect(plain).toContain("+NEW")
  })
})
