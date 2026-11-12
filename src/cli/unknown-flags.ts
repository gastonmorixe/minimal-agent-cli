/**
 * Unknown flag detection (plan task 2.3).
 *
 * Before this check, any unknown flag fell through to a normal run and
 * booted a session (`--bogus` printed the startup tree, then failed at the
 * credentials check). Now startup stops with exit 2.
 *
 * Pure: no env, no fs, no console. Reads raw argv (before `normalizeArgs`)
 * and the registry.
 *
 * Known flags:
 * - every long form (name, aliases, `--no-<name>`) and short form of every
 *   FlagSpec in the built-in registry, global and per command, hidden ones
 *   included. The check is not per command path: a command flag is known
 *   everywhere. The per-path parse stays with the existing parsers.
 * - `extraKnown`: the caller adds the flags that plugins declare in their
 *   manifest `cli` blocks, so a plugin command flag is never rejected.
 *
 * Skipped tokens:
 * - everything after `--host-mode <id>`: those are the host mode's own
 *   args (`ctx.argv`, for example ACP `--approval`).
 * - everything after a lone `--`.
 * - the value of a flag with a required value (`--prompt --x` is a prompt),
 *   and the value of an optional-value flag when it does not look like a
 *   flag. `--flag=value` carries its value in the same token.
 * - a lone `-` (stdin), negative numbers (`-1`), and any token with a
 *   space in its name part (prompt text such as `"- list files"`).
 *
 * @module cli/unknown-flags
 */

import type { CommandSpec, FlagSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { specArity } from "./registry/arity.ts"
import { allFlags, longForms } from "./registry/index.ts"
import type { BuiltinRegistry } from "./registry/types.ts"

/** Value mode of a known flag token. */
type Arity = "none" | "required" | "optional"

/** Known flag token to arity. A token with two arities keeps the wider one. */
function knownTable(reg: BuiltinRegistry, extra: readonly FlagSpec[]): Map<string, Arity> {
  const rank: Record<Arity, number> = { none: 0, optional: 1, required: 2 }
  const table = new Map<string, Arity>()
  const put = (token: string, arity: Arity): void => {
    const old = table.get(token)
    if (old === undefined || rank[arity] > rank[old]) table.set(token, arity)
  }
  const add = (spec: FlagSpec): void => {
    const arity = specArity(spec)
    for (const long of longForms(spec)) put(long, long === `--no-${spec.name}` ? "none" : arity)
    if (spec.short !== undefined) put(`-${spec.short}`, arity)
  }
  for (const { spec } of allFlags(reg)) add(spec)
  for (const spec of extra) add(spec)
  return table
}

/** Every FlagSpec in a list of command specs, at every depth. */
export function commandFlags(commands: readonly CommandSpec[]): FlagSpec[] {
  const out: FlagSpec[] = []
  const walk = (node: CommandSpec): void => {
    for (const spec of node.flags ?? []) out.push(spec)
    for (const child of node.commands ?? []) walk(child)
  }
  for (const command of commands) walk(command)
  return out
}

/**
 * A flag-shaped token: `-x`, `-abc`, `--name`, `--name=value`. A lone `-`,
 * a number (`-1`), and text with a space before any `=` (`"- list files"`,
 * a prompt) are not flags.
 */
const FLAG_SHAPE_RE = /^(?:-[A-Za-z][A-Za-z0-9]*|--[A-Za-z0-9][A-Za-z0-9_.-]*)(?:=.*)?$/su

/** True when `token` looks like a flag. See {@link FLAG_SHAPE_RE}. */
function isFlagLike(token: string): boolean {
  return FLAG_SHAPE_RE.test(token)
}

/** One flag token of argv: its name (the part before `=`) and whether the registry knows it. */
export interface FlagToken {
  readonly name: string
  readonly known: boolean
}

/**
 * The flag tokens of `raw`, in order, with flag values, host-mode args, and
 * the args after `--` skipped. See the module doc for the rules.
 *
 * @param raw - Raw argv, before `normalizeArgs`.
 * @param reg - The built-in registry.
 * @param extra - Flags known on top of the registry (plugin command flags).
 */
export function flagTokens(
  raw: readonly string[],
  reg: BuiltinRegistry,
  extra: readonly FlagSpec[] = [],
): FlagToken[] {
  const known = knownTable(reg, extra)
  const out: FlagToken[] = []
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i] ?? ""
    if (token === "--") break
    // Everything after `--host-mode <id>` belongs to the host mode.
    if (token === "--host-mode" || token.startsWith("--host-mode=")) {
      out.push({ name: "--host-mode", known: true })
      break
    }
    if (!isFlagLike(token)) continue
    const eq = token.indexOf("=")
    const name = eq === -1 ? token : token.slice(0, eq)
    const arity = known.get(name)
    out.push({ name, known: arity !== undefined })
    if (arity === undefined || eq !== -1) continue
    const next = raw[i + 1]
    if (next === undefined) continue
    if (arity === "required") i++
    else if (arity === "optional" && !isFlagLike(next)) i++
  }
  return out
}

/**
 * The first unknown flag token in `raw` (the `--x` part of `--x=1`), or
 * undefined when every flag is known.
 *
 * @param raw - Raw argv, before `normalizeArgs`.
 * @param reg - The built-in registry.
 * @param extra - Flags known on top of the registry (plugin command flags).
 */
export function findUnknownFlag(
  raw: readonly string[],
  reg: BuiltinRegistry,
  extra: readonly FlagSpec[] = [],
): string | undefined {
  return flagTokens(raw, reg, extra).find((t) => !t.known)?.name
}

/** The error line for an unknown flag. */
export function formatUnknownFlag(token: string, program = "minimal-agent"): string {
  return `unknown flag ${token} (see ${program} --help)`
}
