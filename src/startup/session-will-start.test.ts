import { describe, expect, it } from "bun:test"

import type { HookContextEntry } from "@minimal-agent/core/sdk/lifecycle"

import {
  announceSessionWillStart,
  sessionStartSource,
  withSessionContext,
} from "./session-will-start.ts"

const PAYLOAD = { source: "startup" as const, sid: "s1", cwd: "/w", model: "m" }

function sink() {
  const added: HookContextEntry[][] = []
  return {
    added,
    core: { addSessionContext: (l: readonly HookContextEntry[]) => void added.push([...l]) },
  }
}

function quietStderr() {
  const lines: string[] = []
  return { lines, stderr: { write: (s: string) => lines.push(s) > 0 } }
}

describe("sessionStartSource", () => {
  it("is resume for a resumed session, else startup", () => {
    expect(sessionStartSource(true)).toBe("resume")
    expect(sessionStartSource(false)).toBe("startup")
  })
})

describe("announceSessionWillStart", () => {
  it("passes the payload and queues the context on the core", async () => {
    const seen: unknown[] = []
    const { added, core } = sink()
    const lines = await announceSessionWillStart(
      {
        sessionWillStart: async (p) => {
          seen.push(p)
          return { additionalContext: ["a", "b"] }
        },
      },
      core,
      { ...PAYLOAD, source: "resume" },
    )
    expect(seen).toEqual([{ ...PAYLOAD, source: "resume" }])
    expect(added).toEqual([["a", "b"]])
    expect(lines).toEqual(["a", "b"])
  })

  it("passes object entries unchanged and drops malformed ones (D2)", async () => {
    const { added, core } = sink()
    const before = { text: "b", position: "before" as const }
    const out = await announceSessionWillStart(
      {
        sessionWillStart: async () => ({
          additionalContext: [
            before,
            "a",
            { text: "x", position: "middle" } as unknown as HookContextEntry,
            7 as unknown as HookContextEntry,
          ],
        }),
      },
      core,
      PAYLOAD,
    )
    expect(added).toEqual([[before, "a"]])
    expect(added[0]?.[0]).toEqual({ text: "b", position: "before" })
    expect(out).toEqual([before, "a"])
  })

  it("does not call addSessionContext for empty context", async () => {
    const { added, core } = sink()
    await announceSessionWillStart(
      { sessionWillStart: async () => ({ additionalContext: [] }) },
      core,
      PAYLOAD,
    )
    expect(added).toEqual([])
  })

  it("a failing port does not throw: no context, one warn line", async () => {
    const { added, core } = sink()
    const { lines, stderr } = quietStderr()
    const out = await announceSessionWillStart(
      {
        sessionWillStart: async () => {
          throw new Error("boom")
        },
      },
      core,
      PAYLOAD,
      stderr,
    )
    expect(out).toEqual([])
    expect(added).toEqual([])
    expect(lines.join("")).toContain("session.willStart failed: boom")
  })

  it("a port without sessionWillStart, or a core without addSessionContext, is a no-op", async () => {
    expect(await announceSessionWillStart({}, sink().core, PAYLOAD)).toEqual([])
    const out = await announceSessionWillStart(
      { sessionWillStart: async () => ({ additionalContext: ["x"] }) },
      {},
      PAYLOAD,
    )
    expect(out).toEqual([])
  })
})

describe("withSessionContext", () => {
  it("queues the lines on the opened session's core", async () => {
    const { added, core } = sink()
    const session = { agentCore: () => core }
    expect(await withSessionContext(["x"], Promise.resolve(session))).toBe(session)
    expect(added).toEqual([["x"]])
    await withSessionContext([], Promise.resolve(session))
    expect(added).toEqual([["x"]])
  })
})
