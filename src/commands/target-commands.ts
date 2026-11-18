/**
 * Host-owned slash commands that change the live target of the session at
 * any time, also during a turn or a quota wait: `/provider` (alias
 * `/credential-name`), `/model`, and `/effort`.
 *
 * The target is a chain: the credential gives the provider, the provider
 * gives the models, the model gives the effort levels. So each command
 * offers and accepts only the values that are valid for the value on its
 * left, and a change on the left can reset a value on its right.
 *
 * Each command makes ONE checked call into the core (`switchTarget`,
 * `setModel` or `setEffort`). The core does the rest (`sdk/target-change.ts`):
 * it ends a retry or quota wait, builds the system prompt again, and discards
 * the old thinking. A throw from the core changes nothing.
 *
 * Not plugins: the handlers need the live agent. A command with no argument
 * lists the valid values. It opens no picker, so it works during a turn.
 *
 * @module host/commands/target-commands
 */

import type { AuthResult } from "@minimal-agent/core/host/auth"
import type { CredentialedProvider } from "@minimal-agent/core/host/auth-strategies"
import { findModelForProvider, listRegisteredModels } from "@minimal-agent/core/host/model-registry"
import { findProviderPlugin } from "@minimal-agent/core/host/provider-plugin"
import type {
  CommandContext,
  CommandResult,
  ResolvedCommand,
} from "@minimal-agent/core/plugin-api/types/plugin"
import type { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import { normalizeModelForAPI } from "@minimal-agent/core/sdk/transport-types"

import { errorText } from "../startup/core-text.ts"

/** The part of the live core the commands use. */
export type TargetCore = Pick<AgentCore, "getTarget" | "switchTarget" | "setModel" | "setEffort">

/** What the commands need from the host. Injectable, so tests read no auth store. */
export interface TargetCommandDeps {
  /** The live core of the session. */
  core(): TargetCore
  /** The stored credentials this host can switch to. */
  discover(): readonly CredentialedProvider[]
  /** Resolves the auth for one provider + credential + model. */
  resolveAuth(providerId: string, modelId: string, credentialName?: string): Promise<AuthResult>
}

/** One provider + credential pair the session can switch to. */
export interface TargetRow {
  readonly providerId: string
  readonly credentialName: string | undefined
  /** `<providerId>:<credentialName>`, or the provider id when the credential has no name. */
  readonly token: string
}

const tokenOf = (providerId: string, credentialName?: string): string =>
  credentialName ? `${providerId}:${credentialName}` : providerId

/** One row for each usable provider + credential pair, with no duplicates. */
function targetRows(deps: TargetCommandDeps): TargetRow[] {
  const rows = new Map<string, TargetRow>()
  for (const e of deps.discover()) {
    if (e.credentialInfo?.usable === false) continue
    const token = tokenOf(e.providerId, e.credentialName)
    if (!rows.has(token)) {
      rows.set(token, { providerId: e.providerId, credentialName: e.credentialName, token })
    }
  }
  return [...rows.values()]
}

/** Model ids that `providerId` registers, in registration order. */
function modelsOf(providerId: string | undefined): string[] {
  return listRegisteredModels()
    .filter((m) => providerId === undefined || m.providerId === providerId)
    .map((m) => m.id)
}

/** Effort levels of `model` for `providerId`. Empty when the model has none. */
function effortLevelsOf(model: string, providerId: string | undefined): readonly string[] {
  if (providerId === undefined) return []
  return (
    findModelForProvider(normalizeModelForAPI(model), providerId)?.capabilities.effort.levels ?? []
  )
}

const notice = (lines: string[]): CommandResult => ({ kind: "notice", lines })
const failure = (message: string): CommandResult => ({ kind: "error", message })

/** `anthropic · work`, or the provider name alone. */
function describeTarget(providerId: string | undefined, credentialName?: string): string {
  if (providerId === undefined) return "(no provider)"
  const provider = findProviderPlugin(providerId)?.displayName ?? providerId
  return credentialName ? `${provider} · ${credentialName}` : provider
}

/** The lines that show the target after a change, with what the change reset. */
function changedLines(core: TargetCore, before: ReturnType<TargetCore["getTarget"]>): string[] {
  const now = core.getTarget()
  const lines = [
    `✓ ${describeTarget(now.providerId, now.credentialName)} · ${now.model} · effort ${now.effort ?? "default"}`,
  ]
  if (now.model !== before.model && before.providerId !== now.providerId) {
    lines.push(`  model changed from "${before.model}" (the new provider does not have it)`)
  }
  if (before.effort !== undefined && now.effort === undefined) {
    lines.push(`  effort reset from "${before.effort}" (the new model does not have it)`)
  }
  lines.push("  Applies from the next model request. The prompt cache starts again.")
  return lines
}

/**
 * Remove one pair of matching quotes (`"` or `'`) around `text`. A user can
 * quote a credential name that has spaces, as in a shell.
 */
export function unquote(text: string): string {
  const t = text.trim()
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0]) {
    return t.slice(1, -1).trim()
  }
  return t
}

