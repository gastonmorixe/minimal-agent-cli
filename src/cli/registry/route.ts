/**
 * Command route resolution (SPEC-HELP R-39, 7.7, plan M-13b, 2.1).
 *
 * Pure: no env, no fs, no console. Reads raw argv (before `normalizeArgs`)
 * and the built-in registry. It is in the help import closure, so it may
 * import only registry modules.
 *
 * Not wired yet. `planCommand` (src/cli/command-plan.ts) still selects the
 * command. The parity test (src/startup/dispatch/invocation-parity.test.ts)
 * compares the two on every frozen argv form. M-13c moves dispatch here.
 *
 * Rules:
 * - Positionals are tokens that do not start with `-` (a lone `-` is a
 *   positional), minus flag values. Arity comes from the registry, the same
 *   way as the help walk (`helpPositionals`). A flag value is never a path
 *   segment: `auth-status --name refresh` is `auth-status` with
 *   `--name refresh`, not `auth-status refresh`.
 * - Word form: `raw[0]` is a top-level command name. Walk down strictly with
 *   the positionals. At a node with required arguments and child commands
 *   (`provider <id> <command>`), the required arguments come before the
 *   child name.
 * - Flag form: the command-form flags select a command in a fixed order
 *   ({@link COMMAND_FORM_ORDER}, the `planCommand` precedence). The word
 *   form has a place in the same order, and the first form wins
 *   (`login --list-models` is `list-models`, `sessions --logout` is
 *   `sessions`). A command-form flag with a required value selects only
 *   when a token follows it (`--dump` alone is no dump). Only
 *   `--auth-status` walks its children (`--auth-status plan`). The other
 *   flag forms keep their path.
 * - Then `--host-mode <id>`.
 * - Else `undefined`: the root run path (REPL or one prompt). `resume`,
 *   `resume-same`, `sessions resume`, and `sessions resume-same` are run
 *   flags in word form: they give no word route, so a command-form flag
 *   can still select a command. A one-word prompt
 *   that is no built-in (`schedule`, `plugin`) gives `undefined` (V-19, Q-9).
 *
 * @module cli/registry/route
 */

import type { CommandSpec, FlagSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { specArity } from "./arity.ts"
import { allFlags, childrenOf, longForms } from "./index.ts"
import { hostModeValue } from "./resolve.ts"
import type { BuiltinRegistry } from "./types.ts"

/** A built-in command route. */
export interface BuiltinRoute {
  readonly kind: "builtin"
  /** Canonical command names from the root, for example `["auth-status", "plan"]`. */
  readonly path: readonly string[]
  /** `word`: `auth-status plan`. `flag`: `--auth-status plan`. */
  readonly form: "word" | "flag"
  /** The positional tokens that are not path segments, in argv order. */
  readonly args: readonly string[]
  /** The flag tokens and their values, in argv order. */
  readonly flags: readonly string[]
}

/** `--host-mode <id>`: the run of a plugin host mode. */
export interface HostModeRoute {
  readonly kind: "host-mode"
  readonly id: string
}

/** The result of {@link resolveCommandRoute}. `undefined` is the root run path. */
export type CommandRoute = BuiltinRoute | HostModeRoute

/** One command form: a command-form flag, its path, and its word paths. */
export interface CommandForm {
  /** The global FlagSpec name, without dashes. */
  readonly flag: string
  /** The canonical path the flag selects. */
  readonly path: readonly string[]
  /**
   * The word-form path prefixes of the same command. The longest prefix of
   * a word path picks its form (`providers models` is `list-models`, not
   * `list-providers`).
   */
  readonly words: readonly (readonly string[])[]
  /** True when positionals after the flag walk the children of `path`. */
  readonly walk?: true
}

/**
 * The command forms in selection order (the `planCommand` precedence).
 * Data, not code. The old planner ranks the word form and the flag forms
 * on one scale: `normalizeArgs` turns the word into its flag. So the form
 * with the lowest index wins, word or flag (`login --list-models` is
 * `list-models`).
 */
export const COMMAND_FORM_ORDER: readonly CommandForm[] = [
  { flag: "dump", path: ["sessions", "dump"], words: [["sessions", "dump"]] },
  { flag: "sessions", path: ["sessions"], words: [["sessions"]] },
  { flag: "usage", path: ["usage"], words: [["usage"]] },
  { flag: "list-flags", path: ["flags"], words: [["flags"]] },
  { flag: "list-spinners", path: ["spinners"], words: [["spinners"]] },
  {
    flag: "list-models-live",
    path: ["providers", "models-live"],
    words: [["models-live"], ["providers", "models-live"], ["provider", "models-live"]],
  },
  {
    flag: "list-models",
    path: ["providers", "models"],
    words: [["models"], ["providers", "models"], ["provider", "models"]],
  },
  { flag: "list-providers", path: ["providers"], words: [["providers"], ["provider"]] },
  { flag: "list-plugins", path: ["plugins"], words: [["plugins"]] },
  {
    flag: "login",
    path: ["login"],
    words: [["login"], ["providers", "login"], ["provider", "login"]],
  },
  {
    flag: "logout",
    path: ["logout"],
    words: [["logout"], ["providers", "logout"], ["provider", "logout"]],
  },
  { flag: "auth-status", path: ["auth-status"], words: [["auth-status"]], walk: true },
]

/** True when `prefix` is a prefix of `path`. */
function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((s, i) => s === path[i])
}

