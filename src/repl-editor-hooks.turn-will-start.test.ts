import { describe, expect, it } from "bun:test"
import { getSessionId } from "@minimal-agent/core/host/session-id"

import { applyTurnWillStart, type EditorHooksLoader } from "./repl-editor-hooks.ts"

function loaderWith(
  emit: (channel: string, payload: unknown) => Promise<unknown>,
): EditorHooksLoader {
  return {
    hooks: () => ({ on: () => undefined, emitChain: emit as never }),
  }
}

describe("applyTurnWillStart", () => {
  it("fills sid and agentMode and returns the additionalContext", async () => {
    const seen: unknown[] = []
    const loader = loaderWith(async (channel, payload) => {
      seen.push({ channel, payload })
      return { payload: { text: "new" }, halted: false, additionalContext: ["c1", 2, "c2"] }
    })
    const out = await applyTurnWillStart(loader, "old", { sid: "s9", agentMode: "ask" })
    expect(seen).toEqual([
      { channel: "turn.willStart", payload: { text: "old", sid: "s9", agentMode: "ask" } },
    ])
    expect(out).toEqual({ text: "new", halted: false, additionalContext: ["c1", "c2"] })
  })

  it("defaults sid to getSessionId and drops a null agentMode", async () => {
    const seen: unknown[] = []
    const loader = loaderWith(async (_c, payload) => {
      seen.push(payload)
      return { payload }
    })
    const out = await applyTurnWillStart(loader, "t", { agentMode: null })
    expect(seen).toEqual([{ text: "t", sid: getSessionId() }])
    expect(out.additionalContext).toEqual([])
  })

  it("keeps the old two-argument call and shape", async () => {
    expect(await applyTurnWillStart(null, "x")).toEqual({
      text: "x",
      halted: false,
      additionalContext: [],
    })
    const failing = loaderWith(async () => {
      throw new Error("boom")
    })
    const orig = process.stderr.write.bind(process.stderr)
    ;(process.stderr as unknown as { write: () => boolean }).write = () => true
    try {
      const out = await applyTurnWillStart(failing, "x")
      expect(out).toEqual({ text: "x", halted: false, additionalContext: [] })
    } finally {
      ;(process.stderr as unknown as { write: typeof orig }).write = orig
    }
  })
})
