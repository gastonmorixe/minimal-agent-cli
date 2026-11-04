/**
 * The inputs each built-in command handler reads today (SPEC-HELP plan
 * M-13a). Pure: no env, no fs, no console, no exit.
 *
 * This is a copy, as data, of the ad hoc reads in the `switch` of
 * `src/startup/run-subcommand.ts`. The parity test
 * (`src/startup/dispatch/invocation-parity.test.ts`) uses it to freeze the
 * OLD handler inputs for every argv form. M-13a does not wire it into
 * `run-subcommand.ts` (no behavior change in this step). M-13c and M-13d
 * move the handlers onto it, then onto the typed parse.
 *
 * Exit paths of the switch that do not call a handler are kept as
 * `error` values with the same message text:
 * - `dump` with no sid,
 * - `auth-status prune <x>`,
 * - `auth-status refresh` with no credential.
 *
 * @module host/startup/subcommand-inputs
 */

import type { CommandName } from "../cli/command-plan.ts"
import type { PrintFormat } from "../cli/print-format.ts"

/** The option values of `parseCliOptions` that the switch reads. */
export interface SubcommandOptionInputs {
  readonly dumpArg?: string | undefined
  readonly dumpFormatArg: string
  readonly dumpPaths: boolean
  readonly sessionsQuery?: string | undefined
  readonly usagePeriod?: string | undefined
  readonly listModelsProvider?: string | undefined
  readonly printFormat: PrintFormat
  readonly hostModeId?: string | undefined
}

/** The sub-verb of `auth-status`, as the switch picks it. */
export type AuthStatusVerb = "status" | "prune" | "plan" | "refresh-all" | "refresh"

/** The handler input of one command, or the error the switch prints (exit 1). */
export type SubcommandInputs =
  | { readonly command: "dump"; readonly error: string }
  | {
      readonly command: "dump"
      readonly target: string
      readonly format: string
      readonly paths: boolean
    }
  | { readonly command: "sessions"; readonly query?: string | undefined }
  | { readonly command: "usage"; readonly period?: string | undefined }
  | { readonly command: "list-flags" }
  | { readonly command: "list-spinners" }
  | { readonly command: "list-providers" }
  | {
      readonly command: "list-models"
      readonly provider?: string | undefined
      readonly printFormat: PrintFormat
    }
  | { readonly command: "list-models-live"; readonly provider?: string | undefined }
  | { readonly command: "list-plugins"; readonly cliArgs: readonly string[] }
  | {
      readonly command: "login"
      readonly loginHint?: string | undefined
      readonly providerId?: string | undefined
      readonly authMethod?: string | undefined
      readonly credentialName?: string | undefined
    }
  | { readonly command: "logout"; readonly providerId?: string | undefined }
  | { readonly command: "auth-status"; readonly verb: "status"; readonly table: boolean }
  | { readonly command: "auth-status"; readonly verb: "prune"; readonly error: string }
  | {
      readonly command: "auth-status"
      readonly verb: "prune"
      readonly dryRun?: true | undefined
      readonly force?: true | undefined
      readonly table?: true | undefined
      readonly parallel: number
    }
  | {
      readonly command: "auth-status"
      readonly verb: "plan"
      readonly credential?: string | undefined
      readonly table?: true | undefined
      readonly all?: true | undefined
      readonly parallel: number
    }
  | { readonly command: "auth-status"; readonly verb: "refresh-all"; readonly parallel: number }
  | { readonly command: "auth-status"; readonly verb: "refresh"; readonly error: string }
  | {
      readonly command: "auth-status"
      readonly verb: "refresh"
      readonly credential: string
      readonly providerId?: string | undefined
    }
  | { readonly command: "host-mode"; readonly id?: string | undefined }
  | { readonly command: "run" }

/**
 * The inline-or-spaced flag reader of `src/startup/entry-args.ts`
 * (`makeReadFlagValue`). The spaced form takes the next token even when it
 * starts with `-`.
 */
