/**
 * CLI registry types over the help contract (SPEC-HELP 8.3, plan M-8a).
 *
 * The contract types (`CommandSpec`, `FlagSpec`, `EnvSpec`, ...) come from
 * core plugin-api. This module adds the CLI-only shapes that tie the
 * built-in specs together: root groups, flag groups, and the registry.
 * All values are plain data: no functions, no class instances.
 *
 * @module cli/registry/types
 */

import type {
  CommandSpec,
  EnvSpec,
  FlagSpec,
} from "@minimal-agent/core/plugin-api/types/cli-contract"

/** One row group of the root COMMANDS section, for example `discover`. */
export interface RootGroup {
  /** Group id. A `CommandSpec.group` names one of these ids. */
  readonly id: string
  /** Group heading. */
  readonly title: string
  /** One line, plain text. */
  readonly summary: string
  /** Command paths in this group, in display order. Each path resolves in the registry. */
  readonly members: readonly (readonly string[])[]
}

/** One heading inside FLAGS. A `FlagSpec.group` names one of these ids. */
export interface FlagGroup {
  /** Group id. */
  readonly id: string
  /** Group heading. */
  readonly title: string
  /** Short note next to the heading, plain text. The renderer adds any brackets. */
  readonly note?: string
}

/**
 * A built-in env entry. The contract {@link EnvSpec} has no description
 * and no value hint, so the CLI keeps them here.
 */
export interface BuiltinEnvSpec extends EnvSpec {
  /** Paragraphs, plain text. Command help shows them, root help does not (R-13). */
  description?: string[]
  /** The value that turns a switch on or off, for example `"1"`. Help shows `set to 1`. */
  set?: string
}

/** The built-in CLI registry: every built-in command, global flag, and env name. */
export interface BuiltinRegistry {
  /** The program node. Its `commands` are the top-level built-in commands. */
  readonly root: CommandSpec
  /** Top-level built-in commands, in root help order. Same array as `root.commands`. */
  readonly commands: readonly CommandSpec[]
  /** Flags that apply to every path. Each entry has `global: true`. */
  readonly globalFlags: readonly FlagSpec[]
  /** Environment variables, in root help order. Hidden entries last. */
  readonly env: readonly BuiltinEnvSpec[]
  /** Root COMMANDS groups, in display order. */
  readonly rootGroups: readonly RootGroup[]
  /** FLAGS headings, in display order. */
  readonly flagGroups: readonly FlagGroup[]
}

/** One FlagSpec as {@link allFlags} sees it: the spec, where it sits, and its long forms. */
export interface RegistryFlag {
  /** The flag spec. Global specs appear once, with an empty `path`. */
  readonly spec: FlagSpec
  /** Command path of the node that declares the flag. Empty for a global flag. */
  readonly path: readonly string[]
  /** Every long form with dashes: `--name`, `--<alias>`, and `--no-<name>` when negatable. */
  readonly longs: readonly string[]
}
