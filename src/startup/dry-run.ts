/**
 * `--dry-run` (env `MINIMAL_AGENT_DRY_RUN=1`): build the model request, print
 * it as JSON, and do not send it.
 *
 * The flag is an alias of `--enable-plugin dry-run`. The plugin
 * (`ma-dry-run-plugin`) has one `message.willSend` hook. It writes the
 * request and halts the send, so core throws `LifecycleSendDeniedError`
 * and the transport never runs.
 *
 * The CLI fails closed: when the flag is on and the plugin did not load,
 * the run stops before any model call. Without that check, a missing plugin
 * would let the request go out for real.
 *
 * Every function here is pure, except {@link startDryRun}, the boot glue
 * that `src/main.ts` calls. `src/startup/run-non-interactive.ts` calls
 * {@link isDryRunHalt}.
 *
 * @module host/startup/dry-run
 */

import { extractPromptFromArgs } from "../cli/extract-prompt.ts"
import type { OutputFormat } from "../cli/output-format.ts"

/** The manifest id of the dry-run plugin. */
export const DRY_RUN_PLUGIN_ID = "dry-run"

/** The env variable that turns dry run on (value `1`). */
export const DRY_RUN_ENV = "MINIMAL_AGENT_DRY_RUN"

/** The env variable the plugin reads for its output target. */
export const DRY_RUN_OUT_ENV = "MINIMAL_AGENT_DRY_RUN_OUT"

/** The stderr line for a clean dry-run end (exit 0). */
export const DRY_RUN_DONE_MESSAGE = "dry-run: request built and printed, not sent"

/** The error name core gives a send that a `message.willSend` hook halted. */
const SEND_DENIED_ERROR_NAME = "LifecycleSendDeniedError"

/** Env shape these helpers read. */
type Env = Readonly<Record<string, string | undefined>>

/** True when `--dry-run` is in `args` or `MINIMAL_AGENT_DRY_RUN=1`. */
export function isDryRun(args: readonly string[], env: Env): boolean {
  return args.includes("--dry-run") || env[DRY_RUN_ENV] === "1"
}

/** The plugin ids to force on for dry run: `["dry-run"]` or `[]`. */
export function dryRunEnableIds(args: readonly string[], env: Env): string[] {
  return isDryRun(args, env) ? [DRY_RUN_PLUGIN_ID] : []
}

/**
 * True when `value` is the dry-run plugin's own send halt: a
 * `LifecycleSendDeniedError` whose message is the plugin's halt reason.
 * A halt from another hook (a security or policy deny) does not match, so
 * it stays a real failure and the dry run does not claim a dump.
 */
function isSendDenied(value: unknown): boolean {
  return (
    value instanceof Error &&
    value.name === SEND_DENIED_ERROR_NAME &&
    value.message === DRY_RUN_DONE_MESSAGE
  )
}

/**
 * True when `err` is the dry-run plugin's send halt, or wraps it as its
 * direct `cause`. See {@link isSendDenied}.
 */
export function isDryRunHalt(err: unknown): boolean {
  if (isSendDenied(err)) return true
  return err instanceof Error && isSendDenied(err.cause)
}

/** Facts for {@link dryRunPreflightError}, known right after argv parse. */
export interface DryRunPreflightInput {
  /** Dry run is on. */
  readonly dryRun: boolean
  /** The planned command (`run`, `host-mode`, or a subcommand). */
  readonly command: string
  /** True when argv names a prompt (`-p`, a positional, or stdin `-`). */
  readonly hasPrompt: boolean
}

/**
 * The fatal line for a dry run that cannot work, or `undefined` when the
 * run may go on. Call it before any network step. Subcommands (for example
 * `auth-status prune --dry-run`) read their own `--dry-run`, so they pass.
 */
export function dryRunPreflightError(input: DryRunPreflightInput): string | undefined {
  if (!input.dryRun) return undefined
  if (input.command === "host-mode") return "fatal: --dry-run does not work with --host-mode"
  if (input.command !== "run") return undefined
  if (!input.hasPrompt) {
    return 'fatal: --dry-run needs a prompt (-p, a positional prompt, or stdin "-")'
  }
  return undefined
}

