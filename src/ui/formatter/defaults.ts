/**
 * Default args the CLI adds to a known formatter.
 *
 * mdstream renders tables at natural width unless `--table-fit` is on, so a
 * wide table overflows the terminal. The CLI already exports `COLUMNS` to the
 * formatter (see `formatterEnv` in `formatter.ts`), so turning table fit on
 * is enough to make tables fit.
 *
 * The default applies only when the formatter is mdstream and the user did
 * not choose a table-fit setting anywhere: not in the formatter command
 * (`--formatter "mdstream --table-fit=false"`), not in the extra args
 * (`--formatter-args`, `MINIMAL_AGENT_FORMATTER_ARGS`, config
 * `formatterArgs`), and not in mdstream's own `MDSTREAM_TABLE_FIT` env.
 */

/** Result of {@link applyFormatterDefaults}. */
export interface FormatterDefaultsResult {
  /** The full argv to spawn: command, user extra args, then defaults. */
  readonly cmd: string[]
  /** The args this function added on its own (empty when none). */
  readonly defaulted: string[]
}

/** The mdstream flag that caps tables at the terminal width. */
const TABLE_FIT_FLAG = "--table-fit"

/** mdstream's own env switch for the same setting. */
const TABLE_FIT_ENV = "MDSTREAM_TABLE_FIT"

/**
 * True when `exe` names the mdstream binary, by basename. Accepts a bare
 * `mdstream`, an absolute path, and a Windows `.exe` suffix.
 *
 * @param exe - argv[0] of the formatter command.
 * @returns Whether the executable is mdstream.
 */
export function isMdstream(exe: string | undefined): boolean {
  if (!exe) return false
  const base = exe.split(/[\\/]/).pop() ?? ""
  return base.replace(/\.exe$/i, "") === "mdstream"
}

/**
 * True when any arg sets table fit, in either `--table-fit` or
 * `--table-fit=<value>` form.
 *
 * @param args - argv entries to scan.
 * @returns Whether the user already chose a table-fit setting.
 */
function hasTableFitArg(args: readonly string[]): boolean {
  return args.some((a) => a === TABLE_FIT_FLAG || a.startsWith(`${TABLE_FIT_FLAG}=`))
}

/**
 * Build the formatter argv: the resolved command, then the user's extra
 * args, then any CLI defaults the user did not override.
 *
 * @param cmd - Resolved formatter command (argv[0] is the executable).
 * @param extraArgs - User extra args from flag, env, or config.
 * @param env - Environment to check for formatter-native settings.
 * @returns The final argv and the list of args added by default.
 */
export function applyFormatterDefaults(
  cmd: readonly string[],
  extraArgs: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): FormatterDefaultsResult {
  const userArgv = [...cmd, ...extraArgs]
  const defaulted: string[] = []
  if (
    isMdstream(cmd[0]) &&
    !hasTableFitArg(userArgv.slice(1)) &&
    env[TABLE_FIT_ENV] === undefined
  ) {
    defaulted.push(TABLE_FIT_FLAG)
  }
  return { cmd: [...userArgv, ...defaulted], defaulted }
}
