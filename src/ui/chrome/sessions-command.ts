/**
 * Host-owned `sessions` list chrome.
 *
 * The command layer (`commands/sessions.ts`) reads the core session catalog
 * and builds a {@link SessionsListView}. This module turns the view into
 * width-mode table rows: columns session, start, dur, prompt, tokens, cost,
 * and model; day rulers in local time; sub-agent rows as a tree under
 * their lead, and a footer. It never writes to a stream.
 *
 * @module ui/chrome/sessions-command
 */

import type {
  CommandTableColumn,
  CommandTableRow,
  CommandTableSection,
  CommandTableSpan,
} from "../command-table.ts"
import { renderCommandTable } from "../command-table.ts"
import {
  fitDisplayWidth,
  formatCost,
  formatDayLabel,
  formatDuration,
  formatLocalTime,
  formatTokenCount,
  MISSING_VALUE,
} from "../format/index.ts"
import { c } from "../style/ansi.ts"

/** Width when stdout is not a TTY and `COLUMNS` is not set (decision D4). */
export const DEFAULT_SESSIONS_WIDTH = 100

/** A lead with more children than this shows {@link CHILDREN_SHOWN} and a `+N more` row. */
export const MAX_CHILDREN = 5

/** Children shown when a lead has more than {@link MAX_CHILDREN}. */
export const CHILDREN_SHOWN = 4

/** Deepest sub-agent level that the list shows as rows (1 = child, 2 = grandchild). */
export const MAX_LIST_DEPTH = 2

/** Status of one session row. `unknown`: no summary yet. */
export type SessionListStatus = "live" | "done" | "failed" | "unknown"

/** One session (lead or sub-agent) as the list shows it. */
export interface SessionListItem {
  sid: string
  /** Start time, epoch ms. */
  createdAtMs: number
  /** Run time in ms, when known. */
  durationMs?: number
  /**
   * The shown title (SPEC §8): the saved title (user, then ai, then derived), else
   * the first real user text. Empty when not known.
   */
  title: string
  /** Source of a saved title. Absent: `title` is the first prompt. `ai` gets a dim `✦`. */
  titleSource?: "user" | "ai" | "derived"
  /** First real user text (`summary.title`), when known. */
  prompt?: string
  tokens?: number
  /** True when `tokens` is an estimate (the cell gets a `~`). */
  estimated?: boolean
  costUsd?: number
  /** Short model label (the full id stays in `--json`). */
  model: string
  status: SessionListStatus
  /** Sub-agent role (or agent id). Set on a sub-agent row. */
  role?: string
  /** True for a sub-agent session (a role label shows first). */
  subagent?: boolean
  /** Why the row is hidden by default (only with `--all`). */
  hiddenReason?: string
  /** True when the session was forked or resumed from another one (a dim `↻` before the prompt). */
  fork?: boolean
  /**
   * Sub-agent sessions of this sub-agent (depth 2 and more), oldest first.
   * The list shows depth 1 and 2; deeper rows collapse into one
   * `… +N deeper` row. The detail view shows all depths.
   */
  children?: SessionListItem[]
}

/** One top-level entry of the list, with its sub-agent rows. */
export type SessionListEntry =
  | { kind: "session"; item: SessionListItem; children: SessionListItem[] }
  /** Sub-agent sessions whose lead is not in the list, under a `(lead <sid8>)` row. */
  | { kind: "orphans"; leadSid: string; children: SessionListItem[] }

/** The full list view, oldest entry first (newest last). */
export interface SessionsListView {
  entries: SessionListEntry[]
  /** Top-level rows on this page (the rows that `total` counts). */
  shown: number
  /** `--subagents flat`: sub-agent rows shown as top rows (not in `shown`). */
  subagentRows?: number
  /** Lead sessions that match the filters. */
  total: number
  /** Matching sessions that are hidden by default. */
  hiddenCount: number
  /**
   * Top-level rows in `total` with no summary yet (core `unknownCount`).
   * When above 0, `total` is an upper bound and `hiddenCount` a lower bound.
   */
  unknownCount?: number
  /** `--all` was set: hidden rows show, and the footer has no `--all` hint. */
  showAll: boolean
  /** 1-based page. */
  page: number
  limit: number
  /** True when a filter or query was set (for the empty text). */
  filtered: boolean
  sessionsDir: string
}

