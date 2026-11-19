/**
 * `sessions [<query>]`: the list of saved sessions.
 *
 * Reads the core session catalog (`listSessions`, index only, plus lazy
 * summaries for the rows of the page), builds a {@link SessionsListView},
 * and returns the rendered rows. It never writes to a stream: the startup
 * layer writes the result (plan item 30).
 *
 * @module commands/sessions
 */

import { resolve } from "node:path"
import { modelShortLabel } from "@minimal-agent/core/host/model-label"
import {
  type BackfillLineageResult,
  backfillLineage,
  type ListSessionsOptions,
  type ListSessionsResult,
  listSessions,
  type SessionCatalogRow,
} from "@minimal-agent/core/host/session-index"
import { defaultSessionsDir } from "@minimal-agent/core/host-kit/session-store"
import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"
import {
  renderSessionsList,
  type SessionListEntry,
  type SessionListItem,
  type SessionListStatus,
  type SessionsListView,
} from "../ui/chrome/sessions-command.ts"
import { c } from "../ui/style/ansi.ts"

/** Default lead sessions per page. */
export const DEFAULT_SESSIONS_LIMIT = 30

/** Largest `--limit` (review m6). A larger value is clamped to this. */
export const MAX_SESSIONS_LIMIT = 1000

/** Version of the `--json` shape (review m1). */
export const SESSIONS_JSON_VERSION = 1

/** How sub-agent sessions show. */
export type SubagentsMode = "none" | "tree" | "flat"

/** The parsed `sessions` flags. */
export interface SessionsFlags {
  query?: string
  limit: number
  /** 1-based page. */
  page: number
  all: boolean
  /** `--since` as epoch ms. */
  sinceMs?: number
  /** Absolute cwd filter (`.` is the process cwd). */
  cwd?: string
  model?: string
  subagents: SubagentsMode
  json: boolean
  /** `--backfill-lineage`: link old sub-agent sessions to their lead. */
  backfillLineage?: boolean
  /** `--dry-run` with `--backfill-lineage`: count only, write nothing. */
  dryRun?: boolean
}

/** Flag parse result: the flags, or an error text (exit 2). */
export type SessionsFlagsResult = { ok: true; flags: SessionsFlags } | { ok: false; error: string }

const SINCE_UNITS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
}

/**
 * Parse `--since`: a relative age (`30m`, `12h`, `2d`, `1w`) or a date
 * (`2026-11-18`, an ISO time). Returns epoch ms, or `undefined` when bad.
 */
export function parseSince(text: string, now: number = Date.now()): number | undefined {
  const t = text.trim()
  const rel = /^(\d+)\s*([mhdw])$/u.exec(t)
  if (rel) {
    const n = positiveInt(rel[1])
    return n === undefined ? undefined : now - n * (SINCE_UNITS[rel[2]] ?? 0)
  }
  if (!/^\d{4}-\d{2}-\d{2}/u.test(t)) return undefined
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? ms : undefined
}

function positiveInt(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d+$/u.test(text.trim())) return undefined
  const n = Number.parseInt(text, 10)
  return n > 0 ? n : undefined
}

/**
 * The stderr line for a flag error. SGR only when `color` is true (the host
 * resolves it for stderr: TTY, `NO_COLOR`, `--no-color`; review m5).
 */
export function sessionsErrorLine(error: string, color: boolean): string {
  return `  ${color ? c.boldRed("error") : "error"} ${error}`
}

/** Inputs of {@link parseSessionsFlags}. */
export interface ParseSessionsFlagsInput {
  /** Normalized argv (after `normalizeArgs`). */
  args: readonly string[]
  /** Positional query (`sessions <query>`). */
  query?: string
  /** `--flag value` / `--flag=value` reader. */
  readFlagValue: (name: string) => string | undefined
  cwd: string
  now?: number
  /**
   * Long flags that take the next token as their value (the registry arity
   * table). A token after one of them is a value, not a flag (review m4).
   * Default: {@link SESSIONS_VALUE_FLAGS}.
   */
  valueFlags?: ReadonlySet<string>
}

/** The value flags that the list reads. The host passes the full registry set. */
export const SESSIONS_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--limit",
  "--page",
  "--since",
  "--cwd",
  "--subagents",
  "--model",
])

