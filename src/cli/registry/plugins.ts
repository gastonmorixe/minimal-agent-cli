/**
 * Plugin data for help (SPEC-HELP R-11, R-12, R-19, R-22, 8.4 rows 6 and 9,
 * plan M-10).
 *
 * Help reads plugins ONLY through the core plugin catalog
 * (`buildPluginCliCatalog`): a JSON scan of each `manifest.json` that
 * applies the loader's enable overrides, platform whitelist,
 * `hostMode:stdio` permission, and host-mode collision gates. It never
 * imports a plugin module (R-18, R-22).
 *
 * This module has two parts:
 *
 * - {@link readHelpCatalog}: the one catalog read. The caller gives the
 *   roots, the config overrides, and the platform, so this module reads no
 *   env and no config file itself.
 * - Pure maps from a catalog to help model data: HOST MODES rows
 *   ({@link hostModeRows}), PLUGIN NOTES groups ({@link pluginNoteGroups}),
 *   and the host mode for `--host-mode <id> --help` ({@link findHostMode}).
 *
 * A disabled entry (a plugin that is off, or a host mode stopped by the
 * `permission` or `collision` gate) shows only with `--help --all` (R-12),
 * with the reason in a note.
 *
 * @module cli/registry/plugins
 */

import {
  buildPluginCliCatalog,
  type CatalogCliEntry,
  type CatalogCliHostMode,
  type CatalogCliOptions,
  type CatalogOverridesInput,
  type CatalogRoots,
} from "@minimal-agent/core/host/plugin-catalog"
import type {
  HelpModelGroup,
  HelpModelRow,
  HelpSectionSpec,
} from "@minimal-agent/core/plugin-api/types/cli-contract"

/** Inputs of {@link readHelpCatalog}. */
export interface HelpCatalogInput {
  /** Plugin roots, the same value the loader gets (`computePluginRoots`). */
  readonly roots: CatalogRoots
  /** Config enable overrides. Default: none. */
  readonly config?: CatalogOverridesInput["config"]
  /** `MINIMAL_AGENT_DISABLE_PLUGINS` and `MINIMAL_AGENT_ENABLE_PLUGINS`. */
  readonly env?: CatalogOverridesInput["env"]
  /**
   * The CLI override lists, the same lists the loader gets (`--disable-plugin`,
   * `--enable-plugin`, and aliases such as `--no-agents-md`).
   */
  readonly cli?: CatalogOverridesInput["cli"]
  /** The effective platform (`resolveEffectivePlatform`). Default: detected. */
  readonly platform?: CatalogCliOptions["effectivePlatform"]
}

/**
 * Read the plugin catalog for help. JSON only, no plugin module import.
 * Manifest warnings are dropped: help output stays clean, and
 * `minimal-agent plugins` is the place to inspect plugins.
 */
export function readHelpCatalog(input: HelpCatalogInput): CatalogCliEntry[] {
  return buildPluginCliCatalog(
    input.roots,
    {
      config: input.config ?? { forceDisabled: new Set(), forceEnabled: new Set() },
      ...(input.env === undefined ? {} : { env: input.env }),
      cli: input.cli ?? {},
    },
    {
      ...(input.platform === undefined ? {} : { effectivePlatform: input.platform }),
      warn: () => {},
    },
  )
}

/** Options of the catalog maps. */
export interface PluginHelpOptions {
  /** `--help --all`: also show disabled entries with their reason. */
  readonly all?: boolean
}

/**
 * Why a plugin is off: the catalog note (`cli`, `env`, `config`,
 * `manifest`, `platform`, `invalid`), or `off` when the note is empty.
 */
function pluginOffReason(entry: CatalogCliEntry): string {
  return entry.note === "" ? "off" : entry.note
}

/**
 * Why a host mode cannot run: the plugin reason when the plugin is off,
 * else the host-mode gate (`permission`, `collision`). `undefined` when the
 * host mode is usable.
 */
export function hostModeDisabledReason(
  entry: CatalogCliEntry,
  hostMode: CatalogCliHostMode,
): string | undefined {
  if (!entry.effectiveOn) return pluginOffReason(entry)
  return hostMode.disabled
}

/** `summary (note; note)`, the same note form as the built-in rows. */
function withNotes(summary: string, notes: readonly string[]): string {
  const head = summary === "" ? "(no description)" : summary
  return notes.length === 0 ? head : `${head} (${notes.join("; ")})`
}

/** The row source of a plugin row. */
function source(pluginId: string): `plugin:${string}` {
  return `plugin:${pluginId}`
}

/**
 * HOST MODES rows (8.4 row 6): one row per host mode, `id` then the
 * description and `from plugin <id>`. Plugins are in catalog order (sorted
 * by id), host modes in declared order. Without `all`, only usable host
 * modes. With `all`, a disabled host mode adds `disabled: <reason>`, with
 * `state: "disabled"` and the reason in `note`.
 */
