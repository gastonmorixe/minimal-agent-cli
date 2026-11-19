/**
 * Host-owned `sessions <sid>` detail chrome (plan items 26-28, mockup D).
 *
 * The command layer (`commands/sessions-detail.ts`) reads the catalog and
 * builds a {@link SessionDetailView}. This module turns it into rows: a
 * header (title, then, for a saved title, the first prompt and a title
 * meta line with the source, model and title-call cost; then model, cwd, start, duration, turns, tokens, cost and
 * status), the lead row and its sub-agent tree with timeline bars, and the
 * hints (`ma sessions dump <sid>` for a failed child, `ma sessions resume`).
 * It also renders the short list for an ambiguous sid prefix. No row is
 * wider than the width. It never writes to a stream.
 *
 * @module ui/chrome/sessions-detail
 */

import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"

import {
  ELLIPSIS,
  formatCost,
  formatCwd,
  formatDayLabel,
  formatDuration,
  formatLocalTime,
  formatTokenCount,
  padEndDisplay,
  padStartDisplay,
  sliceDisplayWidth,
  toCellText,
} from "../format/index.ts"
import { c } from "../style/ansi.ts"
import {
  formatTokensCell,
  type SessionListItem,
  type SessionListStatus,
  shortSid,
} from "./sessions-command.ts"

/** One session of the detail tree. */
export interface SessionDetailNode {
  item: SessionListItem
  /** Row label: `lead` for the root, else the sub-agent id and role. */
  label: string
  /** Sub-agent sessions of this session, oldest first. */
  children: SessionDetailNode[]
}

/** The detail view of one session. */
export interface SessionDetailView {
  root: SessionDetailNode
  cwd: string
  /** Short model label (decision D4). */
  modelLabel: string
  /** User turns, when known. */
  turns?: number
  /** Set when the root is a sub-agent session: the sid of its lead. */
  leadSid?: string
  /** Set when the root was forked or resumed from another session (meta `parentSid`). */
  forkOf?: string
  /** Set when the root has a saved title: the facts of the title line (SPEC §9.4). */
  titleMeta?: SessionTitleMeta
}

/** The facts of the shown saved title (one sidecar title line). */
export interface SessionTitleMeta {
  source: "user" | "ai" | "derived"
  /** Model id of the title call (an `ai` title). */
  model?: string
  inputTokens?: number
  outputTokens?: number
  /** Cost of the title call. Not in the session cost or `/usage`. */
  costUsd?: number
}

/** Render options. The host reads the width and the color policy once. */
export interface SessionDetailRenderOptions {
  width: number
  color: boolean
  /** Clock for live rows and the day label (tests). Default `Date.now()`. */
  now?: number
  /** IANA zone (tests). Default: host zone. */
  timeZone?: string
  /** Home dir for the `~` in the cwd (tests). Default: `$HOME`. */
  home?: string
}

type Paint = "cyan" | "dim" | "bold" | "green" | "red" | "yellow" | "magenta"

/** One painted part of a row. */
interface Seg {
  text: string
  color?: Paint
}

const INDENT = "  "
const ARM_WIDTH = 3
const DUR_WIDTH = 6
const TOK_WIDTH = 7
const MAX_ROLE_WIDTH = 14
const MIN_ROLE_WIDTH = 4
const MIN_BAR = 6
const MAX_BAR = 40

const GLYPH: Record<SessionListStatus, Seg> = {
  live: { text: "●", color: "green" },
  done: { text: "○", color: "dim" },
  failed: { text: "✗", color: "red" },
  unknown: { text: "·", color: "dim" },
}

const segWidth = (segs: readonly Seg[]): number =>
  segs.reduce((n, s) => n + displayWidth(s.text), 0)

/** Cut segments to `width` cells; the cut part ends with `…`. */
function fitSegs(segs: readonly Seg[], width: number): Seg[] {
  if (segWidth(segs) <= width) return [...segs]
  const out: Seg[] = []
  let left = Math.max(0, width - 1)
  for (const seg of segs) {
    const w = displayWidth(seg.text)
    if (w <= left) {
      out.push(seg)
      left -= w
      continue
    }
    out.push({ text: `${sliceDisplayWidth(seg.text, left)}${ELLIPSIS}`, color: seg.color })
    return out
  }
  return out
}

