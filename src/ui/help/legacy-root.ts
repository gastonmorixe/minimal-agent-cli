/**
 * Legacy root help adapter (SPEC-HELP plan M-8c, 2.4). TEMPORARY: M-8d
 * deletes this file when root help moves to the spec 8.4 layout.
 *
 * Two parts:
 *   - Layout data of today's root help that the registry does not hold:
 *     the legacy section titles, the Options row order, the command and
 *     command-flag rows of the Auth and Info sections, the static Plugins
 *     and Docs rows, and the closed list of term overrides
 *     ({@link LEGACY_TERM_OVERRIDES}). `ui/help/model.ts` reads this data
 *     to build the root {@link HelpModel}.
 *   - {@link renderLegacyRoot}: draws a root HelpModel in today's layout
 *     through the M-7 renderer. With no color the bytes equal the root help
 *     before M-8c (the M-2 snapshot pins them).
 *
 * The model is plain text (R-3). Color comes from `ui/help/style.ts` here,
 * at render time.
 *
 * @module ui/help/legacy-root
 */

import type {
  HelpModel,
  HelpModelRow,
  HelpModelSection,
} from "@minimal-agent/core/plugin-api/types/cli-contract"

import { c } from "../style/ansi.ts"
import { type HelpRow, type HelpSection, renderHelpSections, wrapHelpText } from "./render.ts"
import { styleSummary, styleTerm, styleTitle } from "./style.ts"

/**
 * The closed list of legacy term overrides (plan 2.4). Each one is a term
 * string that the spec rules do not make, never a summary. The list only
 * shrinks: `model.test.ts` pins its size.
 */
export const LEGACY_TERM_OVERRIDES = {
  /** 1. The stdin example shows the pipe, not the bare `-` argv. */
  stdinExample: { argv: "-", term: '$ echo "summarize stdin" | minimal-agent -' },
  /** 2. The help row in Info: the command and both flag forms on one term. */
  helpRow: { flag: "help", term: "help, -h, --help" },
  /** 3. An env row with a value hint shows `NAME=<set>`, for example `DEBUG=1`. */
  envValueSuffix: { separator: "=" },
  /**
   * 4. One wildcard env row stands for the hidden system-prompt env names
   * (every name that starts with one of `covers`).
   */
  envWildcard: {
    name: "MINIMAL_AGENT_SYSTEM_*",
    covers: ["MINIMAL_AGENT_SYSTEM_", "MINIMAL_AGENT_PROVIDER_SYSTEM_PREAMBLE"],
  },
} as const

/** The URL line of the root header. */
export const LEGACY_URL = "github.com/gastonmorixe/minimal-agent"

/** The hint line between the command map and the flags. */
export const LEGACY_HINT = "Every command also accepts --help. Flags win over a positional prompt."

/** Legacy section and group titles. A ` (note)` tail renders dim. */
export const LEGACY_TITLES = {
  examples: "Start here",
  commands: "Command map",
  options: "Options",
  auth: "Auth (provider-owned auth flows, flags remain legacy aliases)",
  info: "Info (subcommands are preferred, flags and aliases stay supported)",
  environment: "Env",
  pluginNotes: "Plugins (enable/disable precedence: CLI → env → config → manifest)",
  learnMore: "Docs",
} as const

/**
 * Global flag names in the legacy Options order. A visible global flag that
 * is not in this list, not in the system-prompt group, and not the help
 * flag goes after these rows, so no flag is lost.
 */
export const LEGACY_OPTIONS_ORDER: readonly string[] = [
  "model",
  "provider",
  "endpoint",
  "format",
  "auth-type",
  "api-key",
  "auth-header",
  "provider-model",
  "effort-levels",
  "effort",
  "fast",
  "thinking-display",
  "cache-ttl",
  "formatter",
  "formatter-args",
  "spinner",
  "prompt",
  "output-format",
  "diagnostics",
  "output-schema",
  "mode",
  "tools",
  "no-tools",
  "disable-plugin",
  "enable-plugin",
  "no-agents-md",
  "header",
  "session-id",
  "host-mode",
  "debug",
  "verbose",
  "skip-quota",
  "show-hidden-chars",
  "no-color",
  "credential-name",
  "service-tier",
  "platform",
]

/** The FlagSpec.group of the legacy "System prompt" group. */
export const LEGACY_SYSTEM_PROMPT_GROUP = "system-prompt"

/** One row of the legacy Auth and Info sections. */
export type LegacyItem =
  /** A command row: term from `usage[0]`. */
  | { readonly command: readonly string[] }
  /** A command flag row: the flag `name` of the command at `path`. */
  | { readonly path: readonly string[]; readonly flag: string }
  /** The help row ({@link LEGACY_TERM_OVERRIDES} `helpRow`). */
  | { readonly helpRow: true }

/** Rows of the legacy Auth section, in order. */
export const LEGACY_AUTH_ITEMS: readonly LegacyItem[] = [
  { command: ["provider", "login"] },
  { command: ["provider", "logout"] },
  { command: ["auth-status"] },
  { command: ["auth-status", "refresh"] },
  { command: ["auth-status", "refresh-all"] },
  { command: ["auth-status", "plan"] },
  { command: ["auth-status", "prune"] },
  { path: ["login"], flag: "auth-method" },
  { path: ["login"], flag: "email" },
  { path: ["login"], flag: "name" },
]

