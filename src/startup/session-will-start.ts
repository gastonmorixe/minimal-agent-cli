/**
 * `session.willStart` at the host start points (`main()` and host mode).
 *
 * The host fires the lifecycle port once per session start, BEFORE the
 * first user turn, and hands the listeners' `additionalContext` to the core
 * (`AgentCore.addSessionContext`). The core puts the lines one time into
 * the next user message, as a context block before the user text. The
 * system prompt does not change.
 *
 * Never throws: a failing port, or a core without `addSessionContext`,
 * means "no context", and the host goes on.
 *
 * @module host/startup/session-will-start
 */

import type { LifecyclePort, SessionWillStartPayload } from "@minimal-agent/core/sdk/lifecycle"

/** The core surface this helper writes to. Optional so an older core still compiles. */
export interface SessionContextSink {
  addSessionContext?(lines: string[]): void
}

/**
 * Queue `lines` on the core of a session that `opening` resolves to, for a
 * second session the host opens after `session.willStart` already fired
 * (the event-stream route). No lines: the session passes through as is.
 */
export async function withSessionContext<S extends { agentCore?(): SessionContextSink }>(
  lines: readonly string[],
  opening: Promise<S>,
): Promise<S> {
  const session = await opening
  if (lines.length === 0) return session
  const core = typeof session.agentCore === "function" ? session.agentCore() : undefined
  if (typeof core?.addSessionContext === "function") core.addSessionContext([...lines])
  return session
}

/** `"resume"` when the host resumes a saved session, else `"startup"`. */
export function sessionStartSource(resuming: boolean): SessionWillStartPayload["source"] {
  return resuming ? "resume" : "startup"
}

/**
 * Await `lifecycle.sessionWillStart`, then queue its context on `core`.
 * Returns the lines that were queued (empty when none, or on a failure).
 * A failure writes one warn line to `stderr`.
 */
export async function announceSessionWillStart(
  lifecycle: Pick<LifecyclePort, "sessionWillStart">,
  core: SessionContextSink | null | undefined,
  payload: SessionWillStartPayload,
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
): Promise<string[]> {
  if (typeof lifecycle.sessionWillStart !== "function") return []
  let lines: string[]
  try {
    const result = await lifecycle.sessionWillStart(payload)
    lines = Array.isArray(result?.additionalContext)
      ? result.additionalContext.filter((l): l is string => typeof l === "string")
      : []
  } catch (e) {
    stderr.write(
      `[minimal-agent] warn: session.willStart failed: ${e instanceof Error ? e.message : String(e)}\n`,
    )
    return []
  }
  if (lines.length === 0) return []
  if (typeof core?.addSessionContext !== "function") return []
  try {
    core.addSessionContext(lines)
  } catch (e) {
    stderr.write(
      `[minimal-agent] warn: session context was not added: ${e instanceof Error ? e.message : String(e)}\n`,
    )
    return []
  }
  return lines
}
