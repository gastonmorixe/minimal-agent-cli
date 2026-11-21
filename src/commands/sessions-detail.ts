/**
 * `sessions <sid>`: the detail view of one session (plan items 26-29).
 *
 * {@link resolveSessionsArg} decides what the positional token of
 * `sessions [<token>]` is (item 29):
 * - `last`: the same session as `sessions resume last` (core
 *   `resolveLastSessionSid`: the newest index line of the current cwd, else
 *   the newest line; backups never win).
 * - At least 4 hex characters (dashes allowed) that start exactly one sid:
 *   the detail view of that session. A token that is a full sid also wins
 *   when other sids start with it.
 * - A hex token that starts more than one sid: the list of the matches.
 * - Anything else: a list query (the old behavior).
 *
 * {@link runSessionDetail} reads the catalog row of the session and its
 * sub-agent children and returns the rendered rows. It never writes to a
 * stream.
 *
 * @module commands/sessions-detail
 */

import { existsSync } from "node:fs"
import {
  type IndexRecord,
  type IndexSummaryRecord,
  listSessions,
  type ParsedSessionIndex,
  readParsedSessionIndex,
  resolveLastSessionSid,
  type SessionCatalogRow,
} from "@minimal-agent/core/host/session-index"
import type { SidebandReader } from "@minimal-agent/core/host/sideband"
import { defaultSessionsDir, sessionFilePath } from "@minimal-agent/core/host-kit/session-store"

import {
  renderAmbiguousPrefix,
  renderSessionDetail,
  type SessionDetailNode,
  type SessionDetailView,
  type SessionPrefixMatch,
  type SessionTitleMeta,
} from "../ui/chrome/sessions-detail.ts"
import {
  type RunSessionsOptions,
  runBackfillLineageCommand,
  runSessionsCommand,
  SESSIONS_JSON_VERSION,
  type SessionsCommandResult,
  sessionModelLabel,
  statusOf,
  subagentLabel,
  toJsonRow,
  toListItem,
  visibleChildren,
} from "./sessions.ts"

/** The merged title lines of one sid (core `ParsedSessionIndex.titles`). */
type SessionTitleState = NonNullable<ReturnType<ParsedSessionIndex["titles"]["get"]>>
/** Source of a saved title. */
type TitleSource = NonNullable<SessionCatalogRow["titleSource"]>

/** Shortest hex prefix that can open the detail view. */
export const MIN_SID_PREFIX = 4

/** What the positional `sessions` token means. */
export type SessionsArgTarget =
  | { kind: "detail"; sid: string }
  | { kind: "ambiguous"; prefix: string; matches: SessionPrefixMatch[] }
  | { kind: "query"; query: string }
  | { kind: "none" }

/** True for a token that can be a sid prefix: hex and dashes, 4+ hex chars. */
export function looksLikeSidPrefix(token: string): boolean {
  if (!/^[0-9a-f-]+$/iu.test(token)) return false
  return token.replace(/-/gu, "").length >= MIN_SID_PREFIX
}

/** The parsed index, read one time. */
export interface IndexSnapshot {
  /** Session lines, one per sid (the first line wins). */
  sessions: IndexRecord[]
  /** All session lines in file order (the input of core `resolveLastSessionSid`). */
  records: IndexRecord[]
  summaries: Map<string, IndexSummaryRecord>
  /**
   * Saved title lines of the sidecar, per sid (title SPEC §9.1). Optional: a
   * hand-built snapshot with no titles shows the first prompt.
   */
  titles?: Map<string, SessionTitleState>
}

/**
 * The saved title of a sid in the display order: user, then ai, then
 * derived (the same order as the core catalog row). An empty title is
 * skipped. `undefined` when the sid has no saved title.
 */
export function savedTitleOf(
  state: SessionTitleState | undefined,
): { title: string; source: TitleSource } | undefined {
  if (state === undefined) return undefined
  for (const source of ["user", "ai", "derived"] as const) {
    const title = state[source]?.title
    if (title) return { title, source }
  }
  return undefined
}

/**
 * The facts of the shown saved title for the detail meta line: the source,
 * and for a model title the model and the usage of the title call.
 */