/** Rows of the legacy Info section, in order. */
export const LEGACY_INFO_ITEMS: readonly LegacyItem[] = [
  { command: ["providers"] },
  { command: ["providers", "models"] },
  { command: ["providers", "models-live"] },
  { path: ["providers", "models"], flag: "print-format" },
  { command: ["plugins"] },
  { command: ["flags"] },
  { command: ["spinners"] },
  { command: ["sessions"] },
  { command: ["sessions", "dump"] },
  { command: ["usage"] },
  { command: ["resume"] },
  { command: ["resume-same"] },
  { helpRow: true },
]

/** Static rows of the Plugins notes. Plugin rows from the catalog land in M-10. */
export const LEGACY_PLUGIN_NOTES: readonly (readonly [string, string])[] = [
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
]

/** Static rows of the Docs section. */
export const LEGACY_DOCS: readonly (readonly [string, string])[] = [
  ["CHANGELOG.md", "CLI release notes, newest first (minimal-agent-cli repo)"],
  ["docs/tui/", "Terminal renderer architecture (compositor, live area, editor)"],
  ["core docs/CHANGELOG.md", "Core release notes (minimal-agent-core repo)"],
  ["core docs/network/", "HTTP transport, retry, and wire-capture notes"],
  ["core docs/sub-agents-prompt.md", "How the sub-agents system prompt composes"],
  ["core docs/changes/", "Per-change write-ups, dated"],
]

/** Layout and color of {@link renderLegacyRoot}. */
export interface LegacyRenderOptions {
  /** Wrap width in cells. Omit for no wrapping. */
  readonly width?: number
  /** `false` makes the renderer strip every SGR. Default `true`. */
  readonly color?: boolean
}

type RowStyle = (row: HelpModelRow) => HelpRow

const plainTermDimSummary: RowStyle = (row) => ({
  term: styleTerm(row.term),
  summary: c.dim(row.summary),
})
const noteRow: RowStyle = (row) => ({
  term: styleTerm(row.term),
  summary: styleSummary(row.summary),
})
const dimRow: RowStyle = (row) => ({
  term: row.term === "" ? "" : c.dim(row.term),
  summary: c.dim(row.summary),
})
const docRow: RowStyle = (row) => ({ term: c.dim(row.term), summary: row.summary })

/** The row style of each section id. */
const ROW_STYLE: Partial<Record<HelpModelSection["id"], RowStyle>> = {
  examples: plainTermDimSummary,
  commands: plainTermDimSummary,
  flags: noteRow,
  environment: noteRow,
  "plugin-notes": dimRow,
  "learn-more": docRow,
}

function toSection(title: string, rows: readonly HelpModelRow[], style: RowStyle): HelpSection {
  return { title: styleTitle(title), rows: rows.map(style) }
}

/** The renderer sections of one model section: its rows, or one per group. */
function sectionsOf(section: HelpModelSection): HelpSection[] {
  const style = ROW_STYLE[section.id] ?? noteRow
  const out: HelpSection[] = []
  if (section.rows !== undefined) out.push(toSection(section.title, section.rows, style))
  for (const group of section.groups ?? []) out.push(toSection(group.title, group.rows, style))
  return out
}

/** The header title: program name bold cyan, version dim. */
function styleHeaderTitle(title: string): string {
  const at = title.indexOf(" ")
  if (at < 0) return c.bold(c.cyan(title))
  return `${c.bold(c.cyan(title.slice(0, at)))} ${c.dim(title.slice(at + 1))}`
}

/**
 * Render a root {@link HelpModel} in the legacy layout: a blank line, the
 * header, a blank line, the examples and command map, a blank line, the
 * flags text (the hint), a blank line, then the flag groups, environment,
 * plugin notes, and docs.
 */
export function renderLegacyRoot(model: HelpModel, opts: LegacyRenderOptions = {}): string[] {
  const color = opts.color !== false
  const width = opts.width
  const text = (line: string): string[] => wrapHelpText(line, { indent: 2, width, color })
  const sections = (list: readonly HelpModelSection[]): string[] =>
    renderHelpSections(list.flatMap(sectionsOf), { width, color })
  const byId = (id: HelpModelSection["id"]): HelpModelSection[] =>
    model.sections.filter((s) => s.id === id)

  const header = byId("header")[0]
  const headerText = header?.text ?? []
  const flagsText = byId("flags").flatMap((s) => s.text ?? [])
  return [
    "",
    ...(header === undefined ? [] : text(styleHeaderTitle(header.title))),
    ...headerText.flatMap((line, i) =>
      text(i === 0 ? c.faintWhite(line) : c.faintWhite(c.italic(line))),
    ),
    "",
    ...sections([...byId("examples"), ...byId("commands")]),
    "",
    ...flagsText.flatMap((line) => text(c.dim(line))),
    "",
    ...sections([
      ...byId("flags"),
      ...byId("environment"),
      ...byId("plugin-notes"),
      ...byId("learn-more"),
    ]),
  ]
}
