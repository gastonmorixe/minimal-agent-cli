/**
 * Child process for the SIGTERM wrap-up spawn test. It runs the real
 * `runNonInteractivePrompt` on the stream-json route with the real
 * `process.stdout`, the real SIGTERM listener and the real exit path (no
 * injected `stdout`, `exit` or `wrapUp`).
 *
 * The fake provider: round 1 stalls until the run signal aborts. The final
 * turn (`final` mode) answers with one `Report` tool call, and the tool
 * writes the sentinel file. In `hang` mode the final request stalls and
 * ignores its signal (only a second SIGTERM can end the process). The
 * `live` mode is `final`, and an interval stays alive after the run (a
 * live handle: only the after-run exit can end the process).
 *
 * The child also installs one plugin-style fan-out SIGTERM listener (the
 * ma-hooks / ma-background protocol): it defers to an untagged owner, or
 * removes itself and raises the signal again.
 *
 * Each request writes `SEND <n>` on stderr. Usage:
 *   bun run sigterm-wrap-up-child.ts MODE SENTINEL_PATH (MODE: `final`, `hang` or `live`)
 *
 * @module host/startup/fixtures/sigterm-wrap-up-child
 */

import { writeFileSync } from "node:fs"
import { createRuntime } from "@minimal-agent/core"
import type { AuthResult } from "@minimal-agent/core/host/auth"
import type { ToolExecResult } from "@minimal-agent/core/sdk/ports"
import type { ReplAgentLike } from "../../repl.ts"
import type { TestSendResult } from "../../test-utils/transport-types.ts"
import { runNonInteractivePrompt } from "../run-non-interactive.ts"

const mode = process.argv[2] ?? "final"
const sentinel = process.argv[3] ?? ""
const AUTH: AuthResult = { type: "api-key", token: "test-token" }

/** Stall until `signal` aborts. A timer keeps the event loop alive. */
function stall(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const keep = setInterval(() => {}, 1000)
    signal?.addEventListener(
      "abort",
      () => {
        clearInterval(keep)
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
      },
      { once: true },
    )
  })
}

// A plugin-style fan-out listener (tagged with the shared symbol).
const FANOUT = Symbol.for("minimal-agent.signal-fanout")
const fanOut = Object.assign(
  (): void => {
    const owners = process
      .listeners("SIGTERM")
      .filter((l) => (l as unknown as Record<symbol, unknown>)[FANOUT] !== true).length
    process.stderr.write(`FANOUT owners=${owners}\n`)
    if (owners > 0) return
    process.off("SIGTERM", fanOut)
    process.kill(process.pid, "SIGTERM")
  },
  { [FANOUT]: true },
)
process.on("SIGTERM", fanOut)

let sends = 0
const sendFn = async function* (opts: {
  signal?: AbortSignal
}): AsyncGenerator<string, TestSendResult, undefined> {
  sends++
  process.stderr.write(`SEND ${sends}\n`)
  if (sends === 1) await stall(opts.signal)
  // `hang`: a final request that ignores its signal.
  if (mode === "hang") await stall(undefined)
  yield ""
  return {
    blocks: [{ type: "tool_use" as const, id: "r1", name: "Report", input: {} }],
    text: "",
    stopReason: "tool_use",
  } as TestSendResult
}

// The legacy-path agent never runs on the event-stream route.
const neverAgent = {
  run(): never {
    throw new Error("legacy-path agent.run must not be called")
  },
} as unknown as ReplAgentLike

await runNonInteractivePrompt({
  agent: neverAgent,
  prompt: "go",
  formatterCmd: undefined,
  showHeader: false,
  wantJsonOutput: false,
  outputSchema: undefined,
  loader: null,
  cwd: process.cwd(),
  outputFormat: "stream-json",
  openEventStreamSession: () =>
    Promise.resolve(
      createRuntime().openSession({
        auth: AUTH,
        model: "test-model",
        toolRegistry: {
          list: () => [
            { name: "Bash", description: "d", input_schema: {} },
            { name: "Report", description: "d", input_schema: {} },
          ],
        },
        toolExecutor: {
          execute: async (tool): Promise<ToolExecResult> => {
            if (tool.name === "Report") writeFileSync(sentinel, "done")
            // `live`: a handle that keeps the event loop alive after the run.
            if (mode === "live") setInterval(() => {}, 1000)
            return { content: "ok", isError: false }
          },
        },
        sendFn: sendFn as never,
        id: "sigterm-wrap-up-sid",
      }),
    ),
})
