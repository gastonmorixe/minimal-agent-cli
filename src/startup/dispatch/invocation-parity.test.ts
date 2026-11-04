/**
 * Invocation parity (SPEC-HELP plan M-13a, M-13b, part 4).
 *
 * Two checks on every frozen row of `invocation-parity.table.ts`:
 *
 * 1. OLD: the current planner (`normalizeArgs` then `parseCliOptions` then
 *    `planCommand` then `extractSubcommandInputs`) still gives the frozen
 *    command and handler input. This pins today's behavior.
 * 2. NEW: the pure route resolver (`resolveCommandRoute`) gives the same
 *    command, and for `auth-status` the same sub-verb. Only the rows in
 *    {@link INTENDED_CHANGES} differ, each one by a lead decision.
 *
 * @module host/startup/dispatch/invocation-parity.test
 */

import { describe, expect, test } from "bun:test"

import type { UserConfig } from "@minimal-agent/core/host/config"

import { normalizeArgs } from "../../cli/cli-args.ts"
import { type CommandName, planCommand } from "../../cli/command-plan.ts"
import { parseCliOptions } from "../../cli/parse-argv.ts"
import { builtinRegistry } from "../../cli/registry/index.ts"
import { COMMAND_FORM_ORDER, resolveCommandRoute, wordFormIndex } from "../../cli/registry/route.ts"
import { parseFormatterCommand } from "../../ui/formatter/formatter.ts"
import { extractSubcommandInputs } from "../subcommand-inputs.ts"
import { PARITY_ROWS } from "./invocation-parity.table.ts"

/** The command id and the `auth-status` sub-verb of one routing result. */
interface Selected {
  readonly command: CommandName
  readonly verb?: string
}

/**
 * Rows where the new resolver is meant to differ from the old planner.
 * Lead decision 5 (research/spec-help/IMPL-PROGRESS.md, "Wave 5 plan (A42)
 * done"): a flag value is not a verb. The old switch reads the sub-verb with
 * `args.includes(...)`, so the value of `--name` or `--parallel` is read as
 * a sub-verb. The new walk skips flag values (registry arity). Key: argv
 * joined by a space.
 */
const INTENDED_CHANGES: ReadonlyMap<string, Selected> = new Map([
  // Old: `auth-status refresh` with credential "refresh". New: bare
  // `auth-status`, and `--name` takes "refresh" as its value.
  ["auth-status --name refresh", { command: "auth-status", verb: "status" }],
  ["auth-status --name refresh --debug", { command: "auth-status", verb: "status" }],
  // Old: `auth-status plan`. New: bare `auth-status`, and `--parallel`
  // takes "plan" as its value.
  ["auth-status --parallel plan", { command: "auth-status", verb: "status" }],
  ["auth-status --parallel plan --debug", { command: "auth-status", verb: "status" }],
])

function oldSelected(argv: readonly string[]): Selected {
  const args = normalizeArgs([...argv])
  const opts = parseCliOptions(args, {} as UserConfig, {}, parseFormatterCommand)
  const plan = planCommand({
    dumpArg: opts.dumpArg,
    wantListSessions: opts.wantListSessions,
    wantUsage: opts.wantUsage,
    wantListFlags: opts.wantListFlags,
    wantListSpinners: opts.wantListSpinners,
    wantListModels: opts.wantListModels,
    wantListModelsLive: opts.wantListModelsLive,
    wantListProviders: opts.wantListProviders,
    wantListPlugins: opts.wantListPlugins,
    wantLogin: opts.wantLogin,
    wantLogout: opts.wantLogout,
    wantAuthStatus: opts.wantAuthStatus,
    wantHostMode: opts.hostModeId !== undefined,
  })
  const inputs = extractSubcommandInputs(plan.command, args, opts)
  return "verb" in inputs ? { command: plan.command, verb: inputs.verb } : { command: plan.command }
}

