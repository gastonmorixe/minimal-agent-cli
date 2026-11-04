/**
 * The built-in CLI registry (SPEC-HELP M-8a, plan 2.1).
 *
 * Pure data plus pure lookups. No handler import, no core host import, no
 * I/O, so help can read it before any startup side effect (R-18). Nothing
 * reads the registry yet: M-8b (drift test), M-8c (root help), and M-9
 * (command help) wire it in.
 *
 * @module cli/registry
 */

import type { CommandSpec, FlagSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { BUILTIN_COMMANDS, ROOT_COMMAND } from "./commands.ts"
import { BUILTIN_ENV } from "./env.ts"
import { GLOBAL_FLAGS } from "./global-flags.ts"
import { FLAG_GROUPS, ROOT_GROUPS } from "./groups.ts"
import type { BuiltinRegistry, RegistryFlag } from "./types.ts"

export type {
  BuiltinEnvSpec,
  BuiltinRegistry,
  FlagGroup,
  RegistryFlag,
  RootGroup,
} from "./types.ts"

const REGISTRY: BuiltinRegistry = {
  root: ROOT_COMMAND,
  commands: ROOT_COMMAND.commands ?? BUILTIN_COMMANDS,
  globalFlags: GLOBAL_FLAGS,
  env: BUILTIN_ENV,
  rootGroups: ROOT_GROUPS,
  flagGroups: FLAG_GROUPS,
}

/** The built-in registry. Same object on every call. Treat it as read-only. */
export function builtinRegistry(): BuiltinRegistry {
  return REGISTRY
}

/** The visible and hidden child commands of `node`. */
export function childrenOf(node: CommandSpec): readonly CommandSpec[] {
  return node.commands ?? []
}

/** True when `name` is the child's name or one of its aliases. */
function matches(child: CommandSpec, name: string): boolean {
  return child.name === name || (child.aliases?.includes(name) ?? false)
}

/**
 * The command at `path`, walking names and aliases from the root. An empty
 * path gives the root. Returns `undefined` when a segment does not match.
 */
export function findCommand(
  reg: BuiltinRegistry,
  path: readonly string[],
): CommandSpec | undefined {
  let node: CommandSpec | undefined = reg.root
  for (const segment of path) {
    node = childrenOf(node).find((child) => matches(child, segment))
    if (node === undefined) return undefined
  }
  return node
}

/** Every long form of `spec` with dashes: name, aliases, and `--no-<name>` when negatable. */
export function longForms(spec: FlagSpec): string[] {
  const out = [`--${spec.name}`, ...(spec.aliases ?? []).map((a) => `--${a}`)]
  if (spec.negatable === true) out.push(`--no-${spec.name}`)
  return out
}

/**
 * Every FlagSpec at every depth, hidden ones included: the global flags
 * first (empty `path`), then each command's own flags in tree order. A
 * spec that a command lists by reference to a global spec appears once,
 * as the global entry.
 */
export function allFlags(reg: BuiltinRegistry): RegistryFlag[] {
  const globals = new Set<FlagSpec>(reg.globalFlags)
  const out: RegistryFlag[] = reg.globalFlags.map((spec) => ({
    spec,
    path: [],
    longs: longForms(spec),
  }))
  const walk = (node: CommandSpec, path: readonly string[]): void => {
    for (const spec of node.flags ?? []) {
      if (!globals.has(spec)) out.push({ spec, path, longs: longForms(spec) })
    }
    for (const child of childrenOf(node)) walk(child, [...path, child.name])
  }
  for (const command of reg.commands) walk(command, [command.name])
  return out
}
