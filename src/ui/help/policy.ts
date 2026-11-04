/**
 * Width and color policy for help output (SPEC-HELP R-28, R-29).
 *
 * Pure: the caller passes the env, the TTY state, the known column counts,
 * and the parsed flags. Nothing here reads `process`, so tests do not need a
 * real terminal.
 *
 * Width order (R-28): explicit option, the output stream's `columns`, the
 * `COLUMNS` env var, `process.stdout.columns`, else 80.
 *
 * Color (R-29): no SGR when `NO_COLOR` is set and not empty (any value, per
 * https://no-color.org/), when the stream is not a TTY, when `TERM=dumb`, or
 * when `--no-color` is passed. The decision is per stream: pass the TTY state
 * of the stream the text goes to (stdout for help, stderr for help errors).
 *
 * @module ui/help/policy
 */

/** Width used when no source gives a column count. */
export const DEFAULT_HELP_WIDTH = 80

/** Smallest width the renderer lays out. Smaller values are raised to this. */
export const MIN_HELP_WIDTH = 20

/** Column counts known to the caller, in priority order. */
export interface HelpColumns {
  /** Explicit width option (for example a test or a `columns` dependency). */
  readonly explicit?: number
  /** `columns` of the stream the help goes to. */
  readonly output?: number
  /** `process.stdout.columns`. */
  readonly stdout?: number
}

/** Inputs of {@link resolveHelpPolicy}. */
export interface HelpPolicyInput {
  /** Process environment (reads `COLUMNS`, `NO_COLOR`, `TERM`). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** TTY state of the stream the help goes to. `undefined` means not a TTY. */
  readonly isTTY: boolean | undefined
  /** Known column counts. */
  readonly columns?: HelpColumns
  /** Parsed CLI flags that change the policy. */
  readonly flags?: { readonly noColor?: boolean }
}

/** The decision for one stream. */
export interface HelpPolicy {
  /** Wrap width in terminal cells. */
  readonly width: number
  /** True when SGR sequences may be written. */
  readonly color: boolean
}

/** Resolve width and color for one output stream. */
export function resolveHelpPolicy(input: HelpPolicyInput): HelpPolicy {
  return {
    width: resolveHelpWidth(input.env, input.columns),
    color: resolveHelpColor(input.env, input.isTTY, input.flags?.noColor === true),
  }
}

/** Width from the first valid source in R-28 order, raised to {@link MIN_HELP_WIDTH}. */
export function resolveHelpWidth(
  env: Readonly<Record<string, string | undefined>>,
  columns: HelpColumns = {},
): number {
  const raw =
    positive(columns.explicit) ??
    positive(columns.output) ??
    positive(parseColumnsEnv(env.COLUMNS)) ??
    positive(columns.stdout) ??
    DEFAULT_HELP_WIDTH
  return Math.max(MIN_HELP_WIDTH, raw)
}

/** True when color is allowed on a stream with this TTY state. */
export function resolveHelpColor(
  env: Readonly<Record<string, string | undefined>>,
  isTTY: boolean | undefined,
  noColorFlag = false,
): boolean {
  if (noColorFlag) return false
  // no-color.org: "present and not an empty string (regardless of its value)".
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false
  if (env.TERM === "dumb") return false
  return isTTY === true
}

function parseColumnsEnv(value: string | undefined): number | undefined {
  if (value === undefined || !/^\s*\d+\s*$/u.test(value)) return undefined
  return Number.parseInt(value, 10)
}

function positive(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}
