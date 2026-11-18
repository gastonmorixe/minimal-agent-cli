import { describe, expect, it, spyOn } from "bun:test"
import { getDiagnosticBus, type LogEvent, Severity } from "@minimal-agent/core/host/diagnostics"
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

describe("applyTurnWillStart: a failing chain goes to the diagnostic bus", () => {
  it("emits a Warning repl.hook-chain-failed, passes the text through and writes nothing to stderr", async () => {
    const events: LogEvent[] = []
    const off = getDiagnosticBus().on("*", (e) => events.push(e))
    const stderrWrite = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const failing = loaderWith(async () => {
        throw new Error("chain boom")
      })
      const out = await applyTurnWillStart(failing, "keep me")
      expect(out).toEqual({ text: "keep me", halted: false, additionalContext: [] })

      const got = events.filter((e) => e.source === "repl.hook-chain-failed")
      expect(got).toHaveLength(1)
      expect(got[0]?.severity).toBe(Severity.Warning)
      expect(got[0]?.message).toBe("chain boom")
      expect(got[0]?.structuredData).toEqual({ chain: "turn.willStart" })
      expect(stderrWrite).not.toHaveBeenCalled()
    } finally {
      stderrWrite.mockRestore()
      off()
    }
  })

  it("reports a non-Error throw by its string form", async () => {
    const events: LogEvent[] = []
    const off = getDiagnosticBus().on("*", (e) => events.push(e))
    const stderrWrite = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const failing = loaderWith(async () => {
        throw "plain string"
      })
      await applyTurnWillStart(failing, "x")
      const got = events.filter((e) => e.source === "repl.hook-chain-failed")
      expect(got).toHaveLength(1)
      expect(got[0]?.message).toBe("plain string")
      expect(stderrWrite).not.toHaveBeenCalled()
    } finally {
      stderrWrite.mockRestore()
      off()
    }
  })
})
