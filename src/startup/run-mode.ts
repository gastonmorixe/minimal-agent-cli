/**
 * The run-mode fact for plugin handler contexts (`ctx.run`, SPEC §3e).
 *
 * The CLI knows how the process runs: the REPL route, the TTY state, the
 * output format, the host-mode command, and the sub-agent env. The core
 * plugin loader does not. So the CLI computes one {@link RunModeFact} and
 * gives the loader a getter (`PluginLoaderOptions.runMode`).
 *
 * Rule order:
 * 1. A sub-agent env (`MINIMAL_AGENT_SUBAGENT_ID` or `_SID`) gives
 *    `subagent`. It wins over all other modes, because workers run with
 *    `--prompt` and `stream-json`. Core enforces the same rule.
 * 2. The `host-mode` command gives `host`.
 * 3. The REPL route (no prompt source, no host mode) gives `repl`.
 * 4. `--output-format stream-json` gives `stream-json`.
 * 5. All other prompt runs give `one-shot`.
 *
 * `interactive` is true only for `repl` with stdin and stdout on a TTY.
 *
 * @module host/startup/run-mode
 */

import type { RunModeFact } from "@minimal-agent/core/plugin-api/types/plugin"

import { extractPromptFromArgs } from "../cli/extract-prompt.ts"
import { isHostModeRun, isReplRun } from "./resume-mode.ts"

/** The startup facts that decide the run mode. */
export interface RunModeInputs {
  /** True for the REPL route (`isReplRun`: no prompt, not host mode). */
  readonly replRoute: boolean
  /** True for a `--host-mode <id>` run (`isHostModeRun`). */
  readonly hostMode: boolean
  /** The `--output-format` value (`text`, `json`, `stream-json`). */
  readonly outputFormat: string | undefined
  /** `process.stdin.isTTY === true`. */
  readonly stdinTTY: boolean
  /** `process.stdout.isTTY === true`. */
  readonly stdoutTTY: boolean
  /** The process env, for the sub-agent check. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** True for `--dry-run`. */
  readonly dryRun: boolean
  /** The live session provider id, when known. */
  readonly providerId?: string | undefined
}

function envValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  return env[key]?.trim() || undefined
}

function subagentOf(
  env: Readonly<Record<string, string | undefined>>,
): RunModeFact["subagent"] | undefined {
  const id =
    envValue(env, "MINIMAL_AGENT_SUBAGENT_ID") ?? envValue(env, "MINIMAL_AGENT_SUBAGENT_SID")
  if (id === undefined) return undefined
  const role = envValue(env, "MINIMAL_AGENT_SUBAGENT_ROLE")
  const leadSid = envValue(env, "MINIMAL_AGENT_SUBAGENT_LEAD")
  return { id, ...(role ? { role } : {}), ...(leadSid ? { leadSid } : {}) }
}

/**
 * The run-mode fact for these startup facts. Pure: it reads only `inputs`.
 *
 * @param inputs - The startup facts.
 */
export function detectRunMode(inputs: RunModeInputs): RunModeFact {
  const extra = {
    ...(inputs.providerId ? { providerId: inputs.providerId } : {}),
    ...(inputs.dryRun ? { dryRun: true } : {}),
  }
  const subagent = subagentOf(inputs.env)
  if (subagent !== undefined) return { mode: "subagent", interactive: false, subagent, ...extra }
  if (inputs.hostMode) return { mode: "host", interactive: false, ...extra }
  if (inputs.replRoute) {
    return { mode: "repl", interactive: inputs.stdinTTY && inputs.stdoutTTY, ...extra }
  }
  if (inputs.outputFormat === "stream-json") {
    return { mode: "stream-json", interactive: false, ...extra }
  }
  return { mode: "one-shot", interactive: false, ...extra }
}

/** The name in the plan (IMPL-PLAN X1). Same function. */
export const computeRunModeFact = detectRunMode

/**
 * The getter for `PluginLoaderOptions.runMode`. The mode facts are fixed at
 * boot. The provider id is read on each call, so it follows a `/model`
 * switch (the live provider, not the boot provider).
 *
 * @param inputs - The startup facts, without the provider id.
 * @param liveProviderId - Gives the live provider id of the session.
 */
export function runModeGetter(
  inputs: Omit<RunModeInputs, "providerId">,
  liveProviderId: () => string | undefined,
): () => RunModeFact {
  return () => detectRunMode({ ...inputs, providerId: liveProviderId() })
}

/** The facts that `main.ts` has in scope when it builds the loader. */
export interface CliRunModeInput {
  readonly args: readonly string[]
  readonly commandPlan: { readonly command: string }
  /** The parsed options; only `outputFormat` is read. */
  readonly opts: { readonly outputFormat?: string | undefined }
  readonly env: Readonly<Record<string, string | undefined>>
  readonly dryRun: { readonly on: boolean }
  /** Default `process.stdin.isTTY === true`. */
  readonly stdinTTY?: boolean
  /** Default `process.stdout.isTTY === true`. */
  readonly stdoutTTY?: boolean
}

/**
 * The REPL-route decision and the `PluginLoaderOptions.runMode` getter, from
 * the values in `main.ts`. One call keeps `main.ts` under its line limit.
 *
 * @param input - The startup values.
 * @param live - Gives the live session provider id (rebound after boot).
 */
export function cliRunMode(
  input: CliRunModeInput,
  live: () => string | undefined,
): {
  replRoute: boolean
  get: () => RunModeFact
} {
  const replRoute = isReplRun(extractPromptFromArgs(input.args), input.commandPlan.command)
  const get = runModeGetter(
    {
      replRoute,
      hostMode: isHostModeRun(input.commandPlan.command),
      outputFormat: input.opts.outputFormat,
      stdinTTY: input.stdinTTY ?? process.stdin.isTTY === true,
      stdoutTTY: input.stdoutTTY ?? process.stdout.isTTY === true,
      env: input.env,
      dryRun: input.dryRun.on,
    },
    live,
  )
  return { replRoute, get }
}
