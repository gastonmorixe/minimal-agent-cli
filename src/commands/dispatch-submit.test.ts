/**
 * `dispatchCommandAndApply`: the `source` tag that each enqueue path gives to
 * `prompt.submitted` (SPEC §6.1). An unhandled command line is `command`; an
 * expanded command or skill text is `expand`; the host `/continue` is `continue`.
 *
 * @module commands/dispatch-submit.test
 */

import { describe, expect, it } from "bun:test"
import type { CommandResult, PromptSource } from "@minimal-agent/core/plugin-api/types/plugin"
import { type DispatchSubmitDeps, dispatchCommandAndApply } from "./dispatch-submit.ts"

interface Enqueued {
  text: string
  commitLines: string[]
  submittedAt: Date | undefined
  source: PromptSource | undefined
}

function harness(result: CommandResult | null) {
  const enqueued: Enqueued[] = []
  const emitted: Array<{ event: string; payload: { prompt: string } }> = []
  const notices: string[][] = []
  const deps: DispatchSubmitDeps = {
    loader: {
      dispatchCommand: async () => result,
      bus: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }),
    },
    writeNoticeLines: (lines) => notices.push(lines),
    liveCols: () => 80,
    enqueuePrompt: (text, commitLines, submittedAt, source) =>
      enqueued.push({ text, commitLines, submittedAt, source }),
    flushCommandLine: () => {},
    compactStream: {},
  }
  return { deps, enqueued, emitted, notices }
}

describe("dispatchCommandAndApply source tags", () => {
  it("an unhandled command line is queued with source 'command'", async () => {
    const h = harness(null)
    const at = new Date("2026-11-19T00:00:00Z")
    await dispatchCommandAndApply(h.deps, "/nope arg", ["❯ /nope arg"], at)
    expect(h.enqueued).toEqual([
      { text: "/nope arg", commitLines: ["❯ /nope arg"], submittedAt: at, source: "command" },
    ])
  })

  it("an expand result is queued with source 'expand' and the expanded text", async () => {
    const h = harness({ kind: "expand", prompt: "EXPANDED TEMPLATE" } as CommandResult)
    await dispatchCommandAndApply(h.deps, "/loop go", [])
    expect(h.enqueued).toEqual([
      { text: "EXPANDED TEMPLATE", commitLines: [], submittedAt: undefined, source: "expand" },
    ])
  })

  it("history-edit expand still announces the expanded prompt", async () => {
    const h = harness({ kind: "expand", prompt: "EDITED" } as CommandResult)
    await dispatchCommandAndApply(h.deps, "/history-edit", [])
    expect(h.enqueued[0]?.source).toBe("expand")
    expect(h.emitted).toEqual([{ event: "history.edit.expanded", payload: { prompt: "EDITED" } }])
  })

  it("the registered /continue command (expand to '') is queued with source 'continue'", async () => {
    const h = harness({ kind: "expand", prompt: "" } as CommandResult)
    await dispatchCommandAndApply(h.deps, "/continue", [])
    expect(h.enqueued).toEqual([
      { text: "", commitLines: [], submittedAt: undefined, source: "continue" },
    ])
  })

  it("a notice result queues nothing", async () => {
    const h = harness({ kind: "notice", lines: ["hi"] } as CommandResult)
    await dispatchCommandAndApply(h.deps, "/info", [])
    expect(h.enqueued).toEqual([])
    expect(h.notices).toEqual([["hi"]])
  })
})
