/**
 * The `update` hook of `src/main.ts`: a cheap argv check, then a lazy
 * import of the command, so a normal boot never loads the updater.
 *
 * @module startup/update-dispatch
 */

/** What the hook reads from the entrypoint io. */
export interface UpdateDispatchIo {
  /** Raw argv, without the executable and script slots. */
  readonly argv: readonly string[]
  /** The environment: the token chain and `MINIMAL_AGENT_UPDATE_API`. */
  readonly env: Record<string, string | undefined>
  /** Progress and error sink. Default `process.stderr`. */
  readonly stderr?: { write(s: string): unknown }
}

/**
 * Run `minimal-agent update` when argv asks for it.
 *
 * @param io - argv, env, and stderr of the entrypoint
 * @returns the exit code, or undefined when argv is not an update run
 *   (`update --help` is help, not an update run)
 */
export async function maybeRunUpdate(io: UpdateDispatchIo): Promise<number | undefined> {
  const { argv, env, stderr = process.stderr } = io
  if (argv[0] !== "update") return undefined
  const { isUpdateRequest, runUpdateCommand } = await import("../commands/update.ts")
  if (!isUpdateRequest(argv)) return undefined
  return await runUpdateCommand(argv, env, { stdout: process.stdout, stderr })
}
