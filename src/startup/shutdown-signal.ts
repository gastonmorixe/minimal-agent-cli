/**
 * The CLI shutdown signal for plugin side calls.
 *
 * `main()` makes one {@link CliShutdown} per run. Its `signal` goes to the
 * plugin loader as `hostOptions.shutdownSignal`, so a plugin side call
 * (`host.llm.request`, for example a session title call) in flight aborts
 * when the CLI ends. The signal aborts on the two existing shutdown paths of
 * `main()`, and this module adds no signal handler:
 *
 * - the hard exit (`exit`): the `--help`, argv error and REPL-end paths;
 * - the end of `main()` (`end`): its `finally`, so a pending side call does
 *   not keep the process alive after a one-shot or host-mode run.
 *
 * @module startup/shutdown-signal
 */

/** The shutdown state of one `main()` run. */
export interface CliShutdown {
  /** Aborts at shutdown. Pass it to `PluginLoader.load` as `hostOptions.shutdownSignal`. */
  readonly signal: AbortSignal
  /** Aborts {@link CliShutdown.signal}, then calls the base exit. */
  readonly exit: (code: number) => never
  /** True after {@link CliShutdown.exit} was called. */
  readonly exitRequested: () => boolean
  /** Aborts {@link CliShutdown.signal}. Safe to call more than one time. */
  readonly end: (reason?: string) => void
}

/**
 * Make the shutdown state for one `main()` run.
 *
 * @param baseExit - The hard exit (`process.exit` or a test stub).
 */
export function cliShutdown(baseExit: (code: number) => never): CliShutdown {
  const controller = new AbortController()
  let requested = false
  const end = (reason = "cli-shutdown"): void => {
    if (!controller.signal.aborted) controller.abort(new Error(reason))
  }
  return {
    signal: controller.signal,
    exit: (code: number): never => {
      requested = true
      end("cli-exit")
      return baseExit(code)
    },
    exitRequested: () => requested,
    end,
  }
}