export function titleMetaOf(state: SessionTitleState | undefined): SessionTitleMeta | undefined {
  const saved = savedTitleOf(state)
  if (saved === undefined) return undefined
  const rec = state?.[saved.source]
  return {
    source: saved.source,
    ...(rec?.model === undefined ? {} : { model: rec.model }),
    ...(rec?.usage === undefined ? {} : { inputTokens: rec.usage.inputTokens }),
    ...(rec?.usage === undefined ? {} : { outputTokens: rec.usage.outputTokens }),
    ...(rec?.usage?.costUsd === undefined ? {} : { costUsd: rec.usage.costUsd }),
  }
}

/**
 * Read and parse `index.jsonl` and its sidecar `index-meta.jsonl` with core
 * `readParsedSessionIndex` (tombstones apply, sidecar summaries merge, old
 * summary lines in `index.jsonl` are still read). A missing file gives an
 * empty snapshot.
 */
export function readIndexSnapshot(dir: string): IndexSnapshot {
  const parsed = readParsedSessionIndex(dir)
  const seen = new Map<string, IndexRecord>()
  for (const rec of parsed.sessions) {
    const prev = seen.get(rec.sid)
    seen.set(rec.sid, prev ? { ...rec, ...prev } : rec)
  }
  return {
    sessions: [...seen.values()],
    records: parsed.sessions,
    summaries: parsed.summaries,
    titles: parsed.titles,
  }
}

/** Options of {@link lastSessionSid} and {@link resolveSessionsArg}. */
export interface LastSessionOptions {
  /** The current directory. Default `process.cwd()`. */
  cwd?: string
  /** Sessions directory, for the file check. Default: the core default. */
  dir?: string
  /** File check (tests). Default `existsSync`. */
  exists?: (path: string) => boolean
}

/**
 * The `last` session: the same rule as `sessions resume last` (P4c m2).
 * Like core `readSessionIndex`, only lines whose session file exists count;
 * then core `resolveLastSessionSid` picks the newest line of the cwd, else
 * the newest line (backups never win).
 */
export function lastSessionSid(
  snapshot: IndexSnapshot,
  opts: LastSessionOptions = {},
): string | undefined {
  const exists = opts.exists ?? existsSync
  const dir = opts.dir ?? defaultSessionsDir()
  const records = snapshot.records.filter((rec) => exists(sessionFilePath(rec.sid, dir)))
  return resolveLastSessionSid(records, opts.cwd ?? process.cwd()) ?? undefined
}

function prefixMatch(rec: IndexRecord, snapshot: IndexSnapshot): SessionPrefixMatch {
  const summary = snapshot.summaries.get(rec.sid)
  const saved = savedTitleOf(snapshot.titles?.get(rec.sid))
  return {
    sid: rec.sid,
    createdAtMs: Date.parse(rec.createdAt),
    title: saved?.title ?? summary?.title ?? "",
    ...(saved === undefined ? {} : { titleSource: saved.source }),
    status: statusOf({ summary }),
    ...(rec.leadSid ? { leadSid: rec.leadSid } : {}),
  }
}

/**
 * Resolve the positional token of `sessions [<token>]` (item 29). Pure on
 * the snapshot.
 */
export function resolveSessionsArg(
  token: string | undefined,
  snapshot: IndexSnapshot,
  opts: LastSessionOptions = {},
): SessionsArgTarget {
  const t = token?.trim() ?? ""
  if (t.length === 0) return { kind: "none" }
  if (t === "last") {
    const sid = lastSessionSid(snapshot, opts)
    return sid === undefined ? { kind: "query", query: t } : { kind: "detail", sid }
  }
  if (!looksLikeSidPrefix(t)) return { kind: "query", query: t }
  const needle = t.toLowerCase()
  // Like the list and `last`: only lines whose session file exists count, so a
  // stale line (file removed with no tombstone) cannot make a prefix
  // ambiguous or open a session with no file (final review F4).
  const exists = opts.exists ?? existsSync
  const dir = opts.dir ?? defaultSessionsDir()
  const hits = snapshot.sessions.filter(
    (r) => r.sid.toLowerCase().startsWith(needle) && exists(sessionFilePath(r.sid, dir)),
  )
  const exact = hits.find((r) => r.sid.toLowerCase() === needle)
  if (exact) return { kind: "detail", sid: exact.sid }
  if (hits.length === 1 && hits[0]) return { kind: "detail", sid: hits[0].sid }
  if (hits.length > 1) {
    const matches = hits
      .map((r) => prefixMatch(r, snapshot))
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
    return { kind: "ambiguous", prefix: t, matches }
  }
  return { kind: "query", query: t }
}