export function hostModeRows(
  catalog: readonly CatalogCliEntry[],
  opts: PluginHelpOptions = {},
): HelpModelRow[] {
  const rows: HelpModelRow[] = []
  for (const entry of catalog) {
    for (const hostMode of entry.hostModes) {
      const reason = hostModeDisabledReason(entry, hostMode)
      if (reason !== undefined && opts.all !== true) continue
      const notes = [`from plugin ${entry.pluginId}`]
      if (reason === undefined) {
        rows.push({
          term: hostMode.id,
          summary: withNotes(hostMode.description, notes),
          source: source(entry.pluginId),
        })
        continue
      }
      rows.push({
        term: hostMode.id,
        summary: withNotes(hostMode.description, [...notes, `disabled: ${reason}`]),
        source: source(entry.pluginId),
        state: "disabled",
        note: reason,
      })
    }
  }
  return rows
}

/** The rows of one plugin help section: text paragraphs first, then the rows. */
function helpSectionRows(
  pluginId: string,
  section: HelpSectionSpec,
  reason: string | undefined,
): HelpModelRow[] {
  const pairs: [string, string][] = [
    ...(section.text ?? []).map((text): [string, string] => ["", text]),
    ...(section.rows ?? []).map((r): [string, string] => [r.term, r.summary]),
  ]
  return pairs.map(([term, summary]) => pluginRow(pluginId, term, summary, reason))
}

/** One plugin row, with `state` and `note` when `reason` is set. */
function pluginRow(
  pluginId: string,
  term: string,
  summary: string,
  reason: string | undefined,
): HelpModelRow {
  const out: HelpModelRow = { term, summary, source: source(pluginId) }
  if (reason !== undefined) {
    out.state = "disabled"
    out.note = reason
  }
  return out
}

/**
 * PLUGIN NOTES groups (8.4 row 9, R-11): one group per plugin
 * `helpSections` entry, by plugin id, then declared order. The group title
 * is the section title plus `(from plugin <id>)`. Without `all`, only
 * plugins that are on. With `all`, off plugins add their sections with
 * `disabled: <reason>` in the title, and a last `Disabled plugins` group
 * lists every off plugin with its reason (R-12), so a plugin with no help
 * sections (or an invalid manifest) still shows.
 */
export function pluginNoteGroups(
  catalog: readonly CatalogCliEntry[],
  opts: PluginHelpOptions = {},
): HelpModelGroup[] {
  const groups: HelpModelGroup[] = []
  for (const entry of catalog) {
    const reason = entry.effectiveOn ? undefined : pluginOffReason(entry)
    if (reason !== undefined && opts.all !== true) continue
    for (const section of entry.cli?.helpSections ?? []) {
      const notes = [`from plugin ${entry.pluginId}`]
      if (reason !== undefined) notes.push(`disabled: ${reason}`)
      const rows = helpSectionRows(entry.pluginId, section, reason)
      if (rows.length === 0) continue
      groups.push({ title: `${section.title} (${notes.join("; ")})`, rows })
    }
  }
  if (opts.all === true) {
    const off = catalog.filter((e) => !e.effectiveOn)
    if (off.length > 0) {
      groups.push({
        title: "Disabled plugins",
        rows: off.map((e) =>
          pluginRow(e.pluginId, e.pluginId, `disabled: ${pluginOffReason(e)}`, pluginOffReason(e)),
        ),
      })
    }
  }
  return groups
}

/** One host mode found by id, with its plugin and the disabled reason. */
export interface FoundHostMode {
  readonly entry: CatalogCliEntry
  readonly hostMode: CatalogCliHostMode
  /** Why it cannot run, or `undefined` when it is usable. */
  readonly reason: string | undefined
}

/**
 * The host mode with `id` for `--host-mode <id> --help` (R-19). A usable
 * host mode wins (the loader runs that one). Else the first disabled one in
 * catalog order, so help can say why it cannot run. `undefined` when no
 * plugin declares `id`.
 */
export function findHostMode(
  catalog: readonly CatalogCliEntry[],
  id: string,
): FoundHostMode | undefined {
  let disabled: FoundHostMode | undefined
  for (const entry of catalog) {
    for (const hostMode of entry.hostModes) {
      if (hostMode.id !== id) continue
      const reason = hostModeDisabledReason(entry, hostMode)
      if (reason === undefined) return { entry, hostMode, reason }
      disabled ??= { entry, hostMode, reason }
    }
  }
  return disabled
}

/** The ids of every usable host mode, for "did you mean" suggestions. */
export function usableHostModeIds(catalog: readonly CatalogCliEntry[]): string[] {
  return catalog.flatMap((entry) =>
    entry.hostModes
      .filter((hm) => hostModeDisabledReason(entry, hm) === undefined)
      .map((hm) => hm.id),
  )
}
