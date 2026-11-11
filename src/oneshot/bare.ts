/**
 * `--bare` (SPEC-ONESHOT R13): a fast one-shot run with the fewest plugins.
 *
 * The required-plugin rule (Q2):
 * - Provider plugins (`provider.json` packages, for `--provider` and for
 *   `--credential-name` auth) do not go through the manifest plugin loader.
 *   `bootProviderDiscovery` registers them before this rule runs, so
 *   `--bare` never removes them. Credential and auth logic live in core
 *   and in the provider plugins, not in a manifest plugin.
 * - Every manifest plugin is disabled, with these exceptions:
 *   1. A plugin that owns a tool named in `--tools` (match on the raw tool
 *      name, its aliases, or the canonical auto-prefixed name).
 *   2. A plugin that owns the `--host-mode <id>` host mode.
 *   3. A plugin named with `--enable-plugin` (an explicit user ask wins).
 *   4. A plugin that contributes a permission mode (`headless.modes`), for
 *      example `ask-mode`. The non-interactive default mode `ask` needs it.
 *      `--dry-run` / `MINIMAL_AGENT_DRY_RUN=1` count as
 *      `--enable-plugin dry-run`.
 * - `agents-md` is always disabled (no AGENTS.md), the same as
 *   `MINIMAL_AGENT_NO_AGENTS_MD=1`, even when rule 1 or 3 would keep it.
 *
 * {@link planBare} is pure. {@link readPluginManifests} is the one file
 * system read (JSON only, it never imports a plugin module).
 *
 * @module oneshot/bare
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { collectFlagValues } from "@minimal-agent/core/host/plugin-enable-resolution"
import type { ToolNamePolicy } from "@minimal-agent/core/sdk/tool-filter"

import { dryRunEnableIds } from "../startup/dry-run.ts"

/** The plugin id of the AGENTS.md injector. */
export const AGENTS_MD_PLUGIN_ID = "agents-md"

/** The parts of one manifest that the bare rule reads. */
export interface BareManifest {
  readonly id: string
  /** The display name. It gives the auto tool-name prefix. */
  readonly name?: string
  /** An explicit prefix override for tool names. */
  readonly camelName?: string
  /** Tool names this plugin contributes (raw, aliases, and canonical). */
  readonly toolNames: readonly string[]
  /** Host mode ids this plugin contributes. */
  readonly hostModeIds: readonly string[]
  /** Permission mode ids this plugin contributes (`headless.modes[].id`). */
  readonly modeIds?: readonly string[]
}

/** Inputs for {@link planBare}. */
export interface BarePlanInput {
  /** True when `--bare` is on. */
  readonly bare: boolean
  readonly manifests: readonly BareManifest[]
  /** The `--tools` / `--no-tools` policy. */
  readonly toolPolicy: ToolNamePolicy
  /** The `--host-mode <id>` value. */
  readonly hostModeId?: string | undefined
  /** The `--enable-plugin` ids. */
  readonly explicitEnable?: readonly string[]
}

/** The result of {@link planBare}. */
export interface BarePlan {
  /** Plugin ids to add to the CLI disable list. Sorted. */
  readonly disable: readonly string[]
  /** Plugin ids that stay on, with the reason. Sorted by id. */
  readonly keep: readonly { readonly id: string; readonly reason: string }[]
}

/** `--bare` in argv. */
export function readBareFlag(args: readonly string[]): boolean {
  return args.includes("--bare")
}

/** CamelCase prefix from a display name (same rule as the core loader). */
function camelOf(name: string): string {
  return name
    .split(/[\s-]+/)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join("")
}

/**
 * Build the disable list for `--bare`. When `bare` is false, the plan is
 * empty and the run is not changed.
 */
export function planBare(input: BarePlanInput): BarePlan {
  if (!input.bare) return { disable: [], keep: [] }
  const wanted =
    input.toolPolicy !== null && input.toolPolicy.kind === "allow-list"
      ? new Set(input.toolPolicy.tools)
      : new Set<string>()
  const explicit = new Set(input.explicitEnable ?? [])
  const disable = new Set<string>()
  const keep = new Map<string, string>()
  for (const m of input.manifests) {
    if (m.id === AGENTS_MD_PLUGIN_ID) {
      disable.add(m.id)
      continue
    }
    const tool = m.toolNames.find((t) => wanted.has(t))
    const mode = m.modeIds?.[0]
    if (tool !== undefined) {
      keep.set(m.id, `tool ${tool}`)
    } else if (mode !== undefined) {
      // A mode plugin always stays. Without it a non-interactive run has no
      // mode, so the read-only `ask` default does not apply and Edit/Write
      // run (review P0-1).
      keep.set(m.id, `mode ${mode}`)
    } else if (input.hostModeId !== undefined && m.hostModeIds.includes(input.hostModeId)) {
      keep.set(m.id, `host mode ${input.hostModeId}`)
    } else if (explicit.has(m.id)) {
      keep.set(m.id, "--enable-plugin")
    } else {
      disable.add(m.id)
    }
  }
  // AGENTS.md is skipped even when no manifest for it was found.
  disable.add(AGENTS_MD_PLUGIN_ID)
  for (const id of keep.keys()) disable.delete(id)
  return {
    disable: [...disable].sort(),
    keep: [...keep.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, reason]) => ({ id, reason })),
  }
}