export function readFlagValueIn(args: readonly string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`))
  if (eq) return eq.slice(name.length + 1)
  const idx = args.indexOf(name)
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]
  return undefined
}

/** The token after `flag` when it exists and does not start with `-`. */
function plainValueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  const next = idx === -1 ? undefined : args[idx + 1]
  return next && !next.startsWith("-") ? next : undefined
}

/** `--parallel`: base-10 integer, default 4 when missing or not finite. */
function parallelIn(args: readonly string[]): number {
  const raw = readFlagValueIn(args, "--parallel")
  const parsed = raw ? Number.parseInt(raw, 10) : 4
  return Number.isFinite(parsed) ? parsed : 4
}

/** The positionals the `auth-status` branches read (no flag value skip). */
function authPositionals(args: readonly string[], verb: string): string[] {
  return args.filter((a) => !a.startsWith("-") && a !== "auth-status" && a !== verb)
}

/** The `auth-status` inputs: the sub-verb is any token in `args`, in this order. */
function authStatusInputs(args: readonly string[]): SubcommandInputs {
  const table = args.includes("--table")
  if (args.includes("prune")) {
    const positionals = authPositionals(args, "prune")
    if (positionals.length > 0) {
      return {
        command: "auth-status",
        verb: "prune",
        error: `auth-status prune takes no credential argument (got "${positionals[0]}")`,
      }
    }
    return {
      command: "auth-status",
      verb: "prune",
      dryRun: args.includes("--dry-run") ? true : undefined,
      force: args.includes("--force") ? true : undefined,
      table: table ? true : undefined,
      parallel: parallelIn(args),
    }
  }
  if (args.includes("plan")) {
    const credential = authPositionals(args, "plan")[0] ?? readFlagValueIn(args, "--name")
    return {
      command: "auth-status",
      verb: "plan",
      credential: credential || undefined,
      table: table ? true : undefined,
      all: args.includes("--all") ? true : undefined,
      parallel: parallelIn(args),
    }
  }
  if (args.includes("refresh-all")) {
    return { command: "auth-status", verb: "refresh-all", parallel: parallelIn(args) }
  }
  if (args.includes("refresh")) {
    const nameValue = readFlagValueIn(args, "--name")
    const providerFlag = readFlagValueIn(args, "--provider")
    const positional = authPositionals(args, "refresh")[0]
    const credential = positional ?? nameValue ?? providerFlag
    if (!credential) {
      return {
        command: "auth-status",
        verb: "refresh",
        error: "auth-status refresh requires <credential>",
      }
    }
    const providerId =
      (providerFlag && positional && providerFlag !== positional) ||
      (!positional && providerFlag && nameValue)
        ? providerFlag
        : undefined
    return { command: "auth-status", verb: "refresh", credential, providerId }
  }
  return { command: "auth-status", verb: "status", table }
}

/**
 * The handler input of `command`, read from normalized `args` and the
 * `parseCliOptions` values, the same way as `runStartupSubcommand`.
 */
export function extractSubcommandInputs(
  command: CommandName,
  args: readonly string[],
  opts: SubcommandOptionInputs,
): SubcommandInputs {
  switch (command) {
    case "dump":
      return opts.dumpArg
        ? { command, target: opts.dumpArg, format: opts.dumpFormatArg, paths: opts.dumpPaths }
        : { command, error: "--dump requires <sid|last>" }
    case "sessions":
      return { command, query: opts.sessionsQuery }
    case "usage":
      return { command, period: opts.usagePeriod }
    case "list-flags":
    case "list-spinners":
    case "list-providers":
      return { command }
    case "list-models":
      return { command, provider: opts.listModelsProvider, printFormat: opts.printFormat }
    case "list-models-live":
      return { command, provider: opts.listModelsProvider }
    case "list-plugins":
      return { command, cliArgs: [...args] }
    case "login": {
      const emailFlag = args.includes("--email") ? "--email" : "--email-hint"
      return {
        command,
        loginHint: plainValueAfter(args, emailFlag),
        providerId: plainValueAfter(args, "--provider"),
        authMethod: readFlagValueIn(args, "--auth-method"),
        credentialName: plainValueAfter(args, "--name"),
      }
    }
    case "logout":
      return { command, providerId: plainValueAfter(args, "--provider") }
    case "auth-status":
      return authStatusInputs(args)
    case "host-mode":
      return { command, id: opts.hostModeId }
    default:
      return { command: "run" }
  }
}