/**
 * The index in {@link COMMAND_FORM_ORDER} of the word path `path`: the form
 * with the longest word prefix. `-1` when no form has it.
 */
export function wordFormIndex(path: readonly string[]): number {
  let best = -1
  let bestLength = 0
  COMMAND_FORM_ORDER.forEach((form, index) => {
    for (const word of form.words) {
      if (word.length > bestLength && isPrefix(word, path)) {
        best = index
        bestLength = word.length
      }
    }
  })
  return best
}

/**
 * Word forms that run the agent (the session resume forms). `normalizeArgs`
 * maps them to run flags, so they give the root run path.
 */
const RUN_WORD_PATHS: readonly (readonly string[])[] = [
  ["resume"],
  ["resume-same"],
  ["sessions", "resume"],
  ["sessions", "resume-same"],
]

type Arity = "none" | "required" | "optional"

const ARITY_RANK: Record<Arity, number> = { none: 0, optional: 1, required: 2 }

/** Value mode per flag token at every depth. The wider mode wins on a shared token. */
function arityTable(reg: BuiltinRegistry): Map<string, Arity> {
  const table = new Map<string, Arity>()
  const put = (token: string, arity: Arity): void => {
    const old = table.get(token)
    if (old === undefined || ARITY_RANK[arity] > ARITY_RANK[old]) table.set(token, arity)
  }
  for (const { spec, longs } of allFlags(reg)) {
    const arity = specArity(spec)
    for (const long of longs) put(long, long === `--no-${spec.name}` ? "none" : arity)
    if (spec.short !== undefined) put(`-${spec.short}`, arity)
  }
  return table
}

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

/**
 * The argv indexes of the positionals of `raw`. Same rule as
 * `helpPositionals` (src/cli/registry/resolve.ts): `required` takes the next
 * token, `optional` takes it when it is not a flag, `--x=v` takes none.
 */
function positionalIndexes(raw: readonly string[], reg: BuiltinRegistry): number[] {
  const arity = cachedArityTable(reg)
  const out: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i] ?? ""
    if (!isFlagToken(token)) {
      out.push(i)
      continue
    }
    if (token.includes("=")) continue
    const mode = arity.get(token) ?? "none"
    const next = raw[i + 1]
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

/** The number of required ArgSpecs at the start of `node.args`. */
function leadingRequiredArgs(node: CommandSpec): number {
  let n = 0
  for (const arg of node.args ?? []) {
    if (arg.required !== true) break
    n++
  }
  return n
}

interface Walked {
  /** Canonical path suffix. */
  readonly path: string[]
  /** Argv indexes of the path segments. */
  readonly segments: number[]
  /** Argv indexes of the positionals that are arguments. */
  readonly args: number[]
}

/** Walk down from `start` with the positionals at `indexes` of `raw`. */
function walk(start: CommandSpec, raw: readonly string[], indexes: readonly number[]): Walked {
  const out: Walked = { path: [], segments: [], args: [] }
  let node = start
  let i = 0
  while (i < indexes.length) {
    const at = indexes[i] ?? 0
    const child = findChild(node, raw[at] ?? "")
    if (child !== undefined) {
      node = child
      out.path.push(child.name)
      out.segments.push(at)
      i++
      continue
    }
    // `provider <id> <command>`: required args come before the child name.
    const required = leadingRequiredArgs(node)
    if (required === 0 || childrenOf(node).length === 0) break
    const nextAt = indexes[i + required]
    if (nextAt === undefined || findChild(node, raw[nextAt] ?? "") === undefined) break
    out.args.push(...indexes.slice(i, i + required))
    i += required
  }
  out.args.push(...indexes.slice(i))
  return out
}