/** Render options. The host reads the width and the color policy once. */
export interface SessionsRenderOptions {
  width: number
  color: boolean
  /** Clock for the day labels (tests). Default `Date.now()`. */
  now?: number
  /** IANA zone for the day labels and clock times (tests). Default: host zone. */
  timeZone?: string
}

/** The stream facts that {@link resolveSessionsWidth} reads. */
export interface WidthSource {
  isTTY?: boolean
  columns?: number
}

/**
 * Terminal width for the list, read one time (decision D4): the TTY columns,
 * else a positive `COLUMNS`, else {@link DEFAULT_SESSIONS_WIDTH}. No resize.
 */
export function resolveSessionsWidth(
  stream: WidthSource,
  env: Readonly<Record<string, string | undefined>>,
): number {
  const cols = stream.columns
  if (stream.isTTY === true && cols !== undefined && Number.isFinite(cols) && cols > 0) {
    return Math.floor(cols)
  }
  const raw = env.COLUMNS
  if (raw !== undefined && /^\s*\d+\s*$/u.test(raw)) {
    const n = Number.parseInt(raw, 10)
    if (n > 0) return n
  }
  return DEFAULT_SESSIONS_WIDTH
}

const SID_LEN = 8

/** First 8 characters of a session id. */
export function shortSid(sid: string): string {
  return sid.slice(0, SID_LEN)
}

/** Columns of the list. Drop order: cost, model, start, dur, tokens. */
export const SESSIONS_COLUMNS: readonly CommandTableColumn[] = [
  { key: "id", header: "session", width: 12 },
  { key: "start", header: "start", align: "r", width: 5, color: "dim", dropPriority: 3 },
  { key: "dur", header: "dur", align: "r", width: 6, color: "dim", dropPriority: 4 },
  { key: "prompt", header: "prompt", flex: true, minWidth: 20 },
  { key: "tokens", header: "tokens", align: "r", minWidth: 6, maxWidth: 7, dropPriority: 5 },
  {
    key: "cost",
    header: "cost",
    align: "r",
    minWidth: 6,
    maxWidth: 9,
    color: "dim",
    dropPriority: 1,
  },
  { key: "model", header: "model", minWidth: 5, maxWidth: 12, color: "dim", dropPriority: 2 },
]

const GLYPH: Record<SessionListStatus, CommandTableSpan> = {
  live: { text: "●", color: "green" },
  done: { text: "○", color: "dim" },
  failed: { text: "✗", color: "red" },
  unknown: { text: "·", color: "dim" },
}

/** Token cell: `~` before an estimate, `—` when not known. */
export function formatTokensCell(item: Pick<SessionListItem, "tokens" | "estimated">): string {
  if (item.tokens === undefined || !Number.isFinite(item.tokens)) return MISSING_VALUE
  return `${item.estimated ? "~" : ""}${formatTokenCount(item.tokens)}`
}

function promptSpans(item: SessionListItem): CommandTableSpan[] {
  const title = item.title.trim()
  const text =
    title.length > 0 ? title : item.hiddenReason ? `(${item.hiddenReason})` : "(no prompt)"
  const mark: CommandTableSpan[] = item.fork ? [{ text: "↻ ", color: "dim" }] : []
  // SPEC §9.4 (Q7): a dim `✦` marks an AI title.
  if (title.length > 0 && item.titleSource === "ai") mark.push({ text: "✦ ", color: "dim" })
  if (item.subagent) {
    return [
      { text: item.role ?? "sub-agent", color: "yellow" },
      { text: " · ", color: "dim" },
      ...mark,
      { text, color: "dim" },
    ]
  }
  return [...mark, { text, color: title.length > 0 && !item.hiddenReason ? "none" : "dim" }]
}

