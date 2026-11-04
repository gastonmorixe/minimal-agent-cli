/**
 * Help model builder (SPEC-HELP 8.3, 8.4, 8.5, plan M-8d, M-9b).
 *
 * {@link buildHelpModel} turns the built-in registry into the contract
 * {@link HelpModel}: plain text sections, no color (R-3). The renderer
 * (`render-model.ts`) adds style. The root model follows the spec 8.4
 * section order ({@link ROOT_SECTION_ORDER}). Command help follows the spec
 * 8.5 order ({@link buildCommandHelpModel}).
 *
 * Root help is concise (R-13): a row shows the one-line `summary`, plus a
 * generated `Default:` and `Env:` sentence for a flag. `description`
 * paragraphs only show in command help.
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
  type RootSectionId,
} from "@minimal-agent/core/plugin-api/types/cli-contract"

import { type BuiltinEnvSpec, type BuiltinRegistry, childrenOf } from "../../cli/registry/index.ts"

/** Inputs of {@link buildHelpModel}. */
export interface BuildHelpModelOptions {
  /** Program name and version. Default: the root spec name and the core version. */
  readonly program?: HelpModelProgram
  /** Plugin catalog. Unused until plugin rows land (M-10, M-18). */
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

/** The separator between note clauses. A note can hold ", " itself (`one of: a, b`). */
const NOTE_SEPARATOR = "; "

/**
 * The summary plus its notes in one trailing bracket. Each note is one clause
 * (`one of: a, b`, `default: x`, `env: NAME`), so the clauses are joined with
 * "; ": a comma would make the env read like one more choice. Empty notes are
 * left out. The renderer dims the bracket.
 */
function withNotes(summary: string, notes: readonly (string | undefined)[]): string {
  const kept = notes.filter((n): n is string => n !== undefined && n !== "")
  return kept.length === 0 ? summary : `${summary} (${kept.join(NOTE_SEPARATOR)})`
}

/** A value as help text: quoted when it is empty or holds white space. */
function shownValue(value: string | number | boolean): string {
  const text = String(value)
  return text === "" || /\s/u.test(text) ? JSON.stringify(text) : text
}

/** `default: <value>`, or nothing when there is no default. */
function defaultNote(value: string | number | boolean | undefined): string | undefined {
  return value === undefined ? undefined : `default: ${shownValue(value)}`
}

/**
 * `one of: a, b, c` for a flag with `choices`, unless the value placeholder
 * already lists them (for example `<5m|1h>`).
 */
function choicesNote(spec: FlagSpec): string | undefined {
  if (spec.choices === undefined || spec.choices.length === 0) return undefined
  if (spec.valueName === spec.choices.join("|")) return undefined
  return `one of: ${spec.choices.join(", ")}`
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

/**
 * The hidden global forms of a visible global flag `x`: the `x-file` and
 * `no-x` specs (the system-prompt overrides have both). They have no row of
 * their own, so the row of `x` names them.
 */
function hiddenForms(reg: BuiltinRegistry, spec: FlagSpec): FlagSpec[] {
  const names = new Set([`${spec.name}-file`, `no-${spec.name}`])
  return reg.globalFlags.filter((f) => f.hidden === true && names.has(f.name))
}

/**
 * A root FLAGS row: the summary, then notes made from the registry, in this
 * order: the choices, the default (`FlagSpec.default`), the hidden forms, and
 * the env pointer (`FlagSpec.env`). No description (R-13).
 */
function globalFlagRow(reg: BuiltinRegistry, spec: FlagSpec): HelpModelRow {
  const forms = hiddenForms(reg, spec).map(flagTerm)
  return row(
    flagTerm(spec),
    withNotes(spec.summary, [
      choicesNote(spec),
      defaultNote(spec.default),
      forms.length === 0 ? undefined : `also ${forms.join(", ")}`,
      spec.env === undefined ? undefined : `env: ${spec.env}`,
    ]),
  )
}

/**
 * The summary with its notes, then the description paragraphs (full
 * sentences) after it, so a long row reads `Summary (notes). Text.`.
 */
function withDescription(
  summary: string,
  notes: readonly (string | undefined)[],
  description: readonly string[] | undefined,
): string {
  const head = withNotes(summary, notes)
  if (description === undefined || description.length === 0) return head
  return [`${head}.`, ...description].join(" ")
}

/**
 * A command FLAGS row: the summary, the choices and the default as notes,
 * then the description. The env shows in the ENVIRONMENT section of command
 * help.
 */
function commandFlagRow(spec: FlagSpec): HelpModelRow {
  return row(
    flagTerm(spec),
    withDescription(spec.summary, [choicesNote(spec), defaultNote(spec.default)], spec.description),
  )
}

/**
 * One env row: the bare name (item 7 of plan M-8d), then the summary, and
 * as notes the value hint (`set`), the default, and the flag pointer
 * (`EnvSpec.flag`). Command help (`full`) also shows the description.
 */
function envRow(spec: BuiltinEnvSpec, full = false): HelpModelRow {
  const notes = [
    spec.set === undefined ? undefined : `set to ${spec.set}`,
    defaultNote(spec.default),
    spec.flag === undefined ? undefined : `flag: --${spec.flag}`,
  ]
  return row(spec.name, withDescription(spec.summary, notes, full ? spec.description : undefined))
}

/** The visible children of `node`. Hidden children render by path only. */
function visibleChildren(node: CommandSpec): CommandSpec[] {
  return childrenOf(node).filter((child) => child.hidden !== true)
}

/** One arg in usage form: `<x>` required, `[<x>]` optional, `...` when variadic. */
function argUsage(arg: ArgSpec): string {
  const more = arg.variadic === true ? "..." : ""
  return arg.required === true ? `<${arg.name}>${more}` : `[<${arg.name}>${more}]`
}

/** A child row: the name plus its required args, for example `dump <sid>`. */
function childRow(child: CommandSpec): HelpModelRow {
  const required = (child.args ?? []).filter((a) => a.required === true).map(argUsage)
  return row([child.name, ...required].join(" "), child.summary)
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
 * Rows grouped by a group id, in `order`. Items with no group (or a group
 * not in `order`) come first as plain rows, so no item is lost.
 */
function grouped<T>(
  items: readonly T[],
  groupOf: (item: T) => string | undefined,
  order: readonly { readonly id: string; readonly title: string }[],
  toRow: (item: T) => HelpModelRow,
): { rows: HelpModelRow[]; groups: HelpModelGroup[] } {
  const known = new Set(order.map((g) => g.id))
  const rows = items.filter((i) => !known.has(groupOf(i) ?? "")).map(toRow)
  const groups = order
    .map((g) => ({ title: g.title, rows: items.filter((i) => groupOf(i) === g.id).map(toRow) }))
    .filter((g) => g.rows.length > 0)
  return { rows, groups }
}

// ---------------------------------------------------------------------------
// Root help (SPEC-HELP 8.4, plan M-8d)
// ---------------------------------------------------------------------------

/**
 * Root help section ids in the spec 8.4 order (R-8). `plugin-commands` and
 * `host-modes` stay empty until plugin rows land (M-10, M-18), so the
 * builder leaves them out.
 */
export const ROOT_SECTION_ORDER = [
  "header",
  "usage",
  "examples",
  "commands",
  "plugin-commands",
  "host-modes",
  "flags",
  "environment",
  "plugin-notes",
  "learn-more",
] as const satisfies readonly RootSectionId[]

/** Section titles of root help (upper case, as in the spec 8.6 mock). */
const ROOT_TITLES: Record<Exclude<RootSectionId, "header">, string> = {
  usage: "USAGE",
  examples: "EXAMPLES",
  commands: "COMMANDS",
  "plugin-commands": "PLUGIN COMMANDS",
  "host-modes": "HOST MODES",
  flags: "FLAGS",
  environment: "ENVIRONMENT",
  "plugin-notes": "PLUGIN NOTES",
  "learn-more": "LEARN MORE",
}

/** The project URL. It shows in LEARN MORE. */
export const PROJECT_URL = "github.com/gastonmorixe/minimal-agent"

/**
 * Static PLUGIN NOTES (item 9 of plan M-8d). Plugin `helpSections` from the
 * catalog replace them in M-10 (R-11).
 */
const PLUGIN_NOTES: {
  readonly text: string
  readonly rows: readonly (readonly [string, string])[]
} = {
  text: "Enable and disable precedence: CLI → env → config → manifest.",
  rows: [
    ["List", "minimal-agent plugins list"],
    ["One-shot disable", 'minimal-agent --disable-plugin web-search -p "…"'],
    ["Disable many", "minimal-agent --disable-plugin web-search,memory"],
    ["One-shot enable", "minimal-agent --enable-plugin interleave-thinking"],
    ["Persistent", '{ "plugins": { "<id>": { "enabled": false } } }'],
    ["Opt in", '{ "plugins": { "<id>": { "enabled": true } } } (for plugins shipped disabled)'],
    ["Built-in", "ask-mode, config, diff-view, env-info, file-lock,"],
    ["", "history, memory, model-info, quota-status, schedule,"],
    ["", "session-info, sub-agents, tasks, usage, web-search"],
    [
      "Disabled",
      "interleave-thinking, security, minimal-agent-cloud (opt in to use, see Opt in above)",
    ],
  ],
}

/** Static LEARN MORE rows: docs paths. */
const DOCS: readonly (readonly [string, string])[] = [
  ["CHANGELOG.md", "CLI release notes, newest first (minimal-agent-cli repo)"],
  ["docs/tui/", "Terminal renderer architecture (compositor, live area, editor)"],
  ["core docs/CHANGELOG.md", "Core release notes (minimal-agent-core repo)"],
  ["core docs/network/", "HTTP transport, retry, and wire-capture notes"],
  ["core docs/sub-agents-prompt.md", "How the sub-agents system prompt composes"],
  ["core docs/changes/", "Per-change write-ups, dated"],
]

/** Root EXAMPLES: `minimal-agent <argv>`, with no `$` prompt (spec 8.6 mock). */
function rootExampleRows(reg: BuiltinRegistry, program: HelpModelProgram): HelpModelRow[] {
  return (reg.root.examples ?? []).map((ex) =>
    row(ex.argv === "" ? program.name : `${program.name} ${ex.argv}`, ex.summary),
  )
}

/** COMMANDS: one row per visible top-level command, grouped by root group. */
function rootCommandsSection(reg: BuiltinRegistry): HelpModelSection {
  const { rows, groups } = grouped(
    visibleChildren(reg.root),
    (spec) => spec.group,
    reg.rootGroups,
    childRow,
  )
  return { id: "commands", title: ROOT_TITLES.commands, rows, groups }
}

/** FLAGS: every visible global flag, grouped by `FlagSpec.group` in `flagGroups` order. */
function rootFlagsSection(reg: BuiltinRegistry): HelpModelSection {
  const order = reg.flagGroups.map((g) => ({
    id: g.id,
    title: g.note === undefined ? g.title : `${g.title} (${g.note})`,
  }))
  const visible = reg.globalFlags.filter((f) => f.hidden !== true)
  const { rows, groups } = grouped(
    visible,
    (f) => f.group,
    order,
    (f) => globalFlagRow(reg, f),
  )
  return { id: "flags", title: ROOT_TITLES.flags, rows, groups }
}

/** The root model in the spec 8.4 layout. Empty sections are left out. */
function buildRootModel(reg: BuiltinRegistry, program: HelpModelProgram): HelpModel {
  const sections: (HelpModelSection | undefined)[] = [
    { id: "header", title: `${program.name} v${program.version}`, text: [reg.root.summary] },
    {
      id: "usage",
      title: ROOT_TITLES.usage,
      text: (reg.root.usage ?? []).map((u) => `${program.name} ${u}`),
    },
    { id: "examples", title: ROOT_TITLES.examples, rows: rootExampleRows(reg, program) },
    rootCommandsSection(reg),
    rootFlagsSection(reg),
    {
      id: "environment",
      title: ROOT_TITLES.environment,
      rows: reg.env.filter((e) => e.hidden !== true).map((e) => envRow(e)),
    },
    {
      id: "plugin-notes",
      title: ROOT_TITLES["plugin-notes"],
      text: [PLUGIN_NOTES.text],
      rows: PLUGIN_NOTES.rows.map(([term, summary]) => row(term, summary)),
    },
    {
      id: "learn-more",
      title: ROOT_TITLES["learn-more"],
      text: [`Use ${program.name} help <command> for command help.`, PROJECT_URL],
      rows: DOCS.map(([term, summary]) => row(term, summary)),
    },
  ]
  return {
    contractVersion: CLI_CONTRACT_VERSION,
    kind: "root",
    program,
    path: [],
    sections: sections.filter(nonEmpty),
  }
}

/**
 * Build a help model from the registry. An empty or absent `opts.path`
 * gives the root model (spec 8.4). A non-empty path gives the command model
 * ({@link buildCommandHelpModel}). `opts.catalog` is accepted and unused
 * until plugin rows land (M-10, M-18).
 */
export function buildHelpModel(reg: BuiltinRegistry, opts: BuildHelpModelOptions = {}): HelpModel {
  const program = opts.program ?? { name: reg.root.name, version: AGENT_VERSION }
  if (opts.path !== undefined && opts.path.length > 0) {
    return buildCommandHelpModel(reg, opts.path, program)
  }
  return buildRootModel(reg, program)
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
  const choices = arg.choices === undefined ? undefined : `one of: ${arg.choices.join(", ")}`
  return row(arg.name, withNotes(arg.summary, [choices]))
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
  if (ids.length < 2) return { id: "flags", title, rows: visible.map(commandFlagRow) }
  const rank = (id: string): number => {
    const i = reg.flagGroups.findIndex((g) => g.id === id)
    return i < 0 ? reg.flagGroups.length : i
  }
  const groups: HelpModelGroup[] = ids
    .toSorted((a, b) => rank(a) - rank(b))
    .map((id) => ({
      title: reg.flagGroups.find((g) => g.id === id)?.title ?? id,
      rows: visible.filter((f) => f.group === id).map(commandFlagRow),
    }))
  const plain = visible.filter((f) => f.group === undefined).map(commandFlagRow)
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
  const add = (r: HelpModelRow): void => {
    if (seen.has(r.term)) return
    seen.add(r.term)
    out.push(r)
  }
  for (const flag of flags.filter((f) => f.hidden !== true)) {
    const backing = reg.env.filter(
      (e) => e.hidden !== true && (e.flag === flag.name || e.name === flag.env),
    )
    for (const env of backing) add(envRow(env, true))
    if (flag.env !== undefined && !backing.some((e) => e.name === flag.env)) {
      add(row(flag.env, `Same as --${flag.name}`))
    }
  }
  for (const env of own.filter((e) => e.hidden !== true)) add(row(env.name, env.summary))
  return out
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