/** Options of {@link findSessionRow}. */
interface FindRowOptions {
  dir: string
  /** `--all`: also add the index-only children with no summary line. */
  all?: boolean
  /**
   * Append lazy summaries to the index. The caller decides: the real CLI
   * may write, tests and scripts pass false (review M1).
   */
  writeSummaries: boolean
  /** The sideband reader for the lazy summary title. Omitted: `NO_SIDEBAND`. */
  sideband?: SidebandReader
}

/** Rows per catalog page in {@link topRow}. */
const TOP_ROW_PAGE = 10
/** Safety cap on the catalog pages that {@link topRow} reads. */
const TOP_ROW_MAX_PAGES = 100

/**
 * The catalog row of one top-level sid (hidden rows too), with its children.
 *
 * The core catalog has no exact sid filter (core request in the P4c
 * report), so this is the narrowest call: the exact `cwd` and the `model`
 * of the index line, plus the sid as the query. The list flags (`--cwd`,
 * `--since`, `--model`, the list query) do not apply here. Only rows of the
 * same cwd and model whose sid, model, or title contains the full sid can
 * come before the target, so the catalog resolves (and with
 * `writeSummaries` appends) almost never more than the one row. The walk
 * reads the next page until it finds the sid, so no other row can push it
 * out (review M1).
 */
function topRow(
  sid: string,
  rec: IndexRecord | undefined,
  opts: FindRowOptions,
): SessionCatalogRow | undefined {
  for (let page = 0; page < TOP_ROW_MAX_PAGES; page++) {
    const result = listSessions({
      dir: opts.dir,
      query: sid,
      ...(rec === undefined ? {} : { cwd: rec.cwd, model: rec.model }),
      limit: TOP_ROW_PAGE,
      page,
      includeHidden: true,
      writeSummaries: opts.writeSummaries,
      ...(opts.sideband === undefined ? {} : { sideband: opts.sideband }),
    })
    const row = result.rows.find((r) => r.sid === sid)
    if (row) return row
    if (result.rows.length < TOP_ROW_PAGE) return undefined
  }
  return undefined
}

function findIn(rows: readonly SessionCatalogRow[], sid: string): SessionCatalogRow | undefined {
  for (const row of rows) {
    if (row.sid === sid) return row
    const deep = findIn(row.children, sid)
    if (deep) return deep
  }
  return undefined
}

/**
 * The catalog row of a sid, with its children. A sub-agent session is not a
 * top-level row: the function reads its lead (up the `leadSid` chain) and
 * finds the child there.
 */
export function findSessionRow(
  sid: string,
  snapshot: IndexSnapshot,
  opts: FindRowOptions,
): SessionCatalogRow | undefined {
  const bySid = new Map(snapshot.sessions.map((r) => [r.sid, r]))
  const chain: string[] = [sid]
  let rec = bySid.get(sid)
  while (rec?.leadSid && bySid.has(rec.leadSid) && !chain.includes(rec.leadSid)) {
    chain.push(rec.leadSid)
    rec = bySid.get(rec.leadSid)
  }
  const top = chain[chain.length - 1] ?? sid
  const row = topRow(top, bySid.get(top), opts)
  if (row === undefined) return undefined
  // Children past the catalog depth come from the index.
  addDeepChildren(row, snapshot, { dir: opts.dir, all: opts.all === true })
  return findIn([row], sid)
}

/**
 * Safety cap on the tree levels below the root. The detail view shows all
 * depths: the catalog gives children down to depth 8, and the index walk
 * adds deeper ones. The cap only stops a bad (very long) lead chain.
 */
export const MAX_DETAIL_DEPTH = 32