/** One table row for one session. */
export function sessionTableRow(
  item: SessionListItem,
  depth: number,
  opts: Pick<SessionsRenderOptions, "timeZone">,
): CommandTableRow {
  const kid = depth > 0
  const tokens = formatTokensCell(item)
  const dimRow = kid || item.hiddenReason !== undefined
  return {
    depth,
    cells: {
      start: formatLocalTime(item.createdAtMs, { timeZone: opts.timeZone }),
      dur: item.durationMs === undefined ? "" : formatDuration(item.durationMs),
      tokens,
      cost: item.costUsd === undefined ? "" : formatCost(item.costUsd),
      model: item.model,
    },
    spans: {
      id: [GLYPH[item.status], { text: ` ${shortSid(item.sid)}`, color: dimRow ? "dim" : "cyan" }],
      prompt: promptSpans(item),
      tokens: [{ text: tokens, color: dimRow || item.tokens === undefined ? "dim" : "none" }],
    },
  }
}

/** All sessions below `item` (its children, their children, and so on). */
export function descendantCount(item: Pick<SessionListItem, "children">): number {
  let n = 0
  for (const child of item.children ?? []) n += 1 + descendantCount(child)
  return n
}

/** A dim `… text` row at `depth` (a `+N more` or `+N deeper` row). */
function moreRow(depth: number, text: string): CommandTableRow {
  return {
    depth,
    cells: {},
    spans: { id: [{ text: "…", color: "dim" }], prompt: [{ text, color: "dim" }] },
  }
}

/** One child row at `depth` and, to {@link MAX_LIST_DEPTH}, its subtree. */
function subtreeRows(
  child: SessionListItem,
  depth: number,
  opts: SessionsRenderOptions,
): CommandTableRow[] {
  const rows = [sessionTableRow(child, depth, opts)]
  const kids = child.children ?? []
  if (kids.length === 0) return rows
  if (depth < MAX_LIST_DEPTH) {
    rows.push(...childRows(child.sid, kids, depth + 1, opts))
    return rows
  }
  const deeper = descendantCount(child)
  rows.push(moreRow(depth + 1, `+${deeper} deeper · sessions ${shortSid(child.sid)}`))
  return rows
}

function childRows(
  leadSid: string,
  children: readonly SessionListItem[],
  depth: number,
  opts: SessionsRenderOptions,
): CommandTableRow[] {
  if (children.length <= MAX_CHILDREN) {
    return children.flatMap((child) => subtreeRows(child, depth, opts))
  }
  const rows = children.slice(0, CHILDREN_SHOWN).flatMap((child) => subtreeRows(child, depth, opts))
  const more = children.length - CHILDREN_SHOWN
  rows.push(moreRow(depth, `+${more} more · sessions ${shortSid(leadSid)}`))
  return rows
}

function entryRows(entry: SessionListEntry, opts: SessionsRenderOptions): CommandTableRow[] {
  if (entry.kind === "orphans") {
    const sid8 = shortSid(entry.leadSid)
    return [
      {
        depth: 0,
        cells: {},
        spans: {
          id: [{ text: `◌ ${sid8}`, color: "dim" }],
          prompt: [{ text: `(lead ${sid8})`, color: "dim" }],
        },
      },
      ...childRows(entry.leadSid, entry.children, 1, opts),
    ]
  }
  return [
    sessionTableRow(entry.item, 0, opts),
    ...childRows(entry.item.sid, entry.children, 1, opts),
  ]
}

function entryTime(entry: SessionListEntry): number {
  if (entry.kind === "session") return entry.item.createdAtMs
  return entry.children[0]?.createdAtMs ?? Number.NaN
}

/** Day sections in list order. A new section starts when the local day label changes. */
export function sessionSections(
  view: SessionsListView,
  opts: SessionsRenderOptions,
): CommandTableSection[] {
  const sections: CommandTableSection[] = []
  let current: CommandTableSection | undefined
  for (const entry of view.entries) {
    const title = formatDayLabel(entryTime(entry), { now: opts.now, timeZone: opts.timeZone })
    if (current === undefined || current.title !== title) {
      current = { title, rows: [] }
      sections.push(current)
    }
    current.rows.push(...entryRows(entry, opts))
  }
  return sections
}

const count = (n: number): string => n.toLocaleString("en-US")

