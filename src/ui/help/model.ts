/**
 * Help model builder (SPEC-HELP 8.3, plan M-8c, 2.4).
 *
 * {@link buildHelpModel} turns the built-in registry into the contract
 * {@link HelpModel}: plain text sections, no color (R-3). The renderer adds
 * style. In M-8c the root model keeps today's root help layout through the
 * temporary data in `legacy-root.ts`, so root help stays byte-identical.
 * M-8d moves the root model to the spec 8.4 layout. M-9b adds command help
 * ({@link buildCommandHelpModel}, spec 8.5 order).
 *
 * Pure: no I/O, no handler import.
 *
 * @module ui/help/model
 */

import { AGENT_VERSION } from "@minimal-agent/core/host/build-info"
import {
  type ArgSpec,
  type CatalogCliEntry,
  CLI_CONTRACT_VERSION,
  type CommandSectionId,
  type CommandSpec,
  type EnvSpec,
  type FlagSpec,
  type HelpModel,
  type HelpModelGroup,
  type HelpModelProgram,
  type HelpModelRow,
  type HelpModelSection,
} from "@minimal-agent/core/plugin-api/types/cli-contract"

import {
  type BuiltinEnvSpec,
  type BuiltinRegistry,
  childrenOf,
  findCommand,
} from "../../cli/registry/index.ts"
import {
  LEGACY_AUTH_ITEMS,
  LEGACY_DOCS,
  LEGACY_HINT,
  LEGACY_INFO_ITEMS,
  LEGACY_OPTIONS_ORDER,
  LEGACY_PLUGIN_NOTES,
  LEGACY_SYSTEM_PROMPT_GROUP,
  LEGACY_TERM_OVERRIDES,
  LEGACY_TITLES,
  LEGACY_URL,
  type LegacyItem,
} from "./legacy-root.ts"

/** Inputs of {@link buildHelpModel}. */
export interface BuildHelpModelOptions {
  /** Program name and version. Default: the root spec name and the core version. */
  readonly program?: HelpModelProgram
  /** Plugin catalog. Unused in M-8c: plugin rows land in M-10 and M-18. */
  readonly catalog?: readonly CatalogCliEntry[]
  /** Command path. Empty or absent: root help. Else command help (M-9b). */
  readonly path?: readonly string[]
}

/** The source of every built-in row. */
const BUILTIN = "builtin" as const

/** One model row from plain text. */
function row(term: string, summary: string): HelpModelRow {
  return { term, summary, source: BUILTIN }
}

/** Summary plus the notes in brackets, joined with ", " (the legacy `row()` rule). */
function withNotes(summary: string, description: readonly string[] | undefined): string {
  if (description === undefined || description.length === 0) return summary
  return `${summary} (${description.join(", ")})`
}

/** The help term of a flag: `-s, --name, --alias <value>`, or `--x / --no-x` when negatable. */
export function flagTerm(spec: FlagSpec): string {
  const longs = [`--${spec.name}`, ...(spec.aliases ?? []).map((a) => `--${a}`)]
  const names = [...(spec.short === undefined ? [] : [`-${spec.short}`]), ...longs].join(", ")
  const mode = spec.value ?? (spec.type === "boolean" ? "none" : "required")
  const placeholder = `<${spec.valueName ?? "value"}>`
  if (mode === "required") return `${names} ${placeholder}`
  if (mode === "optional") return `${names} [${placeholder}]`
  if (spec.negatable === true) return `${names} / --no-${spec.name}`
  return names
}

/** One flag row. */
function flagRow(spec: FlagSpec): HelpModelRow {
  return row(flagTerm(spec), withNotes(spec.summary, spec.description))
}

/** One command row: term from `usage[0]`, else the path. */
function commandRow(spec: CommandSpec, path: readonly string[]): HelpModelRow {
  return row(spec.usage?.[0] ?? path.join(" "), withNotes(spec.summary, spec.description))
}