/**
 * The guard after plugin load. Returns the fatal line when dry run is on
 * and the dry-run plugin is not in `loadedIds` (manifest ids), else
 * `undefined`. The caller must stop before any model call.
 */
export function dryRunPluginGuard(
  dryRun: boolean,
  loadedIds: readonly string[],
): string | undefined {
  if (!dryRun || loadedIds.includes(DRY_RUN_PLUGIN_ID)) return undefined
  return "fatal: --dry-run needs the dry-run plugin (ma-dry-run-plugin), but it did not load. Nothing was sent."
}

/** Output formats where stdout carries only protocol lines. */
const PROTOCOL_FORMATS: ReadonlySet<OutputFormat> = new Set<OutputFormat>([
  "json",
  "stream-json",
  "open-responses",
])

/** Inputs for {@link startDryRun}: values `src/main.ts` already holds. */
export interface StartDryRunInput {
  /** Normalized argv. */
  readonly args: readonly string[]
  /** The mutable process env. Plugins read `process.env`. */
  readonly env: Record<string, string | undefined>
  /** The entry I/O. `stderr` defaults to `process.stderr`. */
  readonly io: { readonly stderr?: { readonly write: (chunk: string) => unknown } | undefined }
  /** Hard exit. */
  readonly exit: (code: number) => never
  /** The resolved output format. */
  readonly outputFormat: OutputFormat
  /** The planned command. */
  readonly commandPlan: { readonly command: string }
  /** The `--input-format open-responses` prompt, when there is one. */
  readonly orInput: { readonly prompt: string | undefined }
}

/** What {@link startDryRun} gives `src/main.ts`. */
export interface DryRunControl {
  /** Dry run is on. */
  readonly on: boolean
  /**
   * Fail closed after plugin load: exit 1 when dry run is on and the
   * dry-run plugin is not in `loader.loadedPluginIds()` (manifest ids).
   * Else return `loader` unchanged.
   */
  readonly checked: <L extends { loadedPluginIds(): string[] }>(loader: L) => L
}

/**
 * The boot side of `--dry-run`, called right after argv parse, before any
 * network step. It writes the fatal line and exits 1 on a bad use (no
 * prompt, `--host-mode`). On the `run` command with a JSON output format it
 * sets `MINIMAL_AGENT_DRY_RUN_OUT=stderr` (when unset) before plugins load.
 * Not pure: it reads and writes `input.env` and can exit.
 */
export function startDryRun(input: StartDryRunInput): DryRunControl {
  const { args, env, commandPlan } = input
  const on = isDryRun(args, env)
  const fail = (line: string): never => {
    ;(input.io.stderr ?? process.stderr).write(`${line}\n`)
    return input.exit(1)
  }
  const hasPrompt =
    input.orInput.prompt !== undefined || extractPromptFromArgs(args).kind !== "none"
  const fatal = dryRunPreflightError({ dryRun: on, command: commandPlan.command, hasPrompt })
  if (fatal !== undefined) fail(fatal)
  const out =
    commandPlan.command === "run" ? dryRunOutDefault(on, input.outputFormat, env) : undefined
  if (out !== undefined) env[DRY_RUN_OUT_ENV] = out
  return {
    on,
    checked: (loader) => {
      const guard = dryRunPluginGuard(on, loader.loadedPluginIds())
      if (guard !== undefined) fail(guard)
      return loader
    },
  }
}

/**
 * The `MINIMAL_AGENT_DRY_RUN_OUT` value the CLI must set, or `undefined`
 * for no change. On a protocol output format the plugin dump would break
 * the stdout JSON, so the dump goes to stderr. A value the user set wins.
 */
export function dryRunOutDefault(
  dryRun: boolean,
  outputFormat: OutputFormat,
  env: Env,
): string | undefined {
  if (!dryRun || !PROTOCOL_FORMATS.has(outputFormat)) return undefined
  if (env[DRY_RUN_OUT_ENV] !== undefined) return undefined
  return "stderr"
}