/**
 * The long flags present in argv. A token that is the value of a value flag
 * (`--cwd --json`: `--json` is the value) is not a flag (review m4).
 */
export function presentFlags(
  args: readonly string[],
  valueFlags: ReadonlySet<string> = SESSIONS_VALUE_FLAGS,
): Set<string> {
  const found = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ""
    if (a === "--") break
    if (!a.startsWith("--")) continue
    const eq = a.indexOf("=")
    const name = eq === -1 ? a : a.slice(0, eq)
    found.add(name)
    if (eq === -1 && valueFlags.has(name)) i += 1
  }
  return found
}

/** Parse the `sessions` list flags. Pure. */
export function parseSessionsFlags(input: ParseSessionsFlagsInput): SessionsFlagsResult {
  const { args, readFlagValue } = input
  const flagsSeen = presentFlags(args, input.valueFlags)
  const has = (flag: string): boolean => flagsSeen.has(flag)

  let limit = DEFAULT_SESSIONS_LIMIT
  if (has("--limit")) {
    const n = positiveInt(readFlagValue("--limit"))
    if (n === undefined) return { ok: false, error: "--limit needs a positive whole number" }
    limit = Math.min(n, MAX_SESSIONS_LIMIT)
  }
  let page = 1
  if (has("--page")) {
    const n = positiveInt(readFlagValue("--page"))
    if (n === undefined) return { ok: false, error: "--page needs a positive whole number" }
    page = n
  }
  let sinceMs: number | undefined
  if (has("--since")) {
    const raw = readFlagValue("--since")
    sinceMs = raw === undefined ? undefined : parseSince(raw, input.now)
    if (sinceMs === undefined) {
      return { ok: false, error: "--since needs an age (30m, 12h, 2d, 1w) or a date (2026-11-18)" }
    }
  }
  let cwd: string | undefined
  if (has("--cwd")) {
    const raw = readFlagValue("--cwd")
    if (raw === undefined || raw.startsWith("-")) {
      return { ok: false, error: "--cwd needs a directory (use . for this directory)" }
    }
    cwd = resolve(input.cwd, raw)
  }
  let model: string | undefined
  if (has("--model")) {
    const raw = readFlagValue("--model")
    if (raw === undefined || raw.startsWith("-")) {
      return { ok: false, error: "--model needs a text to match" }
    }
    model = raw
  }
  let subagents: SubagentsMode = "tree"
  if (has("--subagents")) {
    const raw = readFlagValue("--subagents")
    if (raw !== "none" && raw !== "tree" && raw !== "flat") {
      return { ok: false, error: "--subagents needs none, tree, or flat" }
    }
    subagents = raw
  }
  const query = input.query?.trim()
  return {
    ok: true,
    flags: {
      ...(query ? { query } : {}),
      limit,
      page,
      all: has("--all"),
      ...(sinceMs === undefined ? {} : { sinceMs }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(model === undefined ? {} : { model }),
      subagents,
      json: has("--json"),
      ...(has("--backfill-lineage") ? { backfillLineage: true } : {}),
      ...(has("--dry-run") ? { dryRun: true } : {}),
    },
  }
}

/**
 * The row status. Only the known summary values map to a glyph; any other
 * status text (a newer core can add values) is `unknown` (`·`).
 */
export function statusOf(row: Pick<SessionCatalogRow, "live" | "summary">): SessionListStatus {
  if (row.live) return "live"
  const status: string | undefined = row.summary?.status
  if (status === "done" || status === "failed" || status === "live") return status
  return "unknown"
}

/** `vendor/claude-opus-4-7[1m]-20251001` → `opus-4-7`: a pure short label. */
export function plainModelLabel(modelId: string): string {
  const out = modelId
    .trim()
    .replace(/^.*\//u, "")
    .replace(/\[[^\]]*\]$/u, "")
    .replace(/-\d{8}$/u, "")
    .replace(/^claude-/u, "")
  return out.length > 0 ? out : modelId
}

/**
 * Short model label for the list and the detail header (review D4): the core
 * `modelShortLabel` (provider plugins give `opus-5.5`) when it is shorter than
 * the id and not longer than {@link plainModelLabel}, else the plain label.
 * The full id stays in `--json` and in the `--model` filter.
 */
export function sessionModelLabel(modelId: string): string {
  if (!modelId) return ""
  const plain = plainModelLabel(modelId)
  let core = ""
  try {
    core = modelShortLabel(modelId)
  } catch {
    core = ""
  }
  const w = displayWidth
  if (core && w(core) < w(modelId) && w(core) <= w(plain)) return core
  return plain
}

/**
 * True for a sub-agent row with 0 user turns (review D3 part 1). The list
 * and the detail view hide it unless `--all`. Core may filter it too; this
 * keeps the CLI correct with the current core.
 */
export function isEmptyChild(row: Pick<SessionCatalogRow, "summary">): boolean {
  return row.summary?.turns === 0
}

/** The children to show: all with `--all`, else not the empty ones. */
export function visibleChildren(
  children: readonly SessionCatalogRow[],
  all: boolean,
): SessionCatalogRow[] {
  return all ? [...children] : children.filter((child) => !isEmptyChild(child))
}

/** Sub-agent label: `A6 reviewer` when both are known, else the role or id. */
export function subagentLabel(row: Pick<SessionCatalogRow, "agentId" | "role">): string {
  if (row.agentId && row.role) return `${row.agentId} ${row.role}`
  return row.role ?? row.agentId ?? "sub-agent"
}

/** One catalog row as a list item. */
export function toListItem(row: SessionCatalogRow, now: number): SessionListItem {
  const createdAtMs = Date.parse(row.createdAt)
  const s = row.summary
  const endMs = row.live ? now : s ? Date.parse(s.endedAt) : Number.NaN
  const durationMs = endMs - createdAtMs
  const subagent = row.leadSid !== undefined
  return {
    sid: row.sid,
    createdAtMs,
    ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
    // SPEC §8: user > ai > derived (core row title), then the first real prompt.
    title: row.title ?? s?.title ?? "",
    ...(row.title !== undefined && row.titleSource ? { titleSource: row.titleSource } : {}),
    ...(s?.title === undefined ? {} : { prompt: s.title }),
    ...(s ? { tokens: s.tokens, estimated: s.estimated } : {}),
    ...(s?.costUsd === undefined ? {} : { costUsd: s.costUsd }),
    model: sessionModelLabel(row.model),
    status: statusOf(row),
    ...(subagent ? { subagent, role: subagentLabel(row) } : {}),
    ...(row.hiddenReason ? { hiddenReason: row.hiddenReason } : {}),
    ...(row.forkOf ? { fork: true } : {}),
  }
}

/** Inputs of {@link buildSessionsView}. */
export interface BuildSessionsViewInput {
  result: ListSessionsResult
  flags: SessionsFlags
  sessionsDir: string
  now: number
}

const byTime = (a: SessionListItem, b: SessionListItem): number => a.createdAtMs - b.createdAtMs

/**
 * One catalog row as a list item with its sub-agent subtree (the catalog
 * gives children recursively, depth up to 8). Empty sub-agents are left out
 * unless `all`. Children are oldest first.
 */
export function toTreeItem(row: SessionCatalogRow, now: number, all: boolean): SessionListItem {
  const item = toListItem(row, now)
  const kids = visibleChildren(row.children, all)
    .map((child) => toTreeItem(child, now, all))
    .sort(byTime)
  return kids.length > 0 ? { ...item, children: kids } : item
}

/** The sub-agent rows below `row` in depth-first order (for `--subagents flat`). */
function flatDescendants(row: SessionCatalogRow, all: boolean): SessionCatalogRow[] {
  const out: SessionCatalogRow[] = []
  for (const child of visibleChildren(row.children, all)) {
    out.push(child, ...flatDescendants(child, all))
  }
  return out
}

/**
 * Build the list view from one catalog page. The catalog gives the rows
 * newest first; the view is oldest first (newest last). Orphan sub-agent
 * rows (only with `--all`) group under one `(lead <sid8>)` entry per lead.
 */
export function buildSessionsView(input: BuildSessionsViewInput): SessionsListView {
  const { result, flags, now } = input
  const rows = [...result.rows].reverse()
  const entries: SessionListEntry[] = []
  const orphanGroups = new Map<string, Extract<SessionListEntry, { kind: "orphans" }>>()
  // The catalog `total` counts the top-level rows (orphan rows too with
  // --all), so `shown` counts the same rows (review m2).
  const shown = rows.length
  let subagentRows = 0
  for (const row of rows) {
    const item = toTreeItem(row, now, flags.all)
    const orphan = row.leadSid !== undefined
    if (flags.subagents === "none") {
      if (!orphan) entries.push({ kind: "session", item: toListItem(row, now), children: [] })
      continue
    }
    if (flags.subagents === "flat") {
      entries.push({ kind: "session", item: toListItem(row, now), children: [] })
      for (const child of flatDescendants(row, flags.all)) {
        entries.push({ kind: "session", item: toListItem(child, now), children: [] })
        subagentRows += 1
      }
      continue
    }
    if (orphan && row.leadSid !== undefined) {
      const group = orphanGroups.get(row.leadSid)
      if (group) group.children.push(item)
      else {
        const created: Extract<SessionListEntry, { kind: "orphans" }> = {
          kind: "orphans",
          leadSid: row.leadSid,
          children: [item],
        }
        orphanGroups.set(row.leadSid, created)
        entries.push(created)
      }
      continue
    }
    const { children = [], ...lead } = item
    entries.push({ kind: "session", item: lead, children })
  }
  if (flags.subagents === "flat") {
    entries.sort((a, b) =>
      a.kind === "session" && b.kind === "session" ? byTime(a.item, b.item) : 0,
    )
  }
  for (const group of orphanGroups.values()) group.children.sort(byTime)
  return {
    entries,
    shown,
    ...(flags.subagents === "flat" ? { subagentRows } : {}),
    total: result.total,
    hiddenCount: result.hiddenCount,
    ...(result.unknownCount > 0 ? { unknownCount: result.unknownCount } : {}),
    showAll: flags.all,
    page: flags.page,
    limit: flags.limit,
    filtered:
      flags.query !== undefined ||
      flags.sinceMs !== undefined ||
      flags.cwd !== undefined ||
      flags.model !== undefined,
    sessionsDir: input.sessionsDir,
  }
}

/** The catalog options for the flags. */
export function catalogOptions(flags: SessionsFlags): ListSessionsOptions {
  return {
    limit: flags.limit,
    page: flags.page - 1,
    ...(flags.sinceMs === undefined ? {} : { since: flags.sinceMs }),
    ...(flags.cwd === undefined ? {} : { cwd: flags.cwd }),
    ...(flags.model === undefined ? {} : { model: flags.model }),
    ...(flags.query === undefined ? {} : { query: flags.query }),
    includeHidden: flags.all,
  }
}

/** A catalog row in `--json`, with the title fields (SPEC §9.3). */
export type SessionsJsonRow = Omit<SessionCatalogRow, "children"> & {
  /** The shown title: user, then ai, then derived, then the first real prompt. */
  title: string
  /** The first real prompt (`summary.title`), when known. */
  prompt?: string
  children: SessionsJsonRow[]
}

/**
 * One catalog row (and its children) for `--json`: the raw row plus `title`
 * (the shown title), `titleSource` (only for a saved title), and `prompt`.
 */
export function toJsonRow(row: SessionCatalogRow): SessionsJsonRow {
  const prompt = row.summary?.title
  return {
    ...row,
    title: row.title ?? prompt ?? "",
    ...(prompt === undefined ? {} : { prompt }),
    children: row.children.map(toJsonRow),
  }
}

/**
 * The `--json` text (review m1): `version`, `order: "newest-last"` (the same
 * order as the table), and the raw catalog rows with their `children` and
 * full model ids, plus `title`, `titleSource`, and `prompt` (SPEC §9.3).
 */
export function sessionsJson(result: ListSessionsResult, flags: SessionsFlags): string {
  const json = {
    version: SESSIONS_JSON_VERSION,
    order: "newest-last",
    total: result.total,
    hiddenCount: result.hiddenCount,
    // Above 0: `total` is an upper bound and `hiddenCount` a lower bound
    // (P4c m1; the table shows `about M` / `≥K`).
    unknownCount: result.unknownCount,
    page: flags.page,
    limit: flags.limit,
    rows: [...result.rows].reverse().map(toJsonRow),
  }
  return JSON.stringify(json, null, 2)
}

/** Options of {@link runSessionsCommand}. The host reads width and color once. */
export interface RunSessionsOptions {
  flags: SessionsFlags
  width: number
  color: boolean
  /** Sessions directory. Default: the core default. */
  dir?: string
  /** Append lazy summaries to the index. Default true (the catalog default). */
  writeSummaries?: boolean
  now?: number
  timeZone?: string
}

/** The result of the command: rows for stdout. */
export interface SessionsCommandResult {
  rows: string[]
  /** Set when the command failed (for example, an unknown session). */
  exitCode?: number
}

/**
 * Run the `sessions` list. Returns the rows; the caller writes them.
 */
export function runSessionsCommand(opts: RunSessionsOptions): SessionsCommandResult {
  const now = opts.now ?? Date.now()
  const sessionsDir = opts.dir ?? defaultSessionsDir()
  const result = listSessions({
    ...catalogOptions(opts.flags),
    dir: sessionsDir,
    ...(opts.writeSummaries === undefined ? {} : { writeSummaries: opts.writeSummaries }),
  })
  if (opts.flags.json) return { rows: [sessionsJson(result, opts.flags)] }
  const view = buildSessionsView({ result, flags: opts.flags, sessionsDir, now })
  return {
    rows: renderSessionsList(view, {
      width: opts.width,
      color: opts.color,
      now,
      ...(opts.timeZone === undefined ? {} : { timeZone: opts.timeZone }),
    }),
  }
}

/** Version of the `--backfill-lineage --json` shape. */
export const BACKFILL_JSON_VERSION = 1

/** Options of {@link runBackfillLineageCommand}. */
export interface RunBackfillLineageOptions {
  flags: SessionsFlags
  color: boolean
  /** Sessions directory. Default: the core default. */
  dir?: string
  /** Test hook: the core backfill. */
  backfill?: typeof backfillLineage
}

/** The text rows of a backfill result. Pure. */
export function backfillLineageRows(
  result: BackfillLineageResult,
  dryRun: boolean,
  color: boolean,
): string[] {
  const n = (v: number): string => v.toLocaleString("en-US")
  const dim = (t: string): string => (color ? c.dim(t) : t)
  const head = dryRun ? "lineage backfill (dry run, nothing written)" : "lineage backfill"
  return [
    `  ${color ? c.bold(head) : head}`,
    `  candidates          ${n(result.candidates)}`,
    `  linked (transcript) ${n(result.linkedByTranscript)}`,
    `  linked (ppid)       ${n(result.linkedByPpid)}`,
    `  ambiguous           ${n(result.ambiguous)}`,
    `  unknown             ${n(result.unknown)}`,
    `  already linked      ${n(result.alreadyLinked)}`,
    `  written             ${n(result.written)}`,
    dim(
      `  ${n(result.transcriptsScanned)} lead transcripts scanned, ${n(result.transcriptsSkipped)} skipped · ${Math.round(result.elapsedMs).toLocaleString("en-US")} ms`,
    ),
  ]
}

/**
 * `sessions --backfill-lineage [--dry-run] [--since <age>] [--json]`: run the
 * core lineage backfill and return the count rows (the caller writes them).
 */
export function runBackfillLineageCommand(opts: RunBackfillLineageOptions): SessionsCommandResult {
  const dryRun = opts.flags.dryRun === true
  const run = opts.backfill ?? backfillLineage
  const result = run({
    dir: opts.dir ?? defaultSessionsDir(),
    dryRun,
    ...(opts.flags.sinceMs === undefined ? {} : { since: opts.flags.sinceMs }),
  })
  if (opts.flags.json) {
    const { links, ...counts } = result
    return {
      rows: [JSON.stringify({ version: BACKFILL_JSON_VERSION, dryRun, ...counts, links }, null, 2)],
    }
  }
  return { rows: backfillLineageRows(result, dryRun, opts.color) }
}