/** One env row. A value hint shows as `NAME=<set>` (legacy override 3). */
function envRow(spec: BuiltinEnvSpec): HelpModelRow {
  const { envValueSuffix, envWildcard } = LEGACY_TERM_OVERRIDES
  const term =
    spec.name === envWildcard.name
      ? envWildcard.name
      : spec.set === undefined
        ? spec.name
        : `${spec.name}${envValueSuffix.separator}${spec.set}`
  return row(term, withNotes(spec.summary, spec.description))
}

function mustFind(reg: BuiltinRegistry, path: readonly string[]): CommandSpec {
  const spec = findCommand(reg, path)
  if (spec === undefined) throw new Error(`help model: no command at "${path.join(" ")}"`)
  return spec
}

/**
 * The display of a root group member: each non-leaf segment adds its
 * required args, so `["provider", "login"]` shows as `provider <id> login`.
 */
function memberDisplay(reg: BuiltinRegistry, path: readonly string[]): string {
  return path
    .map((name, i) => {
      if (i === path.length - 1) return name
      const node = mustFind(reg, path.slice(0, i + 1))
      const required = (node.args ?? []).filter((a) => a.required === true)
      return [name, ...required.map((a) => `<${a.name}>`)].join(" ")
    })
    .join(" ")
}

function helpFlag(reg: BuiltinRegistry): FlagSpec {
  const spec = reg.globalFlags.find((f) => f.name === LEGACY_TERM_OVERRIDES.helpRow.flag)
  if (spec === undefined) throw new Error("help model: no global help flag")
  return spec
}

/** One row of the legacy Auth and Info sections. */
function legacyItemRow(reg: BuiltinRegistry, item: LegacyItem): HelpModelRow {
  if ("helpRow" in item) return row(LEGACY_TERM_OVERRIDES.helpRow.term, helpFlag(reg).summary)
  if ("command" in item) return commandRow(mustFind(reg, item.command), item.command)
  const spec = mustFind(reg, item.path).flags?.find((f) => f.name === item.flag)
  if (spec === undefined) {
    throw new Error(`help model: no flag --${item.flag} at "${item.path.join(" ")}"`)
  }
  return flagRow(spec)
}

/** Visible global flags in the legacy Options order, then any other visible ones. */
function optionsRows(reg: BuiltinRegistry): HelpModelRow[] {
  const helpName = LEGACY_TERM_OVERRIDES.helpRow.flag
  const visible = reg.globalFlags.filter(
    (f) => f.hidden !== true && f.group !== LEGACY_SYSTEM_PROMPT_GROUP && f.name !== helpName,
  )
  const rank = (f: FlagSpec): number => {
    const i = LEGACY_OPTIONS_ORDER.indexOf(f.name)
    return i < 0 ? LEGACY_OPTIONS_ORDER.length : i
  }
  return visible.toSorted((a, b) => rank(a) - rank(b)).map(flagRow)
}

function systemPromptGroup(reg: BuiltinRegistry): HelpModelGroup {
  const group = reg.flagGroups.find((g) => g.id === LEGACY_SYSTEM_PROMPT_GROUP)
  const base = group?.title ?? "System prompt"
  const title = group?.note === undefined ? base : `${base} (${group.note})`
  const rows = reg.globalFlags
    .filter((f) => f.hidden !== true && f.group === LEGACY_SYSTEM_PROMPT_GROUP)
    .map(flagRow)
  return { title, rows }
}

function exampleRows(reg: BuiltinRegistry, program: HelpModelProgram): HelpModelRow[] {
  const { stdinExample } = LEGACY_TERM_OVERRIDES
  return (reg.root.examples ?? []).map((ex) => {
    if (ex.argv === stdinExample.argv) return row(stdinExample.term, ex.summary)
    const argv = ex.argv === "" ? "" : ` ${ex.argv}`
    return row(`$ ${program.name}${argv}`, ex.summary)
  })
}