/**
 * Read the bare-rule view of one raw manifest JSON object. Returns
 * undefined for a manifest with no string id.
 */
export function bareManifestOf(raw: unknown): BareManifest | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const m = raw as Record<string, unknown>
  if (typeof m.id !== "string" || m.id.length === 0) return undefined
  const name = typeof m.name === "string" ? m.name : m.id
  const camelName = typeof m.camelName === "string" ? m.camelName : undefined
  const prefix = camelName ?? camelOf(name)
  const headless = (m.headless ?? {}) as Record<string, unknown>
  const toolNames: string[] = []
  for (const t of Array.isArray(headless.tools) ? headless.tools : []) {
    const trigger = (t as { trigger?: { type?: unknown; tool?: Record<string, unknown> } })?.trigger
    if (trigger?.type !== "tool" || trigger.tool === undefined) continue
    const toolName = trigger.tool.name
    if (typeof toolName !== "string") continue
    toolNames.push(toolName)
    if (trigger.tool.explicitName !== true) toolNames.push(`${prefix}${toolName}`)
    const aliases = trigger.tool.aliases
    if (Array.isArray(aliases)) {
      for (const a of aliases) if (typeof a === "string") toolNames.push(a)
    }
  }
  const hostModeIds: string[] = []
  for (const h of Array.isArray(headless.hostModes) ? headless.hostModes : []) {
    const id = (h as { id?: unknown })?.id
    if (typeof id === "string") hostModeIds.push(id)
  }
  const modeIds: string[] = []
  for (const md of Array.isArray(headless.modes) ? headless.modes : []) {
    const id = (md as { id?: unknown })?.id
    if (typeof id === "string") modeIds.push(id)
  }
  return {
    id: m.id,
    name,
    ...(camelName ? { camelName } : {}),
    toolNames,
    hostModeIds,
    modeIds,
  }
}

/** Plugin roots by tier, the same shape as the core `PluginRoots`. */
export interface BareRoots {
  readonly embedded?: readonly string[]
  readonly user?: readonly string[]
  readonly project?: readonly string[]
}

/**
 * The `--bare` disable list for a run: reads the manifests only when `bare`
 * is on (no file read otherwise), then applies {@link planBare}.
 */
export function bareDisableIds(
  opts: {
    readonly bare: boolean
    readonly cliToolFilter: ToolNamePolicy
    readonly hostModeId: string | undefined
  },
  roots: BareRoots,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): readonly string[] {
  if (!opts.bare) return []
  return planBare({
    bare: true,
    manifests: readPluginManifests(roots),
    toolPolicy: opts.cliToolFilter,
    hostModeId: opts.hostModeId,
    // `--dry-run` counts as `--enable-plugin dry-run`, so `--bare --dry-run`
    // keeps the dry-run plugin.
    explicitEnable: [
      ...collectFlagValues([...args], "--enable-plugin"),
      ...dryRunEnableIds(args, env),
    ],
  }).disable
}

/**
 * Read every `manifest.json` one level under each root. JSON only. A
 * missing root or a bad manifest adds nothing.
 */
export function readPluginManifests(roots: BareRoots): BareManifest[] {
  const out: BareManifest[] = []
  const dirs = [...(roots.project ?? []), ...(roots.user ?? []), ...(roots.embedded ?? [])]
  for (const root of dirs) {
    let entries: string[]
    try {
      if (!existsSync(root) || !statSync(root).isDirectory()) continue
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(root, entry, "manifest.json")
      try {
        if (!existsSync(path)) continue
        const m = bareManifestOf(JSON.parse(readFileSync(path, "utf8")))
        if (m !== undefined) out.push(m)
      } catch {
        // A bad manifest is the loader's problem, not ours.
      }
    }
  }
  return out
}