/** The text of a credential in a list: quoted when it has a space, so a copy works as an argument. */
const shown = (token: string): string => (/\s/.test(token) ? `"${token}"` : token)

/**
 * Split the argument of `/provider` into the credential and the model.
 *
 * A credential name can have spaces ("Anthropic Plan (OAuth)"), and a model
 * id has none. So the credential is the LONGEST start of the argument that
 * names a row; the rest is the model. A quoted credential (`"..."` or
 * `'...'`) is the text in the quotes. With no row that matches, the whole
 * argument is the credential, so the error names what the user typed.
 */
export function splitProviderArg(
  rows: readonly TargetRow[],
  argv: string,
): { token: string; model: string | undefined } {
  const text = argv.trim()
  const quote = text[0] === '"' || text[0] === "'" ? text[0] : undefined
  if (quote !== undefined) {
    const end = text.indexOf(quote, 1)
    if (end > 0) {
      const rest = text.slice(end + 1).trim()
      return { token: text.slice(1, end).trim(), model: rest ? unquote(rest) : undefined }
    }
  }
  // Each place where a word ends, longest first.
  const ends: number[] = []
  for (const m of text.matchAll(/\S+/g)) ends.push((m.index ?? 0) + m[0].length)
  for (let i = ends.length - 1; i >= 0; i--) {
    const token = text.slice(0, ends[i])
    if (typeof findRow(rows, token) !== "string") {
      const rest = text.slice(ends[i]).trim()
      return { token, model: rest ? unquote(rest) : undefined }
    }
  }
  return { token: text, model: undefined }
}

/**
 * Find the row for `token`: the full `<provider>:<credential>` form, or a
 * bare credential name or provider id when exactly one row has it.
 */
function findRow(rows: readonly TargetRow[], token: string): TargetRow | string {
  const exact = rows.find((r) => r.token === token)
  if (exact) return exact
  const loose = rows.filter((r) => r.credentialName === token || r.providerId === token)
  if (loose.length === 1 && loose[0]) return loose[0]
  if (loose.length > 1) {
    return `"${token}" names more than one credential. Use one of: ${loose.map((r) => shown(r.token)).join(", ")}`
  }
  return `unknown credential "${token}". Available: ${rows.map((r) => shown(r.token)).join(", ") || "(none)"}`
}

/** `/provider [credential] [model]`: the credential gives the provider. */
async function runProvider(deps: TargetCommandDeps, argv: string): Promise<CommandResult> {
  const core = deps.core()
  const before = core.getTarget()
  const rows = targetRows(deps)
  if (!argv.trim()) {
    const live = tokenOf(before.providerId ?? "", before.credentialName)
    return notice([
      "Credentials (the credential gives the provider):",
      ...rows.map((r) => `  ${r.token === live ? "●" : "○"} ${shown(r.token)}`),
      "Use: /provider <credential> [model]",
    ])
  }
  const { token, model } = splitProviderArg(rows, argv)
  const row = findRow(rows, token)
  if (typeof row === "string") return failure(row)

  // The model: the named one, else the current one when the new provider has
  // it. Else the caller must choose: a provider change never picks a model.
  const offered = modelsOf(row.providerId)
  const keeps = findModelForProvider(normalizeModelForAPI(before.model), row.providerId)
  const next = model ?? (keeps ? before.model : undefined)
  if (next === undefined) {
    return failure(
      `"${before.model}" is not a model of ${describeTarget(row.providerId)}. ` +
        `Use: /provider ${shown(row.token)} <model>. Models: ${offered.join(", ") || "(none)"}`,
    )
  }
  try {
    const auth = await deps.resolveAuth(
      row.providerId,
      normalizeModelForAPI(next),
      row.credentialName,
    )
    core.switchTarget(
      {
        providerId: row.providerId,
        ...(row.credentialName !== undefined ? { credentialName: row.credentialName } : {}),
        model: next,
        auth,
      },
      { quiet: true },
    )
  } catch (e) {
    return failure(`cannot switch to ${shown(row.token)}: ${errorText(e)}`)
  }
  return notice(changedLines(core, before))
}

