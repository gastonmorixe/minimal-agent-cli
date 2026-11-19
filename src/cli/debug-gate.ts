/**
 * The one rule for the `--debug` and `--verbose` gates.
 *
 * - Debug: `--debug` on the command line, or `DEBUG=1`. `DEBUG` must be
 *   exactly `1`: other values (`true`, `*`, `yes`) do not turn debug on.
 *   `parseCliOptions` uses this rule to make `opts.debug`; the startup sinks
 *   and the REPL request dump get that parsed flag.
 * - Verbose: any non-empty `VERBOSE` (`--verbose` sets `VERBOSE=1` at entry).
 *   The request dump reads it at each request, from an injectable env.
 *
 * @module cli/debug-gate
 */

/** The environment slice that the gates read. */
export type DebugGateEnv = Readonly<Record<string, string | undefined>>

/**
 * True when the user asked for debug output: `--debug`, or `DEBUG=1`.
 *
 * @param args - The process arguments.
 * @param env - The environment.
 * @returns The debug flag.
 */
export function isDebugRequested(args: readonly string[], env: DebugGateEnv): boolean {
  return args.includes("--debug") || env.DEBUG === "1"
}

/**
 * True when verbose debug output is on: `VERBOSE` is set and not empty.
 *
 * @param env - The environment. Default: `process.env`.
 * @returns The verbose flag.
 */
export function isVerboseEnv(env: DebugGateEnv = process.env): boolean {
  return (env.VERBOSE ?? "") !== ""
}
