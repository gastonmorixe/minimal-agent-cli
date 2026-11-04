/**
 * Help model builder (SPEC-HELP 8.3, plan M-8c, 2.4).
 *
 * {@link buildHelpModel} turns the built-in registry into the contract
 * {@link HelpModel}: plain text sections, no color (R-3). The renderer adds
 * style. In M-8c the root model keeps today's root help layout through the
 * temporary data in `legacy-root.ts`, so root help stays byte-identical.
 * M-8d moves the root model to the spec 8.4 layout. M-9b adds command help.
 *
 * Pure: no I/O, no handler import.
 *
 * @module ui/help/model
 */

import { AGENT_VERSION } from "@minimal-agent/core/host/build-info"
import {
  type CatalogCliEntry,
  CLI_CONTRACT_VERSION,
  type CommandSpec,
  type FlagSpec,
  type HelpModel,
  type HelpModelGroup,
  type HelpModelProgram,
  type HelpModelRow,
  type HelpModelSection,
} from "@minimal-agent/core/plugin-api/types/cli-contract"

import { type BuiltinEnvSpec, type BuiltinRegistry, findCommand } from "../../cli/registry/index.ts"
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
 * Build the root help model from the registry. `opts.catalog` is accepted
 * and unused until plugin rows land (M-10, M-18).
 */
export function buildHelpModel(reg: BuiltinRegistry, opts: BuildHelpModelOptions = {}): HelpModel {
  const program = opts.program ?? { name: reg.root.name, version: AGENT_VERSION }
  return buildLegacyRootModel(reg, program)
}
