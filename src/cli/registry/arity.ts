/**
 * Parser arity tables derived from the CLI registry (SPEC-HELP M-12, R-4).
 *
 * One FlagSpec drives parse and help (R-4). This module turns the registry
 * into the four tables the argv parser reads, so a new flag needs no hand
 * list edit:
 *
 * - `flagsWithValues`: every long form of a flag with `value: "required"`.
 *   The prompt scan (`extract-prompt.ts`) skips the flag and the next token.
 * - `flagsNoValue`: every long form of a flag with `value: "none"` or
 *   `value: "optional"`, plus the `--no-<name>` form of a negatable flag.
 *   The prompt scan skips the flag only. Optional-value flags (`--sessions`,
 *   `--list-models`, `--list-models-live`, `--usage`) stay here on purpose
 *   (spec M-12): each one selects a command that never reads the prompt,
 *   and `parse-argv.ts` reads its value with `valueAfter`.
 * - `shortToLong`: `-x` to `--name` for every flag with a `short`.
 * - `longAlias`: `--alias` to `--name` for the aliases that `normalizeArgs`
 *   rewrites. Only the hidden command-form flags (group `command-forms`)
 *   get their aliases rewritten. The parser reads the other aliases by
 *   their own name (`--surface` in parse-argv.ts, `--email-hint` in
 *   run-subcommand.ts, `--no-agents` in main.ts), so they stay as typed.
 *
 * Every table holds global flags and the flags of every command at every
 * depth. The parser is not path-aware, so a command flag such as
 * `--parallel` is known on every path.
 *
 * Pure: no I/O. Imports only the registry, so help can load it (R-18).
 *
 * @module cli/registry/arity
 */

import type { FlagSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { allFlags, builtinRegistry } from "./index.ts"
import type { BuiltinRegistry } from "./types.ts"

/** The four parser tables. */
export interface ArityTables {
  /** Long flags that consume the next token as their value. */
  readonly flagsWithValues: ReadonlySet<string>
  /** Flags that consume no token after them. */
  readonly flagsNoValue: ReadonlySet<string>
  /** Short flag (`-m`) to long flag (`--model`). */
  readonly shortToLong: Readonly<Record<string, string>>
  /** Long alias (`--models`) to the canonical long flag (`--list-models`). */
  readonly longAlias: Readonly<Record<string, string>>
}

/** FlagSpec.group whose aliases `normalizeArgs` rewrites to the name. */
export const REWRITTEN_ALIAS_GROUP = "command-forms"

/**
 * Tokens in `flagsNoValue` that no FlagSpec owns:
 * - `-`: the stdin sentinel. The prompt scan returns `stdin` before the
 *   positional walk, so this entry only keeps the old set shape.
 * - `-h`: `normalizeArgs` rewrites it to `--help`. Kept from the old hand
 *   set so a caller that passes raw argv keeps its old result.
 */
export const EXTRA_NO_VALUE_TOKENS: readonly string[] = ["-", "-h"]

/** The arity of one spec: its `value`, else `none` for a boolean, else `required`. */
export function specArity(spec: FlagSpec): "none" | "required" | "optional" {
  return spec.value ?? (spec.type === "boolean" ? "none" : "required")
}

/**
 * Every long form of `spec` with its arity. The `--no-<name>` form of a
 * negatable flag takes no value.
 */
function longFormArities(spec: FlagSpec): [string, "none" | "required" | "optional"][] {
  const arity = specArity(spec)
  const out: [string, "none" | "required" | "optional"][] = [
    [`--${spec.name}`, arity],
    ...(spec.aliases ?? []).map((a): [string, typeof arity] => [`--${a}`, arity]),
  ]
  if (spec.negatable === true) out.push([`--no-${spec.name}`, "none"])
  return out
}

/**
 * Derive the four parser tables from `reg`. Throws when one long form or
 * one short form has two meanings: the registry tests forbid it, so a throw
 * here is a bad registry edit, not a user error.
 */
export function deriveArity(reg: BuiltinRegistry): ArityTables {
  const arityOf = new Map<string, string>()
  const flagsWithValues = new Set<string>()
  const flagsNoValue = new Set<string>(EXTRA_NO_VALUE_TOKENS)
  const shortToLong: Record<string, string> = {}
  const longAlias: Record<string, string> = {}

  for (const { spec } of allFlags(reg)) {
    for (const [long, arity] of longFormArities(spec)) {
      const seen = arityOf.get(long)
      if (seen !== undefined && seen !== arity) {
        throw new Error(`registry: ${long} has two arities (${seen}, ${arity})`)
      }
      arityOf.set(long, arity)
      if (arity === "required") flagsWithValues.add(long)
      else flagsNoValue.add(long)
    }

    if (spec.short !== undefined) {
      const short = `-${spec.short}`
      const long = `--${spec.name}`
      const seen = shortToLong[short]
      if (seen !== undefined && seen !== long) {
        throw new Error(`registry: ${short} maps to ${seen} and ${long}`)
      }
      shortToLong[short] = long
    }

    if (spec.group === REWRITTEN_ALIAS_GROUP) {
      for (const alias of spec.aliases ?? []) longAlias[`--${alias}`] = `--${spec.name}`
    }
  }

  return { flagsWithValues, flagsNoValue, shortToLong, longAlias }
}

let cached: ArityTables | undefined

/** The tables of the built-in registry. Same object on every call. */
export function builtinArity(): ArityTables {
  cached ??= deriveArity(builtinRegistry())
  return cached
}