/** The root model in the legacy layout (plan 2.4). M-8d replaces it. */
function buildLegacyRootModel(reg: BuiltinRegistry, program: HelpModelProgram): HelpModel {
  const sections: HelpModelSection[] = [
    {
      id: "header",
      title: `${program.name} v${program.version}`,
      text: [reg.root.summary, LEGACY_URL],
    },
    { id: "examples", title: LEGACY_TITLES.examples, rows: exampleRows(reg, program) },
    {
      id: "commands",
      title: LEGACY_TITLES.commands,
      rows: reg.rootGroups.map((g) =>
        row(g.members.map((m) => memberDisplay(reg, m)).join(" · "), g.summary),
      ),
    },
    {
      id: "flags",
      title: "",
      text: [LEGACY_HINT],
      groups: [
        { title: LEGACY_TITLES.options, rows: optionsRows(reg) },
        systemPromptGroup(reg),
        { title: LEGACY_TITLES.auth, rows: LEGACY_AUTH_ITEMS.map((i) => legacyItemRow(reg, i)) },
        { title: LEGACY_TITLES.info, rows: LEGACY_INFO_ITEMS.map((i) => legacyItemRow(reg, i)) },
      ],
    },
    {
      id: "environment",
      title: LEGACY_TITLES.environment,
      rows: reg.env.filter((e) => e.hidden !== true).map(envRow),
    },
    {
      id: "plugin-notes",
      title: LEGACY_TITLES.pluginNotes,
      rows: LEGACY_PLUGIN_NOTES.map(([term, summary]) => row(term, summary)),
    },
    {
      id: "learn-more",
      title: LEGACY_TITLES.learnMore,
      rows: LEGACY_DOCS.map(([term, summary]) => row(term, summary)),
    },
  ]
  return { contractVersion: CLI_CONTRACT_VERSION, kind: "root", program, path: [], sections }
}

/**
 * Build a help model from the registry. An empty or absent `opts.path`
 * gives the root model (legacy layout until M-8d). A non-empty path gives
 * the command model ({@link buildCommandHelpModel}). `opts.catalog` is
 * accepted and unused until plugin rows land (M-10, M-18).
 */
export function buildHelpModel(reg: BuiltinRegistry, opts: BuildHelpModelOptions = {}): HelpModel {
  const program = opts.program ?? { name: reg.root.name, version: AGENT_VERSION }
  if (opts.path !== undefined && opts.path.length > 0) {
    return buildCommandHelpModel(reg, opts.path, program)
  }
  return buildLegacyRootModel(reg, program)
}

// ---------------------------------------------------------------------------
// Command help (SPEC-HELP 8.5, plan M-9b, 4.3)
// ---------------------------------------------------------------------------

/** Command help section ids in the spec 8.5 order. */
export const COMMAND_SECTION_ORDER = [
  "header",
  "usage",
  "arguments",
  "commands",
  "flags",
  "global-flags",
  "environment",
  "examples",
  "see-also",
] as const satisfies readonly CommandSectionId[]

/** Section titles of command help (upper case, as in the spec 8.6 mock). */
const COMMAND_TITLES: Record<Exclude<CommandSectionId, "header">, string> = {
  usage: "USAGE",
  arguments: "ARGUMENTS",
  commands: "COMMANDS",
  flags: "FLAGS",
  "global-flags": "GLOBAL FLAGS",
  environment: "ENVIRONMENT",
  examples: "EXAMPLES",
  "see-also": "SEE ALSO",
}

/** The global flags that command help lists in GLOBAL FLAGS, in order. */
const COMMAND_GLOBAL_FLAGS = ["help", "debug"] as const

/** The walk from the root to `path`: one spec per segment. Throws on an unknown segment. */
function commandChain(reg: BuiltinRegistry, path: readonly string[]): CommandSpec[] {
  const chain: CommandSpec[] = []
  let node = reg.root
  for (const segment of path) {
    const next = childrenOf(node).find(
      (child) => child.name === segment || (child.aliases?.includes(segment) ?? false),
    )
    if (next === undefined) throw new Error(`help model: no command at "${path.join(" ")}"`)
    chain.push(next)
    node = next
  }
  return chain
}