/** A catalog-like row from the index only (no session-file read). */
function indexRow(rec: IndexRecord, snapshot: IndexSnapshot): SessionCatalogRow {
  const known = snapshot.summaries.get(rec.sid)
  const row: SessionCatalogRow = {
    sid: rec.sid,
    createdAt: rec.createdAt,
    cwd: rec.cwd,
    model: rec.model,
    ...(rec.leadSid ? { leadSid: rec.leadSid } : {}),
    ...(rec.leadSid ? { lineageSource: rec.lineageSource ?? "recorded" } : {}),
    ...(rec.agentId ? { agentId: rec.agentId } : {}),
    ...(rec.role ? { role: rec.role } : {}),
    summarySource: "none",
    children: [],
  }
  if (known) {
    const { kind: _kind, sid: _sid, ...summary } = known
    row.summary = summary
    row.summarySource = "index"
  }
  const saved = savedTitleOf(snapshot.titles?.get(rec.sid))
  if (saved) {
    row.title = saved.title
    row.titleSource = saved.source
  }
  return row
}

/**
 * Add the deeper sub-agent sessions that the catalog does not return (the
 * catalog gives children down to depth 8; the index can have more, or rows
 * that the catalog did not attach). Index data only, plus one `existsSync`
 * per added row. A shared `seen` set stops a lead cycle. The view hides
 * empty ones unless `--all` (`visibleChildren`).
 *
 * Without `all`, a row with no summary line is not added (review M2): the
 * catalog (called with `includeHidden`) already gives every child down to
 * depth 8 with a resolved summary, so an index-only row here is one the
 * catalog left out on purpose (empty or a cycle), or one past depth 8 that
 * this walk cannot check. The list hides the same rows, so the two views
 * agree.
 */
export function addDeepChildren(
  row: SessionCatalogRow,
  snapshot: IndexSnapshot,
  opts: { dir: string; all?: boolean; exists?: (path: string) => boolean },
  depth = 0,
  seen: Set<string> = new Set([row.sid]),
): SessionCatalogRow {
  const exists = opts.exists ?? existsSync
  if (depth >= MAX_DETAIL_DEPTH) return row
  for (const child of row.children) seen.add(child.sid)
  for (const rec of snapshot.sessions) {
    if (rec.leadSid !== row.sid || seen.has(rec.sid)) continue
    if (opts.all !== true && !snapshot.summaries.has(rec.sid)) continue
    if (!exists(sessionFilePath(rec.sid, opts.dir))) continue
    seen.add(rec.sid)
    row.children.push(indexRow(rec, snapshot))
  }
  for (const child of row.children) addDeepChildren(child, snapshot, opts, depth + 1, seen)
  return row
}

function toNode(
  row: SessionCatalogRow,
  now: number,
  root: boolean,
  all: boolean,
): SessionDetailNode {
  const children = visibleChildren(row.children, all)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((child) => toNode(child, now, false, all))
  const label = root && row.leadSid === undefined ? "lead" : subagentLabel(row)
  return { item: toListItem(row, now), label, children }
}

/**
 * Build the detail view of one catalog row. Empty children show only with
 * `all`. `titles` (the saved title lines of the row sid) gives the title
 * meta line (source, model, usage of the title call).
 */
export function buildSessionDetailView(
  row: SessionCatalogRow,
  now: number,
  all = false,
  titles?: SessionTitleState,
): SessionDetailView {
  const titleMeta = row.title === undefined ? undefined : titleMetaOf(titles)
  return {
    root: toNode(row, now, true, all),
    cwd: row.cwd,
    modelLabel: sessionModelLabel(row.model),
    ...(row.summary === undefined ? {} : { turns: row.summary.turns }),
    ...(row.leadSid === undefined ? {} : { leadSid: row.leadSid }),
    ...(row.forkOf === undefined ? {} : { forkOf: row.forkOf }),
    ...(titleMeta === undefined ? {} : { titleMeta }),
  }
}

/** Options of {@link runSessionDetail}. */
export interface RunSessionDetailOptions {
  sid: string
  snapshot: IndexSnapshot
  width: number
  color: boolean
  json: boolean
  /** `--all`: also show empty sub-agent sessions. */
  all?: boolean
  dir?: string
  /**
   * Append lazy summaries to the index. No default: the caller decides
   * (review M1). The real CLI passes true; tests and scripts pass false.
   */
  writeSummaries: boolean
  now?: number
  timeZone?: string
  home?: string
  /** The sideband reader for the lazy summary title. Omitted: `NO_SIDEBAND`. */
  sideband?: SidebandReader
}

