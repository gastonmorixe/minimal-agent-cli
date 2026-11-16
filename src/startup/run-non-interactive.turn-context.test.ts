import { describe, expect, it } from "bun:test"
import type { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import type { ReplAgentLike } from "../repl.ts"
import type { TestSendResult as StreamedResponse } from "../test-utils/transport-types.ts"

import { runNonInteractivePrompt } from "./run-non-interactive.ts"

/** A loader whose `turn.willStart` chain records the payload and returns context. */
function contextLoader(seen: unknown[], ctx: string[]): PluginLoader {
  return {
    hooks: () => ({
      on: () => undefined,
      emitChain: async (_channel: string, payload: unknown) => {
        seen.push(payload)
        return { payload, halted: false, additionalContext: ctx }
      },
    }),
  } as unknown as PluginLoader
}

/** A fake agent that logs each run and its additionalContext. A queue on the core is a bug. */
function fakeAgent(log: string[]): ReplAgentLike {
  const core = { addSessionContext: (l: string[]) => void log.push(`queued:${l.join("|")}`) }
  return {
    agentCore: () => core,
    getActiveMode: () => ({ id: "plan" }),
    run(prompt: string, opts?: { additionalContext?: string[] }) {
      const ctx = opts?.additionalContext
      log.push(ctx === undefined ? `run:${prompt}` : `run:${prompt}+${ctx.join("|")}`)
      return (async function* () {
        yield "ok"
        return { blocks: [], text: "ok", stopReason: "end_turn" } as unknown as StreamedResponse
      })()
    },
  } as unknown as ReplAgentLike
}

async function quiet(fn: () => Promise<void>): Promise<void> {
  const orig = process.stdout.write.bind(process.stdout)
  ;(process.stdout as unknown as { write: () => boolean }).write = () => true
  try {
    await fn()
  } finally {
    ;(process.stdout as unknown as { write: typeof orig }).write = orig
  }
}

describe("runNonInteractivePrompt turn.willStart context", () => {
  it("passes sid/agentMode and gives the context to the prompt run as additionalContext", async () => {
    const seen: unknown[] = []
    const log: string[] = []
    await quiet(() =>
      runNonInteractivePrompt({
        agent: fakeAgent(log),
        prompt: "go",
        formatterCmd: undefined,
        showHeader: false,
        wantJsonOutput: false,
        outputSchema: undefined,
        loader: contextLoader(seen, ["T1", "T2"]),
        cwd: process.cwd(),
      }),
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ text: "go", agentMode: "plan" })
    expect(typeof (seen[0] as { sid?: unknown }).sid).toBe("string")
    expect(log).toEqual(["run:go+T1|T2"])
  })

  it("no context: the run gets no additionalContext", async () => {
    const log: string[] = []
    await quiet(() =>
      runNonInteractivePrompt({
        agent: fakeAgent(log),
        prompt: "go",
        formatterCmd: undefined,
        showHeader: false,
        wantJsonOutput: false,
        outputSchema: undefined,
        loader: contextLoader([], []),
        cwd: process.cwd(),
      }),
    )
    expect(log).toEqual(["run:go"])
  })
})