/** The global FlagSpec named `name`. */
function globalFlag(reg: BuiltinRegistry, name: string): FlagSpec | undefined {
  return reg.globalFlags.find((spec) => spec.name === name)
}

/**
 * True when `raw` holds the command-form flag `spec` in a form that
 * selects it: any long form, also `--x=value`. A flag with a required
 * value needs a non-empty token after it (any token, a flag too: the old
 * reader takes the raw next token), or a non-empty `=` value.
 */
function hasCommandForm(raw: readonly string[], spec: FlagSpec): boolean {
  const longs = longForms(spec)
  const needsValue = specArity(spec) === "required"
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i] ?? ""
    const eq = token.startsWith("--") ? token.indexOf("=") : -1
    const key = eq === -1 ? token : token.slice(0, eq)
    if (!longs.includes(key)) continue
    if (!needsValue) return true
    if (eq === -1 ? Boolean(raw[i + 1]) : token.length > eq + 1) return true
  }
  return false
}

/** The node at the canonical `path`. */
function nodeAt(reg: BuiltinRegistry, path: readonly string[]): CommandSpec | undefined {
  let node: CommandSpec | undefined = reg.root
  for (const name of path) {
    node = node === undefined ? undefined : findChild(node, name)
  }
  return node
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i])
}

function builtin(
  raw: readonly string[],
  path: readonly string[],
  form: "word" | "flag",
  argIndexes: readonly number[],
  positionals: readonly number[],
): BuiltinRoute {
  const used = new Set(positionals)
  return {
    kind: "builtin",
    path,
    form,
    args: argIndexes.map((i) => raw[i] ?? ""),
    flags: raw.filter((_, i) => !used.has(i)),
  }
}

/**
 * The word-form route. Two word forms need a token today, else argv is a
 * run (the `normalizeArgs` and `parseCliOptions` behavior):
 * - `provider <id>`: `provider` with no id is a prompt.
 * - `sessions dump <sid>`: the old reader takes the raw token after `dump`.
 *   With no token there is no dump.
 */
function wordRoute(
  raw: readonly string[],
  reg: BuiltinRegistry,
  positionals: readonly number[],
): BuiltinRoute | undefined {
  const walked = walk(reg.root, raw, positionals)
  const { path } = walked
  if (RUN_WORD_PATHS.some((p) => samePath(p, path))) return undefined
  if (samePath(path, ["provider"]) && walked.args.length === 0) return undefined
  if (samePath(path, ["sessions", "dump"])) {
    const dumpAt = walked.segments[1] ?? 0
    if (!raw[dumpAt + 1]) return undefined
  }
  return builtin(raw, path, "word", walked.args, positionals)
}

/**
 * Resolve raw argv to a command route, or `undefined` for the root run
 * path. See the module doc for the rules. Help argv never reaches this
 * function (help resolves first).
 */
export function resolveCommandRoute(
  raw: readonly string[],
  reg: BuiltinRegistry,
): CommandRoute | undefined {
  const positionals = positionalIndexes(raw, reg)
  const head = raw[0]
  const word =
    head !== undefined && !isFlagToken(head) && findChild(reg.root, head) !== undefined
      ? wordRoute(raw, reg, positionals)
      : undefined
  // A word form that is a run (`resume <sid>`) gives no word route, so a
  // command-form flag can still select a command (`resume x --list-models`).
  const wordIndex = word === undefined ? COMMAND_FORM_ORDER.length : wordFormIndex(word.path)

  for (const [index, form] of COMMAND_FORM_ORDER.entries()) {
    if (word !== undefined && index >= wordIndex) return word
    const spec = globalFlag(reg, form.flag)
    if (spec === undefined || !hasCommandForm(raw, spec)) continue
    const node = nodeAt(reg, form.path)
    if (form.walk === true && node !== undefined) {
      const below = walk(node, raw, positionals)
      return builtin(raw, [...form.path, ...below.path], "flag", below.args, positionals)
    }
    return builtin(raw, form.path, "flag", positionals, positionals)
  }

  const hostMode = hostModeValue(raw)
  if (hostMode !== undefined) return { kind: "host-mode", id: hostMode }
  return undefined
}
