/**
 * Exit and failure helpers for `main()` (`src/main.ts`).
 *
 * The stream-json failure lines, the exit-code rules after a run, the agent
 * home publication, and a small diagnostic-bus sugar. Kept apart so
 * `main.ts` stays a composition root.
 *
 * @module startup/entry-exit
 */

import { Facility, getDiagnosticBus, Severity } from "@minimal-agent/core/host/diagnostics"
import { getSessionId } from "@minimal-agent/core/host/session-id"
import { AGENT_HOME_ENV, resolveAgentHome } from "@minimal-agent/core/plugin-api/utils/agent-paths"

import { extractPromptFromArgs } from "../cli/extract-prompt.ts"
import { wantsStreamJsonFailureLines } from "./resume-mode.ts"
import { type StreamInfo, writeStreamJsonFailure } from "./stream-json-writer.ts"

/** What the stream-json failure writer needs. Filled in as startup goes on. */
export interface StreamFailureState {
  args?: readonly string[]
  outputFormat?: string
  outputSchemaPath?: string | undefined
  info?: StreamInfo
}

/**
 * On `--output-format stream-json`, end stdout with the failure lines
 * (`error`, then `run_finished` failed). Call it before the stderr text and
 * the exit. A run with no prompt (the REPL) and `--output-schema` are
 * skipped. See {@link wantsStreamJsonFailureLines}.
 *
 * @returns true when it wrote lines to stdout.
 */
export function writeStreamFailure(state: StreamFailureState, err: unknown): boolean {
  if (state.args === undefined || state.outputFormat === undefined) return false
  const wants = wantsStreamJsonFailureLines({
    outputFormat: state.outputFormat,
    hasOutputSchema: state.outputSchemaPath !== undefined,
    promptSource: extractPromptFromArgs([...state.args]),
  })
  if (!wants) return false
  const info = state.info
  writeStreamJsonFailure(err, { sessionId: getSessionId(), ...(info ? { streamInfo: info } : {}) })
  return true
}

/**
 * End a failed run with code 1. After stream-json lines it only returns 1:
 * `process.exit` can drop queued stdout on a slow pipe reader. The bin sets
 * `process.exitCode`, and the process ends when stdout drains. With no
 * stream lines it exits now, as the entry point always did.
 */
export function endFailedRun(wroteStream: boolean, exit: (code: number) => never): number {
  if (!wroteStream) exit(1)
  return 1
}

/**
 * Terse diagnostic-bus sugar for this file. `./host/diagnostics` exports
 * the bus, not core's `diag` object.
 */
export const diag = {
  notice(source: string, message: string): void {
    emitDiag(Severity.Notice, source, message)
  },
  warn(source: string, message: string): void {
    emitDiag(Severity.Warning, source, message)
  },
}

function emitDiag(severity: Severity, source: string, message: string): void {
  getDiagnosticBus().emit({ ts: Date.now(), severity, facility: Facility.User, source, message })
}

/** The exit code a runner set on `process.exitCode`, as a number. */
export function currentExitCode(): number {
  const code = Number(process.exitCode ?? 0)
  return Number.isInteger(code) ? code : 1
}

/**
 * Publish the resolved agent home into `env.MINIMAL_AGENT_HOME`.
 * Idempotent and override-preserving: a set value is normalized, never
 * replaced by the default.
 */
export function publishAgentHomeEnv(env: NodeJS.ProcessEnv): string {
  const resolved = resolveAgentHome(env)
  env[AGENT_HOME_ENV] = resolved
  return resolved
}