/** The old command id of a new route. Test-only map (plan 2.2). */
function newSelected(argv: readonly string[]): Selected {
  const route = resolveCommandRoute(argv, builtinRegistry())
  if (route === undefined) return { command: "run" }
  if (route.kind === "host-mode") return { command: "host-mode" }
  const form = COMMAND_FORM_ORDER[wordFormIndex(route.path)]
  if (form === undefined) throw new Error(`no command form for path ${route.path.join(" ")}`)
  const command = form.flag as CommandName
  if (command !== "auth-status") return { command }
  return { command, verb: route.path[1] ?? "status" }
}

function frozenSelected(row: (typeof PARITY_ROWS)[number]): Selected {
  return "verb" in row.old
    ? { command: row.old.command, verb: row.old.verb }
    : { command: row.old.command }
}

describe("invocation parity table", () => {
  test("holds every plan part 4 form, as is and with --debug", () => {
    expect(PARITY_ROWS.length).toBe(266)
    const keys = new Set(PARITY_ROWS.map((r) => r.argv.join(" ")))
    expect(keys.size).toBe(PARITY_ROWS.length)
  })

  test("covers every old command id", () => {
    const seen = new Set(PARITY_ROWS.map((r) => r.old.command))
    const all: CommandName[] = [
      "dump",
      "sessions",
      "usage",
      "list-flags",
      "list-spinners",
      "list-models",
      "list-models-live",
      "list-providers",
      "list-plugins",
      "login",
      "logout",
      "auth-status",
      "host-mode",
      "run",
    ]
    expect([...seen].sort()).toEqual([...all].sort())
  })

  test("every intended change is a row", () => {
    const keys = new Set(PARITY_ROWS.map((r) => r.argv.join(" ")))
    for (const key of INTENDED_CHANGES.keys()) expect(keys.has(key)).toBe(true)
  })
})

describe("OLD planner gives the frozen rows (M-13a)", () => {
  for (const row of PARITY_ROWS) {
    test(JSON.stringify(row.argv), () => {
      const args = normalizeArgs([...row.argv])
      const opts = parseCliOptions(args, {} as UserConfig, {}, parseFormatterCommand)
      const { command } = planCommand({
        dumpArg: opts.dumpArg,
        wantListSessions: opts.wantListSessions,
        wantUsage: opts.wantUsage,
        wantListFlags: opts.wantListFlags,
        wantListSpinners: opts.wantListSpinners,
        wantListModels: opts.wantListModels,
        wantListModelsLive: opts.wantListModelsLive,
        wantListProviders: opts.wantListProviders,
        wantListPlugins: opts.wantListPlugins,
        wantLogin: opts.wantLogin,
        wantLogout: opts.wantLogout,
        wantAuthStatus: opts.wantAuthStatus,
        wantHostMode: opts.hostModeId !== undefined,
      })
      expect(extractSubcommandInputs(command, args, opts)).toEqual(row.old)
    })
  }
})

describe("NEW route resolver gives the old command (M-13b)", () => {
  for (const row of PARITY_ROWS) {
    const key = row.argv.join(" ")
    const intended = INTENDED_CHANGES.get(key)
    test(`${JSON.stringify(row.argv)}${intended ? " (intended change)" : ""}`, () => {
      const old = frozenSelected(row)
      expect(oldSelected(row.argv)).toEqual(old)
      if (intended !== undefined) {
        expect(old).not.toEqual(intended)
        expect(newSelected(row.argv)).toEqual(intended)
        return
      }
      expect(newSelected(row.argv)).toEqual(old)
    })
  }

  test("only the intended rows differ", () => {
    const differ = PARITY_ROWS.filter((row) => {
      const old = frozenSelected(row)
      const now = newSelected(row.argv)
      return old.command !== now.command || old.verb !== now.verb
    }).map((row) => row.argv.join(" "))
    expect(differ).toEqual([...INTENDED_CHANGES.keys()])
  })
})
