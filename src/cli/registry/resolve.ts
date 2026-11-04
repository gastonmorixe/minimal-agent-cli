/**
 * Help path resolution (SPEC-HELP R-14 to R-17, 8.7, plan M-9a, 4.1).
 *
 * Pure: no env, no fs, no console. Nothing calls it yet: M-9c wires it into
 * startup. It reads raw argv (before `normalizeArgs`), because
 * `normalizeArgs` rewrites `sessions dump` to `--dump` and the path is lost.
 *
 * Rules:
 * - Help mode only. Without `--help`, `-h`, or a leading `help`, the result
 *   is `undefined` (normal run).
 * - Forms: `--help` or `-h` anywhere (walk all positionals), `help [path...]`
 *   as raw[0] (walk the positionals after it).
 * - Positionals are tokens that do not start with `-` (a lone `-` is a
 *   positional), minus the values of value flags. Arity comes from the
 *   registry: `"required"` takes the next token, `"optional"` takes it only
 *   when it does not start with `-`. `--flag=value` takes no extra token.
 * - Strict walk (R-16): go down while the next positional is a child name or
 *   alias. The first other token stops the walk.
 * - Hidden commands resolve. They are never suggested.
 * - Exit codes are not decided here (M-9c).
 *
 * @module cli/registry/resolve
 */

import type { CommandSpec, FlagSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { allFlags, childrenOf } from "./index.ts"
import { suggestChildren } from "./suggest.ts"
import type { BuiltinRegistry } from "./types.ts"

/** The result of {@link resolveHelpRequest} in help mode. */
export type HelpRequest =
  /** Print help for `path` (canonical names). Empty path: root help. */
  | { kind: "help"; path: string[] }
  /**
   * `token` is not a child of the command at `at` (canonical names, the
   * deepest known path), and that command takes no free positional.
   * `suggestions` holds up to 3 visible child names or aliases.
   */
  | { kind: "unknown"; at: string[]; token: string; suggestions: string[] }

/** Value mode of a flag token. */
type Arity = "none" | "required" | "optional"

const ARITY_RANK: Record<Arity, number> = { none: 0, optional: 1, required: 2 }

/** The value mode of `spec`, with the contract default. */
function arityOf(spec: FlagSpec): Arity {
  return spec.value ?? (spec.type === "boolean" ? "none" : "required")
}

/**
 * Value mode per flag token (`--name`, `--alias`, `--no-name`, `-s`), from
 * every FlagSpec at every depth. When two specs share a token, the wider
 * mode wins (required, then optional, then none). `--no-<name>` forms take
 * no value.
 */
function arityTable(reg: BuiltinRegistry): Map<string, Arity> {
  const table = new Map<string, Arity>()
  const put = (token: string, arity: Arity): void => {
    const old = table.get(token)
    if (old === undefined || ARITY_RANK[arity] > ARITY_RANK[old]) table.set(token, arity)
  }
  for (const { spec, longs } of allFlags(reg)) {
    const arity = arityOf(spec)
    for (const long of longs) put(long, long === `--no-${spec.name}` ? "none" : arity)
    if (spec.short !== undefined) put(`-${spec.short}`, arity)
  }
  return table
}

/** Arity tables per registry object. The registry is read-only data. */
const ARITY_CACHE = new WeakMap<BuiltinRegistry, Map<string, Arity>>()

function cachedArityTable(reg: BuiltinRegistry): Map<string, Arity> {
  let table = ARITY_CACHE.get(reg)
  if (table === undefined) {
    table = arityTable(reg)
    ARITY_CACHE.set(reg, table)
  }
  return table
}

/** True when `token` is a flag token (starts with `-`, and is not a lone `-`). */
function isFlagToken(token: string): boolean {
  return token.startsWith("-") && token !== "-"
}

/** The positional tokens of `tokens`, with flag values skipped. */
export function helpPositionals(tokens: readonly string[], reg: BuiltinRegistry): string[] {
  const arity = cachedArityTable(reg)
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ""
    if (!isFlagToken(token)) {
      out.push(token)
      continue
    }
    // `--flag=value` carries its value in the same token.
    if (token.includes("=")) continue
    const mode = arity.get(token) ?? "none"
    const next = tokens[i + 1]
    if (next === undefined) continue
    if (mode === "required") i++
    else if (mode === "optional" && !isFlagToken(next)) i++
  }
  return out
}

/** The child of `node` with name or alias `name`, hidden children included. */
function findChild(node: CommandSpec, name: string): CommandSpec | undefined {
  return childrenOf(node).find(
    (child) => child.name === name || (child.aliases?.includes(name) ?? false),
  )
}

/**
 * Resolve raw argv to a help request, or `undefined` when argv is not a help
 * request. See the module doc for the rules.
 */
export function resolveHelpRequest(
  raw: readonly string[],
  reg: BuiltinRegistry,
): HelpRequest | undefined {
  const helpForm = raw[0] === "help"
  const flagForm = raw.includes("--help") || raw.includes("-h")
  if (!helpForm && !flagForm) return undefined

  const positionals = helpPositionals(helpForm ? raw.slice(1) : raw, reg)
  let node = reg.root
  const path: string[] = []
  let index = 0
  for (; index < positionals.length; index++) {
    const child = findChild(node, positionals[index] ?? "")
    if (child === undefined) break
    node = child
    path.push(child.name)
  }

  const token = positionals[index]
  if (token === undefined) return { kind: "help", path }

  if (node === reg.root) {
    // Spec 8.7: a free prompt plus `--help` gives root help. `help <bogus>` is unknown (R-17).
    if (helpForm) return unknown(path, token, node)
    return { kind: "help", path }
  }
  const children = childrenOf(node)
  // A leaf, or a node with a free positional: the token is an argument.
  if (children.length === 0 || (node.args?.length ?? 0) > 0) return { kind: "help", path }
  return unknown(path, token, node)
}

function unknown(at: string[], token: string, node: CommandSpec): HelpRequest {
  return { kind: "unknown", at, token, suggestions: suggestChildren(node, token) }
}