function paintLine(segs: readonly Seg[], width: number, color: boolean): string {
  const fitted = fitSegs(segs, width)
  return fitted
    .map((s) => (color && s.color ? c[s.color](s.text) : s.text))
    .join("")
    .replace(/\s+$/u, "")
}

/** The end of a row on the timeline, epoch ms. */
function endOf(item: SessionListItem, now: number): number {
  if (item.durationMs !== undefined) return item.createdAtMs + item.durationMs
  return item.status === "live" ? now : item.createdAtMs
}

/** A flat tree walk: node, depth, and for each level whether a sibling follows. */
interface Flat {
  node: SessionDetailNode
  depth: number
  /** `more[i]`: the ancestor at depth i+1 (or this node, last entry) has a later sibling. */
  more: boolean[]
}

function flatten(root: SessionDetailNode): Flat[] {
  const out: Flat[] = [{ node: root, depth: 0, more: [] }]
  const walk = (node: SessionDetailNode, depth: number, more: boolean[]): void => {
    node.children.forEach((child, i) => {
      const chain = [...more, i < node.children.length - 1]
      out.push({ node: child, depth, more: chain })
      walk(child, depth + 1, chain)
    })
  }
  walk(root, 1, [])
  return out
}

/** `│  ` / `   ` for the ancestors, then the arm `├─ ` / `╰─ `. */
function armOf(f: Flat): string {
  if (f.depth === 0) return ""
  const up = f.more
    .slice(0, -1)
    .map((m) => (m ? "│  " : "   "))
    .join("")
  return `${up}${f.more[f.more.length - 1] ? "├─ " : "╰─ "}`
}

/** The prefix of the prompt line under a row: `│` where a sibling follows. */
function contOf(f: Flat): string {
  return `${f.more.map((m) => (m ? "│  " : "   ")).join("")} `
}

/** The column plan of the tree rows for one width. */
interface TreePlan {
  /** Deepest tree level; a shallow row gets the arm cells of the deeper rows in its role cell. */
  maxDepth: number
  roleWidth: number
  leftWidth: number
  bar: number
  dur: boolean
  tok: boolean
}

function planTree(rows: readonly Flat[], width: number): TreePlan {
  const maxDepth = rows.reduce((n, r) => Math.max(n, r.depth), 0)
  let roleWidth = Math.min(
    MAX_ROLE_WIDTH,
    rows.reduce((n, r) => Math.max(n, displayWidth(r.node.label)), MIN_ROLE_WIDTH),
  )
  const left = (): number => ARM_WIDTH * maxDepth + 2 + roleWidth + 1 + 8
  let dur = true
  let tok = true
  const fixed = (): number =>
    INDENT.length + left() + (dur ? 1 + DUR_WIDTH : 0) + (tok ? 1 + TOK_WIDTH : 0)
  // The bar takes the free width between the left part and the numbers.
  const barRoom = (): number => width - fixed() - 2 - 2
  if (barRoom() >= MIN_BAR) {
    return { maxDepth, roleWidth, leftWidth: left(), bar: Math.min(MAX_BAR, barRoom()), dur, tok }
  }
  if (fixed() > width) tok = false
  if (fixed() > width) dur = false
  while (fixed() > width && roleWidth > MIN_ROLE_WIDTH) roleWidth -= 1
  return { maxDepth, roleWidth, leftWidth: left(), bar: 0, dur, tok }
}

function barSegs(
  item: SessionListItem,
  span: { t0: number; t1: number },
  n: number,
  now: number,
): Seg[] {
  const total = Math.max(1, span.t1 - span.t0)
  const start = Math.min(n - 1, Math.max(0, Math.round(((item.createdAtMs - span.t0) / total) * n)))
  const len = Math.max(
    1,
    Math.min(n - start, Math.round(((endOf(item, now) - item.createdAtMs) / total) * n)),
  )
  const color: Paint =
    item.status === "failed" ? "red" : item.status === "live" ? "green" : "magenta"
  return [
    { text: "▕", color: "dim" },
    { text: " ".repeat(start) },
    { text: "▬".repeat(len), color: item.durationMs === undefined ? "dim" : color },
    { text: " ".repeat(n - start - len) },
    { text: "▏", color: "dim" },
  ]
}

