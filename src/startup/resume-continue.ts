/**
 * Continue the unfinished turn of a resumed session (S50).
 *
 * `--resume` of a session whose last turn was cut short (a crash, a kill,
 * a restart) continues that turn at its next round. No human is assumed,
 * so the turn starts by itself. This module runs it before the REPL
 * mounts. A `--prompt` run passes `continueTurn` to
 * `runNonInteractivePrompt` instead.
 *
 * @module startup/resume-continue
 */

import type { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import type { ReplAgentLike } from "../repl.ts"
import { runNonInteractivePrompt } from "./run-non-interactive.ts"

/**
 * Continue the unfinished turn of a resumed session before the REPL
 * mounts (S50). No human is assumed, so the turn runs by itself and
 * writes its text to stdout. A failure of that turn is shown on stderr.
 * The REPL then starts on the same history, as after any failed turn.
 */
export async function continueResumedTurn(input: {
  readonly agent: ReplAgentLike
  readonly formatterCmd: string[] | undefined
  readonly loader: PluginLoader | null
  readonly cwd: string
}): Promise<void> {
  try {
    await runNonInteractivePrompt({
      ...input,
      prompt: "",
      continueTurn: true,
      showHeader: false,
      wantJsonOutput: false,
      outputFormat: "text",
      outputSchema: undefined,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`  error: the resumed turn did not finish: ${message}\n`)
  }
}