/** One arg in usage form: `<x>` required, `[<x>]` optional, `...` when variadic. */
function argUsage(arg: ArgSpec): string {
  const more = arg.variadic === true ? "..." : ""
  return arg.required === true ? `<${arg.name}>${more}` : `[<${arg.name}>${more}]`
}

/** The visible children of `node`. Hidden children render by path only. */
function visibleChildren(node: CommandSpec): CommandSpec[] {
  return childrenOf(node).filter((child) => child.hidden !== true)
}

/** The display of a command path: each segment before the last adds its required args. */
function pathDisplay(chain: readonly CommandSpec[]): string {
  return chain
    .map((spec, i) => {
      if (i === chain.length - 1) return spec.name
      const required = (spec.args ?? []).filter((a) => a.required === true)
      return [spec.name, ...required.map(argUsage)].join(" ")
    })
    .join(" ")
}

function usageLines(program: string, chain: readonly CommandSpec[]): string[] {
  const spec = chain.at(-1)
  if (spec === undefined) return []
  const display = pathDisplay(chain)
  const flagsPart = (spec.flags ?? []).some((f) => f.hidden !== true) ? ["[flags]"] : []
  const generated = [program, display, ...(spec.args ?? []).map(argUsage), ...flagsPart]
  const lines =
    spec.usage !== undefined && spec.usage.length > 0
      ? spec.usage.map((u) => `${program} ${u}`)
      : [generated.join(" ")]
  const hasCommandLine = lines.some((l) => l.includes("<command>"))
  if (visibleChildren(spec).length > 0 && !hasCommandLine) {
    const required = (spec.args ?? []).filter((a) => a.required === true).map(argUsage)
    lines.push([program, display, ...required, "<command> [args] [flags]"].join(" "))
  }
  return lines
}

function argumentRow(arg: ArgSpec): HelpModelRow {
  const choices = arg.choices === undefined ? [] : [`one of: ${arg.choices.join(", ")}`]
  return row(arg.name, withNotes(arg.summary, choices))
}

/** A child row: the name plus its required args, for example `dump <sid>`. */
function childRow(child: CommandSpec): HelpModelRow {
  const required = (child.args ?? []).filter((a) => a.required === true).map(argUsage)
  return row([child.name, ...required].join(" "), child.summary)
}

/**
 * FLAGS, grouped by `FlagSpec.group`. When the visible flags use one group
 * or none, they form one plain list. Else the flags with no group come first
 * as plain rows, then one titled group per group id, in `flagGroups` order.
 */
function flagsSection(
  reg: BuiltinRegistry,
  flags: readonly FlagSpec[],
): HelpModelSection | undefined {
  const visible = flags.filter((f) => f.hidden !== true)
  if (visible.length === 0) return undefined
  const title = COMMAND_TITLES.flags
  const ids = [...new Set(visible.flatMap((f) => (f.group === undefined ? [] : [f.group])))]
  if (ids.length < 2) return { id: "flags", title, rows: visible.map(flagRow) }
  const rank = (id: string): number => {
    const i = reg.flagGroups.findIndex((g) => g.id === id)
    return i < 0 ? reg.flagGroups.length : i
  }
  const groups: HelpModelGroup[] = ids
    .toSorted((a, b) => rank(a) - rank(b))
    .map((id) => ({
      title: reg.flagGroups.find((g) => g.id === id)?.title ?? id,
      rows: visible.filter((f) => f.group === id).map(flagRow),
    }))
  const plain = visible.filter((f) => f.group === undefined).map(flagRow)
  return { id: "flags", title, ...(plain.length > 0 ? { rows: plain } : {}), groups }
}

function globalFlagsSection(reg: BuiltinRegistry, program: string): HelpModelSection {
  const rows = COMMAND_GLOBAL_FLAGS.flatMap((name) => {
    const spec = reg.globalFlags.find((f) => f.name === name)
    return spec === undefined ? [] : [row(flagTerm(spec), spec.summary)]
  })
  return {
    id: "global-flags",
    title: COMMAND_TITLES["global-flags"],
    text: [`See ${program} --help for all global flags.`],
    rows,
  }
}