function treeRow(f: Flat, plan: TreePlan, span: { t0: number; t1: number }, now: number): Seg[] {
  const { item } = f.node
  const kid = f.depth > 0
  const roleCell = plan.roleWidth + ARM_WIDTH * (plan.maxDepth - f.depth)
  const role = padEndDisplay(
    displayWidth(f.node.label) > plan.roleWidth
      ? `${sliceDisplayWidth(f.node.label, plan.roleWidth - 1)}${ELLIPSIS}`
      : f.node.label,
    roleCell,
  )
  const left: Seg[] = [
    { text: INDENT },
    { text: armOf(f), color: "dim" },
    GLYPH[item.status],
    { text: " " },
    { text: role, color: kid ? "yellow" : "bold" },
    { text: " " },
    { text: shortSid(item.sid), color: kid ? "dim" : "cyan" },
  ]
  const pad = INDENT.length + plan.leftWidth - segWidth(left)
  const segs: Seg[] = [...left, { text: " ".repeat(Math.max(0, pad)) }]
  if (plan.bar > 0) segs.push({ text: "  " }, ...barSegs(item, span, plan.bar, now))
  if (plan.dur) {
    const dur = item.durationMs === undefined ? "" : formatDuration(item.durationMs)
    segs.push({ text: ` ${padStartDisplay(dur, DUR_WIDTH)}`, color: "dim" })
  }
  if (plan.tok) {
    segs.push({ text: ` ${padStartDisplay(formatTokensCell(item), TOK_WIDTH)}`, color: "dim" })
  }
  return segs
}

function statusWord(status: SessionListStatus): string {
  return status === "unknown" ? "status unknown" : status
}

/** The header facts, joined with ` · ` and wrapped to the width. */
function metaLines(
  view: SessionDetailView,
  opts: SessionDetailRenderOptions,
  width: number,
): Seg[][] {
  const { item } = view.root
  const room = Math.max(1, width - INDENT.length)
  const zone = { now: opts.now, timeZone: opts.timeZone }
  const parts: Seg[][] = []
  if (view.forkOf) {
    parts.push([{ text: `↻ resumed from ${view.forkOf.slice(0, 8)}`, color: "dim" }])
  }
  if (view.modelLabel) parts.push([{ text: view.modelLabel, color: "dim" }])
  if (view.cwd) {
    const cwd = formatCwd(view.cwd, Math.min(room, 48), {
      ...(opts.home === undefined ? {} : { home: opts.home }),
    })
    parts.push([{ text: cwd, color: "dim" }])
  }
  parts.push([
    {
      text: `${formatDayLabel(item.createdAtMs, zone)} ${formatLocalTime(item.createdAtMs, zone)}`,
      color: "dim",
    },
  ])
  if (item.durationMs !== undefined) {
    parts.push([{ text: formatDuration(item.durationMs), color: "dim" }])
  }
  if (view.turns !== undefined) {
    parts.push([{ text: `${view.turns} turn${view.turns === 1 ? "" : "s"}`, color: "dim" }])
  }
  if (item.tokens !== undefined) {
    parts.push([{ text: `${formatTokensCell(item)} tok`, color: "dim" }])
  }
  if (item.costUsd !== undefined) parts.push([{ text: formatCost(item.costUsd), color: "dim" }])
  parts.push([GLYPH[item.status], { text: ` ${statusWord(item.status)}`, color: "dim" }])

  const lines: Seg[][] = []
  const indent: Seg = { text: INDENT }
  let line: Seg[] = [indent]
  for (const part of parts) {
    const sep: Seg[] = line.length > 1 ? [{ text: " · ", color: "dim" }] : []
    const used = segWidth(line) - INDENT.length
    if (line.length > 1 && used + segWidth(sep) + segWidth(part) > room) {
      lines.push(line)
      line = [indent, ...part]
      continue
    }
    line.push(...sep, ...part)
  }
  if (line.length > 1) lines.push(line)
  return lines
}

function titleText(item: SessionListItem): string {
  const title = toCellText(item.title).trim()
  return title.length > 0 ? title : item.hiddenReason ? `(${item.hiddenReason})` : "(no prompt)"
}