/**
 * Footer: `N of M sessions · K hidden · --all · --limit N · sessions <sid>`,
 * or `no sessions · K hidden · --all` when no row matches and shows.
 * When some rows have no summary yet (`unknownCount > 0`), the counts are
 * not exact: `N of about M sessions · ≥K hidden`.
 */
export function sessionsFooter(view: SessionsListView): string {
  const approx = (view.unknownCount ?? 0) > 0
  // No visible row (P4c m6): `no sessions · N hidden · --all`, not
  // `0 of 0 sessions`. With `--all` the hidden rows are in the total, so
  // a hidden part would only repeat it.
  if (view.shown === 0 && view.total === 0) {
    const parts = ["no sessions"]
    if (view.hiddenCount > 0 && !view.showAll) {
      parts.push(`${approx ? "≥" : ""}${count(view.hiddenCount)} hidden`, "--all")
    }
    return parts.join(" · ")
  }
  const parts = [`${count(view.shown)} of ${approx ? "about " : ""}${count(view.total)} sessions`]
  if (view.subagentRows !== undefined && view.subagentRows > 0) {
    parts[0] = `${parts[0]} + ${count(view.subagentRows)} sub-agent${view.subagentRows === 1 ? "" : "s"}`
  }
  if (view.page > 1) parts.push(`page ${view.page}`)
  if (view.hiddenCount > 0) {
    parts.push(`${approx ? "≥" : ""}${count(view.hiddenCount)} hidden`)
    if (!view.showAll) parts.push("--all")
  }
  if (view.total > view.page * view.limit) parts.push("--limit N", "--page N")
  parts.push("sessions <sid>")
  return parts.join(" · ")
}

/** Cells of one tree level in the first column (arm and one space). */
const TREE_CELLS = 2

/**
 * {@link SESSIONS_COLUMNS} with a session column wide enough for the
 * deepest row: 12 cells hold one level, each deeper level adds 2 cells.
 */
export function sessionsColumns(sections: readonly CommandTableSection[]): CommandTableColumn[] {
  let maxDepth = 0
  for (const section of sections) {
    for (const row of section.rows) {
      if (row.cells.start !== undefined) maxDepth = Math.max(maxDepth, row.depth ?? 0)
    }
  }
  const extra = TREE_CELLS * Math.max(0, maxDepth - 1)
  const columns = [...SESSIONS_COLUMNS]
  const index = columns.findIndex((col) => col.key === "id")
  const id = columns[index]
  if (id !== undefined && extra > 0) columns[index] = { ...id, width: (id.width ?? 0) + extra }
  return columns
}

/** The last page number for the view (1 when the list is empty). */
export function lastPage(view: Pick<SessionsListView, "total" | "limit">): number {
  return Math.max(1, Math.ceil(view.total / Math.max(1, view.limit)))
}

/** The resume hint under the footer. */
export const RESUME_HINT = "resume: ma sessions resume <sid>  (or: ma sessions resume last)"

/**
 * Render the list view as rows (no trailing newline, no stream write).
 * No row is wider than `opts.width`.
 */
export function renderSessionsList(view: SessionsListView, opts: SessionsRenderOptions): string[] {
  const width = Math.max(1, Math.floor(opts.width))
  const dim = (s: string): string => {
    const fitted = `  ${fitDisplayWidth(s, Math.max(0, width - 2))}`
    return opts.color ? c.dim(fitted) : fitted
  }
  if (view.entries.length === 0) {
    const empty =
      view.total === 0 && view.hiddenCount === 0 && !view.filtered
        ? ["", dim("no saved sessions yet"), dim(`(sessions are stored at ${view.sessionsDir})`)]
        : view.page > 1 && view.total > 0
          ? [
              "",
              dim(`page ${view.page} is empty · last page is ${lastPage(view)}`),
              dim(sessionsFooter(view)),
            ]
          : [
              "",
              dim(view.filtered ? "no sessions match" : "no sessions to show"),
              dim(sessionsFooter(view)),
            ]
    return empty
  }
  const sections = sessionSections(view, opts)
  const rows = renderCommandTable({
    width,
    color: opts.color,
    columns: sessionsColumns(sections),
    sections,
    summary: sessionsFooter(view),
  })
  rows.push(dim(RESUME_HINT))
  return rows
}
