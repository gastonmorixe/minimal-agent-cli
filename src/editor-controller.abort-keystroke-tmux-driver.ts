/**
 * Driver for `src/bus/abort-keystroke-tmux.test.ts`.
 *
 * Wires a REAL `EditorController` (reading the pane's stdin) into
 * `runReplLiveArea`, with the compositor + stdio interceptor pairing from
 * `startup/live-repl.ts`. Only the agent is fake: each turn prints
 * `working on: <prompt>` and then waits for the turn's abort signal, so the
 * keystrokes the test sends land while the FSM is `working`.
 *
 * Tracked so the smoke test does not depend on ignored local files under
 * `tmp/`. It lives in the host package, not `test-utils/fixtures/`, because
 * it wires host-shell modules that core files may not import (see
 * `architecture/core-host-import-scan.test.ts`).
 */
import { EditorController } from "./editor-controller.ts"
import { type ReplAgentLike, runRepl } from "./repl.ts"
import { Compositor } from "./ui/compositor.ts"
import { StdioInterceptor } from "./ui/stdio-interceptor.ts"

/**
 * The `run` method's generator return value, derived structurally from
 * `ReplAgentLike` itself instead of naming the legacy transport result
 * type directly: `src/architecture/core-boundary.test.ts`
 * forbids importing that name from a core package anywhere in this repo's
 * production sources (see `LEGACY_CORE_TRANSPORT_CONTRACTS`). This fake
 * agent only needs SOME type to satisfy the stub return below, and
 * `ReplAgentLike["run"]`'s own declared return already carries it — pulling
 * it out this way keeps the stub type-checked without the forbidden import.
 */
type FakeRunResult = ReplAgentLike["run"] extends (
  ...args: never[]
) => AsyncGenerator<string, infer TReturn, undefined>
  ? TReturn
  : never

let interceptorRef: StdioInterceptor | null = null
const compositor = new Compositor({
  output: {
    isTTY: process.stdout.isTTY,
    get columns() {
      return process.stdout.columns
    },
    get rows() {
      return process.stdout.rows
    },
    write: (s: string) => {
      if (interceptorRef) return interceptorRef.rawStdoutWrite(s) as boolean
      return process.stdout.write(s)
    },
  } as any,
})
const interceptor = new StdioInterceptor(compositor)
interceptorRef = interceptor

const editor = new EditorController({
  prompt: "❯ ",
  continuationPrompt: "  ",
  compositor,
})

const agent: ReplAgentLike = {
  pluginLoader: () => null,
  async *run(text, opts) {
    yield `working on: ${text}\n`
    // Hold the turn open until the user aborts it (Esc / Ctrl+C).
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
      if (opts?.signal?.aborted) abort()
      else opts?.signal?.addEventListener("abort", abort, { once: true })
    })
    return { blocks: [], text: "", stopReason: "end_turn" } as unknown as FakeRunResult
  },
}

interceptor.install()
try {
  await runRepl(agent, { useLiveArea: true, compositor, editor })
} finally {
  interceptor.uninstall()
}