/** The dim `✦ ` mark before an `ai` title (SPEC §9.4, Q7), as in the list. */
function titleMark(item: Pick<SessionListItem, "title" | "titleSource">): Seg[] {
  if (item.titleSource !== "ai" || toCellText(item.title).trim().length === 0) return []
  return [{ text: "✦ ", color: "dim" }]
}

/** The column of the title in the header: indent, short sid, two spaces. */
const TITLE_COL = INDENT.length + 8 + 2

/**
 * The first prompt under a saved title (dim, quoted), or `undefined` when
 * the session has no saved title, no known prompt, or the two are the same.
 */
function promptLine(item: SessionListItem): string | undefined {
  if (item.titleSource === undefined || item.prompt === undefined) return undefined
  const prompt = toCellText(item.prompt).trim()
  if (prompt.length === 0 || prompt === toCellText(item.title).trim()) return undefined
  return `"${prompt}"`
}

/**
 * A title-call cost. Title calls are small, so a cost below one cent keeps
 * four decimals (`$0.0001`), not the `<$0.01` of the session cost.
 */
function formatTitleCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0 || usd >= 0.01) return formatCost(usd)
  if (usd === 0) return "$0.00"
  return usd < 0.0001 ? "<$0.0001" : `$${usd.toFixed(4)}`
}

/** `title: ai`, `<model>`, `<in> in / <out> out`, `$<cost> …` (known parts only). */
function titleMetaParts(meta: SessionTitleMeta): string[] {
  const parts = [`title: ${meta.source}`]
  if (meta.model) parts.push(toCellText(meta.model))
  if (meta.inputTokens !== undefined && meta.outputTokens !== undefined) {
    parts.push(
      `${formatTokenCount(meta.inputTokens)} in / ${formatTokenCount(meta.outputTokens)} out`,
    )
  }
  // SPEC §10: the title cost is not in the session cost or `/usage`.
  if (meta.costUsd !== undefined) {
    parts.push(`${formatTitleCost(meta.costUsd)} (not in session cost)`)
  }
  return parts
}

/** Join parts with ` · ` into dim lines that fit `room` cells after `lead`. */
function wrapParts(parts: readonly string[], lead: Seg, room: number): Seg[][] {
  const lines: Seg[][] = []
  let text = ""
  for (const part of parts) {
    const next = text.length === 0 ? part : `${text} · ${part}`
    if (text.length > 0 && displayWidth(next) > room) {
      lines.push([lead, { text, color: "dim" }])
      text = part
      continue
    }
    text = next
  }
  if (text.length > 0) lines.push([lead, { text, color: "dim" }])
  return lines
}

/**
 * The rows under the header title: the first prompt (one line, cut), then
 * the title meta line (wrapped at ` · `). Both start under the title when
 * the width has room, else at the indent.
 */
function titleRows(view: SessionDetailView, width: number): Seg[][] {
  const col = width >= TITLE_COL + 20 ? TITLE_COL : INDENT.length
  const lead: Seg = { text: " ".repeat(col) }
  const rows: Seg[][] = []
  const prompt = promptLine(view.root.item)
  if (prompt !== undefined) rows.push([lead, { text: prompt, color: "dim" }])
  if (view.titleMeta) {
    rows.push(...wrapParts(titleMetaParts(view.titleMeta), lead, Math.max(1, width - col)))
  }
  return rows
}

/** All failed sessions under the root, in tree order. */
function failedKids(rows: readonly Flat[]): Flat[] {
  return rows.filter((r) => r.depth > 0 && r.node.item.status === "failed")
}

/**
 * Render the detail view as rows (no trailing newline, no stream write).
 * No row is wider than `opts.width`.
 */