/** `/model [model-id]`: a model of the live provider. */
function runModel(deps: TargetCommandDeps, argv: string): CommandResult {
  const core = deps.core()
  const before = core.getTarget()
  const model = unquote(argv)
  const offered = modelsOf(before.providerId)
  if (!model) {
    return notice([
      `Models of ${describeTarget(before.providerId)}:`,
      ...offered.map((m) => `  ${m === before.model ? "●" : "○"} ${m}`),
      "Use: /model <model-id>",
    ])
  }
  try {
    core.setModel(model)
  } catch (e) {
    return failure(`cannot set model "${model}": ${errorText(e)}. Models: ${offered.join(", ")}`)
  }
  return notice(changedLines(core, before))
}

/** `/effort [level|default]`: a level of the live model. */
function runEffort(deps: TargetCommandDeps, argv: string): CommandResult {
  const core = deps.core()
  const before = core.getTarget()
  const level = unquote(argv)
  const levels = effortLevelsOf(before.model, before.providerId)
  if (!level) {
    if (levels.length === 0) return notice([`"${before.model}" has no effort levels.`])
    return notice([
      `Effort levels of ${before.model}:`,
      ...levels.map((l) => `  ${l === before.effort ? "●" : "○"} ${l}`),
      `  ${before.effort === undefined ? "●" : "○"} default`,
      "Use: /effort <level|default>",
    ])
  }
  try {
    core.setEffort(level === "default" ? undefined : level)
  } catch (e) {
    return failure(
      `cannot set effort "${level}": ${errorText(e)}. Levels: ${[...levels, "default"].join(", ")}`,
    )
  }
  return notice(changedLines(core, before))
}

function command(
  name: string,
  summary: string,
  argHint: string,
  run: (argv: string) => CommandResult | Promise<CommandResult>,
): ResolvedCommand {
  return {
    pluginId: "host",
    packageDir: "",
    entryAbsolute: "",
    spec: { name, summary, argHint, handler: { type: "module", path: "", export: "default" } },
    invoke: async (ctx: CommandContext) => run(ctx.argv ?? ""),
  }
}

/** Build the target commands bound to `deps`. `/credential-name` is `/provider`. */
export function createTargetHostCommands(deps: TargetCommandDeps): ResolvedCommand[] {
  const provider = "Switch the credential and provider, now or during a turn"
  return [
    command("provider", provider, "[credential] [model]", (argv) => runProvider(deps, argv)),
    command("credential-name", provider, "[credential] [model]", (argv) => runProvider(deps, argv)),
    command("model", "Switch the model of the live provider", "[model-id]", (argv) =>
      runModel(deps, argv),
    ),
    command("effort", "Switch the reasoning effort of the live model", "[level|default]", (argv) =>
      runEffort(deps, argv),
    ),
  ]
}

/**
 * Register the target commands on the loader. No-op when `loader` is null
 * (plugins disabled). Returns the number of commands registered.
 */
export function registerTargetHostCommands(
  loader: { registerHostCommand(cmd: ResolvedCommand): boolean } | null | undefined,
  deps: TargetCommandDeps,
): number {
  if (!loader) return 0
  return createTargetHostCommands(deps).filter((cmd) => loader.registerHostCommand(cmd)).length
}