/** Render the detail view of one sid (or its `--json`). */
export function runSessionDetail(opts: RunSessionDetailOptions): SessionsCommandResult {
  const now = opts.now ?? Date.now()
  const dir = opts.dir ?? defaultSessionsDir()
  const row = findSessionRow(opts.sid, opts.snapshot, {
    dir,
    all: opts.all === true,
    writeSummaries: opts.writeSummaries,
    ...(opts.sideband === undefined ? {} : { sideband: opts.sideband }),
  })
  if (row === undefined) {
    return { rows: [`  session ${opts.sid} has no saved file`], exitCode: 1 }
  }
  if (opts.json) {
    return {
      // The same row shape as the list `--json`: plus `title`, `titleSource`, `prompt`.
      rows: [
        JSON.stringify(
          { version: SESSIONS_JSON_VERSION, kind: "session", row: toJsonRow(row) },
          null,
          2,
        ),
      ],
    }
  }
  return {
    rows: renderSessionDetail(
      buildSessionDetailView(row, now, opts.all === true, opts.snapshot.titles?.get(row.sid)),
      {
        width: opts.width,
        color: opts.color,
        now,
        ...(opts.timeZone === undefined ? {} : { timeZone: opts.timeZone }),
        ...(opts.home === undefined ? {} : { home: opts.home }),
      },
    ),
  }
}

/** Render the matches of an ambiguous prefix (or their `--json`). */
export function runAmbiguousPrefix(
  target: Extract<SessionsArgTarget, { kind: "ambiguous" }>,
  opts: Pick<RunSessionDetailOptions, "width" | "color" | "json" | "now" | "timeZone">,
): SessionsCommandResult {
  if (opts.json) {
    const json = {
      version: SESSIONS_JSON_VERSION,
      kind: "ambiguous",
      prefix: target.prefix,
      sids: target.matches.map((m) => m.sid),
    }
    return { rows: [JSON.stringify(json, null, 2)], exitCode: 1 }
  }
  return {
    rows: renderAmbiguousPrefix(target.prefix, target.matches, {
      width: opts.width,
      color: opts.color,
      ...(opts.now === undefined ? {} : { now: opts.now }),
      ...(opts.timeZone === undefined ? {} : { timeZone: opts.timeZone }),
    }),
    exitCode: 1,
  }
}

/** Options of {@link runSessionsEntry}: the list options plus the test hooks. */
export interface RunSessionsEntryOptions extends RunSessionsOptions {
  home?: string
  /** The current directory for `last`. Default `process.cwd()`. */
  cwd?: string
}

/**
 * The `sessions [<token>]` entry (item 29): resolve the token, then show the
 * detail view, the ambiguous matches, or the list.
 */
export function runSessionsEntry(opts: RunSessionsEntryOptions): SessionsCommandResult {
  const { flags } = opts
  const dir = opts.dir ?? defaultSessionsDir()
  if (flags.backfillLineage) {
    return runBackfillLineageCommand({ flags, color: opts.color, dir })
  }
  const common = {
    width: opts.width,
    color: opts.color,
    json: flags.json,
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.timeZone === undefined ? {} : { timeZone: opts.timeZone }),
  }
  if (flags.query !== undefined) {
    const snapshot = readIndexSnapshot(dir)
    const target = resolveSessionsArg(flags.query, snapshot, {
      dir,
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    })
    if (target.kind === "detail") {
      return runSessionDetail({
        ...common,
        sid: target.sid,
        all: flags.all,
        snapshot,
        dir,
        // The host gives no value: the real CLI may append summaries (the
        // catalog default). Tests and scripts pass false.
        writeSummaries: opts.writeSummaries !== false,
        ...(opts.home === undefined ? {} : { home: opts.home }),
        ...(opts.sideband === undefined ? {} : { sideband: opts.sideband }),
      })
    }
    if (target.kind === "ambiguous") return runAmbiguousPrefix(target, common)
  }
  return runSessionsCommand({ ...opts, dir })
}
