/**
 * A `turn.willStart` object entry with `position: "before"` reaches the run
 * opts unchanged (the CLI passes entries through, the core places them).
 */

import { describe, expect, it } from "bun:test"
import type { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import type { HookContextEntry } from "@minimal-agent/core/sdk/lifecycle"
import type { ReplAgentLike } from "../repl.ts"
import { applyTurnWillStart } from "../repl-editor-hooks.ts"
import type { TestSendResult as StreamedResponse } from "../test-utils/transport-types.ts"

import { runNonInteractivePrompt } from "./run-non-interactive.ts"

const ENTRIES: HookContextEntry[] = ["A", { text: "B", position: "before" }, { text: "C" }]

function loaderWith(ctx: unknown[]): PluginLoader {
  return {
    hooks: () => ({
      on: () => undefined,
      emitChain: async (_channel: string, payload: unknown) => ({
        payload,
        halted: false,
        additionalContext: ctx,
      }),
    }),
  } as unknown as PluginLoader
}

describe("turn.willStart entries pass through unchanged", () => {
  it("applyTurnWillStart keeps object entries and drops malformed ones", async () => {
    const out = await applyTurnWillStart(
      loaderWith([...ENTRIES, { text: 1 }, { text: "x", position: "mid" }]),
      "go",
      {
        sid: "s",
      },
    )
    expect(out.additionalContext).toEqual(ENTRIES)
  })

  it("the prompt run gets the entries as run opts.additionalContext", async () => {
    const runs: Array<{ prompt: string; opts: unknown }> = []
    const agent = {
      agentCore: () => ({ addSessionContext: () => undefined }),
      getActiveMode: () => null,
      run(prompt: string, opts?: unknown) {
        runs.push({ prompt, opts })
        return (async function* () {
          yield "ok"
          return { blocks: [], text: "ok", stopReason: "end_turn" } as unknown as StreamedResponse
        })()
      },
    } as unknown as ReplAgentLike
    const orig = process.stdout.write.bind(process.stdout)
    ;(process.stdout as unknown as { write: () => boolean }).write = () => true
    try {
      await runNonInteractivePrompt({
        agent,
        prompt: "go",
        formatterCmd: undefined,
        showHeader: false,
        wantJsonOutput: false,
        outputSchema: undefined,
        loader: loaderWith(ENTRIES),
        cwd: process.cwd(),
      })
    } finally {
      ;(process.stdout as unknown as { write: typeof orig }).write = orig
    }
    expect(runs).toEqual([{ prompt: "go", opts: { additionalContext: ENTRIES } }])
  })
})