/** ENVIRONMENT: env that backs a visible command flag, then the command `env`. */
function environmentRows(
  reg: BuiltinRegistry,
  flags: readonly FlagSpec[],
  own: readonly EnvSpec[],
): HelpModelRow[] {
  const seen = new Set<string>()
  const out: HelpModelRow[] = []
  const add = (name: string, summary: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    out.push(row(name, summary))
  }
  for (const flag of flags.filter((f) => f.hidden !== true)) {
    const backing = reg.env.filter(
      (e) => e.hidden !== true && (e.flag === flag.name || e.name === flag.env),
    )
    for (const env of backing) add(env.name, withNotes(env.summary, env.description))
    if (flag.env !== undefined && !backing.some((e) => e.name === flag.env)) {
      add(flag.env, `Same as --${flag.name}`)
    }
  }
  for (const env of own.filter((e) => e.hidden !== true)) add(env.name, env.summary)
  return out
}

/** Drop sections with nothing to show. */
function nonEmpty(section: HelpModelSection | undefined): section is HelpModelSection {
  if (section === undefined) return false
  return (
    (section.text?.length ?? 0) > 0 ||
    (section.rows?.length ?? 0) > 0 ||
    (section.groups?.length ?? 0) > 0
  )
}

/**
 * Build the command help model for `path` (spec 8.5). Hidden commands
 * render when asked by path, but a parent never lists them in COMMANDS.
 * Throws when `path` does not resolve. Aliases resolve to the canonical
 * names in `model.path`.
 */
export function buildCommandHelpModel(
  reg: BuiltinRegistry,
  path: readonly string[],
  program: HelpModelProgram = { name: reg.root.name, version: AGENT_VERSION },
): HelpModel {
  const chain = commandChain(reg, path)
  const spec = chain.at(-1)
  if (spec === undefined) throw new Error("help model: command help needs a non-empty path")
  const names = chain.map((s) => s.name)
  const flags = spec.flags ?? []
  const sections: (HelpModelSection | undefined)[] = [
    {
      id: "header",
      title: `${program.name} ${names.join(" ")}`,
      text: [spec.summary, ...(spec.description ?? [])],
    },
    { id: "usage", title: COMMAND_TITLES.usage, text: usageLines(program.name, chain) },
    { id: "arguments", title: COMMAND_TITLES.arguments, rows: (spec.args ?? []).map(argumentRow) },
    { id: "commands", title: COMMAND_TITLES.commands, rows: visibleChildren(spec).map(childRow) },
    flagsSection(reg, flags),
    globalFlagsSection(reg, program.name),
    {
      id: "environment",
      title: COMMAND_TITLES.environment,
      rows: environmentRows(reg, flags, spec.env ?? []),
    },
    {
      id: "examples",
      title: COMMAND_TITLES.examples,
      rows: (spec.examples ?? []).map((ex) =>
        row(ex.argv === "" ? program.name : `${program.name} ${ex.argv}`, ex.summary),
      ),
    },
    {
      id: "see-also",
      title: COMMAND_TITLES["see-also"],
      text:
        spec.seeAlso === undefined || spec.seeAlso.length === 0
          ? []
          : [spec.seeAlso.map((p) => `${program.name} ${p.join(" ")}`).join(", ")],
    },
  ]
  return {
    contractVersion: CLI_CONTRACT_VERSION,
    kind: "command",
    program,
    path: names,
    sections: sections.filter(nonEmpty),
  }
}

/**
 * Every visible command path, depth first in registry order. A hidden
 * command and its subtree are left out.
 */
export function visibleCommandPaths(reg: BuiltinRegistry): string[][] {
  const out: string[][] = []
  const walk = (node: CommandSpec, path: readonly string[]): void => {
    for (const child of visibleChildren(node)) {
      const next = [...path, child.name]
      out.push(next)
      walk(child, next)
    }
  }
  walk(reg.root, [])
  return out
}