export function renderSessionDetail(
  view: SessionDetailView,
  opts: SessionDetailRenderOptions,
): string[] {
  const width = Math.max(1, Math.floor(opts.width))
  const now = opts.now ?? Date.now()
  const out = (segs: readonly Seg[]): string => paintLine(segs, width, opts.color)
  const { item } = view.root
  const rows: string[] = [""]
  rows.push(
    out([
      { text: INDENT },
      { text: shortSid(item.sid), color: "cyan" },
      { text: "  " },
      ...titleMark(item),
      { text: titleText(item), color: "bold" },
    ]),
  )
  for (const line of titleRows(view, width)) rows.push(out(line))
  for (const line of metaLines(view, opts, width)) rows.push(out(line))
  if (view.leadSid !== undefined) {
    const lead8 = shortSid(view.leadSid)
    rows.push(
      out([
        { text: INDENT },
        { text: `sub-agent of ${lead8} · ma sessions ${lead8}`, color: "dim" },
      ]),
    )
  }
  rows.push("")

  const flat = flatten(view.root)
  if (flat.length === 1) {
    rows.push(out([{ text: INDENT }, { text: "no sub-agent sessions", color: "dim" }]))
  } else {
    const plan = planTree(flat, width)
    const t0 = flat.reduce((n, f) => Math.min(n, f.node.item.createdAtMs), item.createdAtMs)
    const t1 = flat.reduce((n, f) => Math.max(n, endOf(f.node.item, now)), endOf(item, now))
    for (const f of flat) {
      rows.push(out(treeRow(f, plan, { t0, t1 }, now)))
      if (f.depth > 0) {
        rows.push(
          out([
            { text: INDENT },
            { text: contOf(f), color: "dim" },
            ...titleMark(f.node.item),
            { text: titleText(f.node.item), color: "dim" },
          ]),
        )
      }
    }
  }

  rows.push("")
  for (const f of failedKids(flat)) {
    const sid8 = shortSid(f.node.item.sid)
    rows.push(
      out([
        { text: INDENT },
        { text: `failed: ${f.node.label} ${sid8} → ma sessions dump ${sid8}`, color: "dim" },
      ]),
    )
  }
  rows.push(
    out([
      { text: INDENT },
      { text: `resume: ma sessions resume ${shortSid(item.sid)}`, color: "dim" },
    ]),
  )
  return rows
}

/** One match of an ambiguous sid prefix. */
export interface SessionPrefixMatch {
  sid: string
  createdAtMs: number
  /** The shown title: the saved title (user, then ai, then derived), else the first prompt. */
  title: string
  /** Source of a saved title. Absent: `title` is the first prompt. */
  titleSource?: "user" | "ai" | "derived"
  status: SessionListStatus
  /** Set for a sub-agent session. */
  leadSid?: string
}

/** Most matches that the ambiguous list shows. */
export const MAX_PREFIX_MATCHES = 20

/** Render the list for a sid prefix that matches more than one session. */
export function renderAmbiguousPrefix(
  prefix: string,
  matches: readonly SessionPrefixMatch[],
  opts: SessionDetailRenderOptions,
): string[] {
  const width = Math.max(1, Math.floor(opts.width))
  const out = (segs: readonly Seg[]): string => paintLine(segs, width, opts.color)
  const zone = { now: opts.now, timeZone: opts.timeZone }
  const rows = [
    "",
    out([
      { text: INDENT },
      { text: `${matches.length} sessions start with ${toCellText(prefix)}`, color: "dim" },
    ]),
  ]
  for (const m of matches.slice(0, MAX_PREFIX_MATCHES)) {
    const when = `${formatDayLabel(m.createdAtMs, zone)} ${formatLocalTime(m.createdAtMs, zone)}`
    const title = toCellText(m.title).trim() || "(no prompt)"
    rows.push(
      out([
        { text: INDENT },
        GLYPH[m.status],
        { text: " " },
        { text: m.sid.slice(0, 13), color: "cyan" },
        { text: `  ${padEndDisplay(when, 16)}  `, color: "dim" },
        ...(m.leadSid
          ? [{ text: `sub-agent of ${shortSid(m.leadSid)} · `, color: "yellow" as const }]
          : []),
        ...titleMark(m),
        { text: title },
      ]),
    )
  }
  if (matches.length > MAX_PREFIX_MATCHES) {
    rows.push(
      out([
        { text: INDENT },
        { text: `+${matches.length - MAX_PREFIX_MATCHES} more`, color: "dim" },
      ]),
    )
  }
  rows.push(
    "",
    out([
      { text: INDENT },
      { text: "type more characters of the session id: ma sessions <sid>", color: "dim" },
    ]),
  )
  return rows
}
