/**
 * Arm the one-shot run values (`--temperature`, `--strict`) on a core for
 * its NEXT run only (core clears them at run start). No imports, so
 * `run-non-interactive.ts` can use it with no import cycle through
 * `run-host-mode.ts`.
 *
 * @module oneshot/arm-run
 */

/** One-shot values armed on the core for the prompt run only. */
export interface OneShotRunOptions {
  readonly temperature?: number
  readonly outputStrict?: boolean
  /**
   * `--schema-retries` (SPEC-ONESHOT R12): extra turns when the answer does
   * not match `--output-schema`. Read by the host run loop, not armed on
   * the core.
   */
  readonly schemaRetries?: number
  /**
   * `--input-format open-responses` request `stream: true` (SPEC-ONESHOT
   * R14/R15): `--output-format open-responses` writes SSE events. Read by
   * the host run loop, not armed on the core.
   */
  readonly orStream?: boolean
}

/**
 * Call the core's one-shot setters for the values that are set. A setter
 * the core lacks is skipped (the plan already warned). Never throws.
 * Returns the names of the setters it called.
 */
export function armOneShotRun(core: unknown, options: OneShotRunOptions): string[] {
  const armed: string[] = []
  if (core === null || typeof core !== "object") return armed
  const call = (name: string, value: unknown): void => {
    const setter = (core as Record<string, unknown>)[name]
    if (typeof setter !== "function") return
    ;(setter as (v: unknown) => void).call(core, value)
    armed.push(name)
  }
  if (options.temperature !== undefined) call("setNextRunTemperature", options.temperature)
  if (options.outputStrict !== undefined) call("setNextRunOutputStrict", options.outputStrict)
  return armed
}

/**
 * The `AgentCore` behind a session-like object (`Session` or
 * `InteractiveSession`), or `undefined` when it has no `agentCore()`.
 */
export function agentCoreOf(session: unknown): unknown {
  if (session === null || typeof session !== "object") return undefined
  const fn = (session as { agentCore?: unknown }).agentCore
  if (typeof fn !== "function") return undefined
  try {
    return (fn as () => unknown).call(session)
  } catch {
    return undefined
  }
}
