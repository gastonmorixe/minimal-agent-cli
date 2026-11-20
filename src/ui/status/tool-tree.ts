/**
 * The live tool tree: the rows that show the tool calls of a run while they
 * run. Pure: a snapshot of the open calls and a clock go in, rows (strings)
 * come out. Terms: `GLOSSARY.md` (tool call, wave, concurrency cap).
 *
 * ```
 * ● Running 4 tools · 1 queued · 12s
 * ├ ○ ⤓ Fetch  npr.org/sections/news
 * ├ ● • Read   src/sdk/tool-calls.ts   14s
 * ╰ ○ ⌕ Grep   "runToolCalls" in src/
 * ```
 *
 * - One running call, nothing queued: one row, no tree.
 * - A `Bash` call also shows its time limit: `· 10s / 2m`, or `· timeout 2m`
 *   in its first second. The limit comes from core (`resolveBashTimeout`).
 * - The header counts from the oldest call that still runs.
 * - The dot of a row blinks `●` / `○`, one frame per second. Its phase is
 *   fixed when the call starts (see `tool-calls.ts`). In truecolor the `●`
 *   fades from the tool color to dim in {@link FADE_STEPS} steps.
 * - At most {@link MAX_TREE_ROWS} call rows, and fewer when the tree would
 *   take more than half the terminal height. The calls that do not fit, and
 *   the queued calls, go side by side on the last tree row, in short form.
 *
 * @module ui/status/tool-tree
 */

import { resolveBashTimeout } from "@minimal-agent/core/host/tool-catalog"
import { stripAnsi, truncateDisplayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"
import { effectiveDisplayWidth } from "../../terminal/nerd-glyph-width.ts"
import { ansiStyle } from "../../terminal-kit/ansi.ts"
import type { ToolPresentation } from "../tool-transcript/format.ts"
import { DEFAULT_TOOL_ICON } from "../tool-transcript/format.ts"
import { HEADER_PHASE, type LiveToolCall, type ToolCallsSnapshot } from "./tool-calls.ts"

/** The most call rows of the tree (the side-by-side row counts as one). */
export const MAX_TREE_ROWS = 10

/** The steps of the fade of a `●` in truecolor. */
export const FADE_STEPS = 5

/** One blink frame lasts this long. A full cycle is two frames. */
export const BLINK_FRAME_MS = 1000

/** A row shows its own time when it differs from the header time by this much. */
export const ROW_TIME_MIN_DIFF_MS = 2000

/** The most lines of the side-by-side row. */
const SIDE_BY_SIDE_MAX_LINES = 2

const ELLIPSIS = "…"
const DOT_ON = "●"
const DOT_OFF = "○"
const DOT_QUEUED = "◌"
const TREE_MID = "├"
const TREE_LAST = "╰"
const GAP = "   "
const NAME_MAX_CELLS = 22

/** What {@link renderToolTree} needs. */
export interface ToolTreeInput {
  snapshot: ToolCallsSnapshot
  /** Wall clock, epoch ms. */
  now: number
  /** Terminal width. Rows are at most `columns - 1` cells wide. */
  columns: number
  /** Terminal height. */
  rows: number
  /** A modal is open: dim `○` dots, no blink, no timer growth. */
  paused?: boolean
  /** Fade the `●` in truecolor. `false`: only the glyph changes. */
  fade?: boolean
  presentation: ReadonlyMap<string, ToolPresentation>
  /** The dir that paths are shown relative to. */
  cwd: string
  /** The user's home dir, for `~` paths outside the cwd. */
  home?: string
}

type RGB = readonly [number, number, number]

/** The dim end of the fade, and the color of a dim dot. */
const DIM_RGB: RGB = [96, 96, 96]

const LEGACY_RGB: readonly RGB[] = [
  [0, 0, 0],
  [205, 49, 49],
  [13, 188, 121],
  [229, 229, 16],
  [36, 114, 200],
  [188, 63, 188],
  [17, 168, 205],
  [229, 229, 229],
]

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const

/** The RGB of an xterm 256-color index. */
function xterm256ToRgb(index: number): RGB {
  if (index < 8) return LEGACY_RGB[index] ?? DIM_RGB
  if (index < 16) return LEGACY_RGB[index - 8] ?? DIM_RGB
  if (index >= 232) {
    const level = 8 + (index - 232) * 10
    return [level, level, level]
  }
  const n = index - 16
  return [
    CUBE_LEVELS[Math.floor(n / 36)] ?? 0,
    CUBE_LEVELS[Math.floor(n / 6) % 6] ?? 0,
    CUBE_LEVELS[n % 6] ?? 0,
  ]
}

/** The RGB behind a foreground SGR open sequence, or `null` when unknown. */
export function sgrToRgb(open: string): RGB | null {
  const rgb = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(open)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  const idx = /\x1b\[38;5;(\d+)m/.exec(open)
  if (idx) return xterm256ToRgb(Number(idx[1]))
  const legacy = /\x1b\[(3[0-7]|9[0-7])m/.exec(open)
  if (legacy) {
    const code = Number(legacy[1])
    return xterm256ToRgb(code >= 90 ? code - 90 + 8 : code - 30)
  }
  return null
}

function mix(from: RGB, to: RGB, t: number): RGB {
  const at = (i: 0 | 1 | 2): number => Math.round(from[i] + (to[i] - from[i]) * t)
  return [at(0), at(1), at(2)]
}

function fgRgb([r, g, b]: RGB): (text: string) => string {
  return (text) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`
}

/** The foreground SGR open sequence of a color name of the `c` helper set. */
function openOf(color: string | undefined): string {
  const wrap = color ? (ansiStyle as Record<string, unknown>)[color] : undefined
  const style = typeof wrap === "function" ? (wrap as (s: string) => string) : ansiStyle.orange
  const probe = style("\u0001")
  return probe.slice(0, probe.indexOf("\u0001"))
}

/** How one tool is drawn: its icon and the color functions. */
interface ToolLook {
  icon: string
  paint: (text: string) => string
  rgb: RGB | null
}

function lookOf(name: string, presentation: ReadonlyMap<string, ToolPresentation>): ToolLook {
  const pres = presentation.get(name)
  const open = openOf(pres?.color)
  return {
    icon: pres?.icon || DEFAULT_TOOL_ICON,
    paint: (text) => `${open}${text}\x1b[39m`,
    rgb: sgrToRgb(open),
  }
}

/** Format an elapsed time: `12s`, `1m04s`, `1h02m`. */
export function formatToolTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
}

/**
 * Format a time limit: `200ms`, `45s`, `2m`, `1m30s`. As
 * {@link formatToolTime}, but without a zero last part (`2m`, not `2m00s`),
 * and in ms below one second.
 */
export function formatToolLimit(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  return formatToolTime(ms).replace(/(?<=[hm])00[ms]$/, "")
}

/**
 * The time limit of a call in ms, or `null` when the tool has none to show.
 * Only `Bash` has one. Core owns the rules (default, maximum).
 */
function limitMsOf(call: LiveToolCall): number | null {
  return call.name === "Bash" ? resolveBashTimeout(call.input.timeout).timeoutMs : null
}

/**
 * The time text of a call with a time limit: `10s / 2m`, or `timeout 2m`
 * when `showElapsed` is false or in the first second.
 */
function limitTimeText(ms: number, limitMs: number, showElapsed: boolean): string {
  const limit = formatToolLimit(limitMs)
  return showElapsed && ms >= 1000 ? `${formatToolTime(ms)} / ${limit}` : `timeout ${limit}`
}

/**
 * The dot of a running call at `now`. A call of phase `p` shows `●` while
 * `floor(now / 1000) + p` is even. Without fade only the glyph changes;
 * with fade the `●` goes from the tool color to dim over its frame.
 */
export function blinkDot(phase: 0 | 1, now: number, look: ToolLook, fade: boolean): string {
  const second = Math.floor(now / BLINK_FRAME_MS)
  const on = (second + phase) % 2 === 0
  if (!on) return fade ? fgRgb(DIM_RGB)(DOT_OFF) : look.paint(DOT_OFF)
  if (!fade || !look.rgb) return look.paint(DOT_ON)
  const into = now - second * BLINK_FRAME_MS
  const step = Math.min(FADE_STEPS - 1, Math.floor((into / BLINK_FRAME_MS) * FADE_STEPS))
  return fgRgb(mix(look.rgb, DIM_RGB, step / FADE_STEPS))(DOT_ON)
}

function dimDot(glyph: string): string {
  return ansiStyle.dim(glyph)
}

/** Cut `text` to `budget` cells. The cut is at the end, marked with `…`. */
function cutEnd(text: string, budget: number): string {
  if (budget <= 0) return ""
  if (effectiveDisplayWidth(text) <= budget) return text
  return `${truncateDisplayWidth(text, Math.max(0, budget - 1), "")}${ELLIPSIS}`
}

/** Cut `text` to `budget` cells. The cut is in the middle, marked with `…`. */
export function cutMiddle(text: string, budget: number): string {
  if (budget <= 0) return ""
  if (effectiveDisplayWidth(text) <= budget) return text
  if (budget <= 3) return cutEnd(text, budget)
  const chars = Array.from(text)
  const keep = budget - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${chars.slice(0, head).join("")}${ELLIPSIS}${tail > 0 ? chars.slice(-tail).join("") : ""}`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** A URL without its scheme, a leading `www.` and a trailing `/`. */
export function shortUrl(url: string): string {
  return oneLine(url)
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "")
}

/** A path relative to `cwd`, or `~/…` under home, or the path itself. */
export function shortPath(path: string, cwd: string, home?: string): string {
  const clean = oneLine(path)
  const under = (root: string): string | null => {
    const base = root.endsWith("/") ? root : `${root}/`
    return clean.startsWith(base) ? clean.slice(base.length) : clean === root ? "." : null
  }
  const rel = clean.startsWith("/") ? under(cwd) : clean
  if (rel !== null) return rel.startsWith("./") ? rel.slice(2) : rel
  const tilde = home ? under(home) : null
  return tilde !== null ? `~/${tilde}` : clean
}

const PATH_KEYS = ["file_path", "path", "notebook_path"] as const
const TEXT_KEYS = ["url", "query", "command", "pattern", "name", "id", "title"] as const

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

/**
 * The short target of a call, for the row text: the URL of `Fetch`, a
 * path relative to the cwd, `"pattern" in path` for `Grep`, else the first
 * useful text of the input. Not cut to a width yet.
 */
export function shortTarget(
  name: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string,
  home?: string,
): string {
  const url = str(input.url)
  if (url) return shortUrl(url)
  if (name === "Grep") {
    const pattern = str(input.pattern)
    const path = str(input.path)
    if (pattern) {
      const where = path ? ` in ${shortPath(path, cwd, home)}` : ""
      return `"${oneLine(pattern)}"${where}`
    }
  }
  if (name === "Glob") {
    const pattern = str(input.pattern)
    const path = str(input.path)
    if (pattern)
      return path ? `${shortPath(path, cwd, home)}/${oneLine(pattern)}` : oneLine(pattern)
  }
  for (const key of PATH_KEYS) {
    const value = str(input[key])
    if (value) return shortPath(value, cwd, home)
  }
  for (const key of TEXT_KEYS) {
    const value = str(input[key])
    if (value) return oneLine(value)
  }
  return ""
}

/** True when the terminal can show 24-bit color (`COLORTERM`). */
export function supportsTruecolor(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = (env.COLORTERM ?? "").toLowerCase()
  return value === "truecolor" || value === "24bit"
}

/** One call, with what the rows need. */
interface Item {
  call: LiveToolCall
  look: ToolLook
  target: string
}

function itemOf(call: LiveToolCall, input: ToolTreeInput): Item {
  return {
    call,
    look: lookOf(call.name, input.presentation),
    target: shortTarget(call.name, call.input, input.cwd, input.home),
  }
}

/** The dot of an item at the time of the frame. */
function dotOf(item: Item, input: ToolTreeInput): string {
  if (item.call.state === "queued") return dimDot(DOT_QUEUED)
  if (input.paused) return dimDot(DOT_OFF)
  return blinkDot(item.call.phase, input.now, item.look, input.fade === true)
}

/** The oldest start among the running calls. */
function oldestStart(running: readonly LiveToolCall[]): number {
  let oldest = Number.POSITIVE_INFINITY
  for (const call of running) if (call.startedAt < oldest) oldest = call.startedAt
  return oldest
}

function headerTimeMs(input: ToolTreeInput): number {
  const oldest = oldestStart(input.snapshot.running)
  return Number.isFinite(oldest) ? Math.max(0, input.now - oldest) : 0
}

/** ` · 12s`, dim. Empty in the first second, so no `·` hangs at the end. */
function timeSuffix(ms: number): string {
  return ms < 1000 ? "" : ansiStyle.dim(` · ${formatToolTime(ms)}`)
}

function toolsWord(count: number): string {
  return `${count} ${count === 1 ? "tool" : "tools"}`
}

function headerRow(input: ToolTreeInput, items: readonly Item[]): string {
  const { running, queued } = input.snapshot
  const first = items[0]
  const time = timeSuffix(headerTimeMs(input))
  if (input.paused) {
    return `${dimDot(DOT_OFF)} ${ansiStyle.dim(`Paused · ${toolsWord(running.length)}`)}${time}`
  }
  const dot = first
    ? blinkDot(HEADER_PHASE, input.now, first.look, input.fade === true)
    : dimDot(DOT_OFF)
  const wait = queued.length > 0 ? ansiStyle.dim(` · ${queued.length} queued`) : ""
  return `${dot} Running ${toolsWord(running.length)}${wait}${time}`
}

/**
 * `● Running ⤓ Fetch  target · 3s`: the form for exactly one call. A call
 * with a time limit shows it: `● Running » Bash  target · 10s / 2m`. When the
 * row has no room for the limit, the suffix is the elapsed time only.
 */
function singleRow(input: ToolTreeInput, item: Item, budget: number): string {
  const ms = input.now - item.call.startedAt
  const verb = input.paused ? ansiStyle.dim("Paused") : "Running"
  const head = `${dotOf(item, input)} ${verb} ${item.look.paint(item.look.icon)} ${item.look.paint(item.call.name)}`
  const headW = effectiveDisplayWidth(stripAnsi(head))
  const limitMs = limitMsOf(item.call)
  const withLimit = limitMs === null ? "" : ` · ${limitTimeText(ms, limitMs, true)}`
  const time =
    withLimit && headW + withLimit.length <= budget ? ansiStyle.dim(withLimit) : timeSuffix(ms)
  const used = headW + effectiveDisplayWidth(stripAnsi(time))
  const room = budget - used - 2
  const target = item.target && room >= 4 ? `  ${cutMiddle(item.target, room)}` : ""
  return `${head}${target}${time}`
}

/**
 * The full rows: `├ ● ⤓ Fetch  target     12s`. A row with a time limit
 * always shows it: `├ ● » Bash   target     12s / 2m`, or `timeout 2m` in its
 * first second and while paused.
 */
function callRows(
  input: ToolTreeInput,
  items: readonly Item[],
  lastIsFinal: boolean,
  budget: number,
): string[] {
  const iconW = Math.max(1, ...items.map((item) => effectiveDisplayWidth(item.look.icon)))
  const names = items.map((item) => cutEnd(item.call.name, NAME_MAX_CELLS))
  const nameW = Math.max(1, ...names.map((name) => effectiveDisplayWidth(name)))
  const prefix = 2 + 2 + iconW + 1 + nameW + 2
  const headerMs = headerTimeMs(input)
  return items.map((item, idx) => {
    const last = lastIsFinal && idx === items.length - 1
    const tree = ansiStyle.dim(last ? TREE_LAST : TREE_MID)
    const name = names[idx] ?? ""
    const iconPad = " ".repeat(iconW - effectiveDisplayWidth(item.look.icon))
    const namePad = " ".repeat(nameW - effectiveDisplayWidth(name))
    const rowMs = input.now - item.call.startedAt
    const showTime = !input.paused && Math.abs(headerMs - rowMs) >= ROW_TIME_MIN_DIFF_MS
    const plainTime = showTime ? formatToolTime(rowMs) : ""
    const limitMs = limitMsOf(item.call)
    const withLimit = limitMs === null ? "" : limitTimeText(rowMs, limitMs, !input.paused)
    // The limit needs room next to a short target. If not, only the time.
    const time = withLimit && budget - prefix - (withLimit.length + 2) >= 4 ? withLimit : plainTime
    const timeW = time ? time.length + 2 : 0
    const room = Math.max(0, budget - prefix - timeW)
    const target = cutMiddle(item.target, room)
    const left =
      `${tree} ${dotOf(item, input)} ${item.look.paint(item.look.icon)}${iconPad} ` +
      `${item.look.paint(name)}${namePad}  ${target}`
    if (!time) return left
    const gap = Math.max(2, budget - effectiveDisplayWidth(stripAnsi(left)) - time.length)
    return `${left}${" ".repeat(gap)}${ansiStyle.dim(time)}`
  })
}

/** The short form of one call, for the side-by-side row. */
function shortForm(item: Item, input: ToolTreeInput, targetBudget: number): string {
  const target = item.target ? ` ${cutMiddle(item.target, targetBudget)}` : ""
  return `${dotOf(item, input)} ${item.look.paint(item.look.icon)}${target}`
}

function plainWidth(text: string): number {
  return effectiveDisplayWidth(stripAnsi(text))
}

/**
 * The side-by-side row: the short forms of `items`, as many per line as
 * fit, in at most 2 lines. The second line is indented under the first call.
 * What does not fit is cut with `…`.
 */
function sideBySideRows(items: readonly Item[], input: ToolTreeInput, budget: number): string[] {
  const lead = `${ansiStyle.dim(TREE_LAST)} `
  const indent = "  "
  const room = Math.max(8, budget - 2)
  const lines: string[][] = [[]]
  const widths = [0]
  let overflow = false
  for (const item of items) {
    const form = shortForm(item, input, Math.max(4, room - 6))
    const width = plainWidth(form)
    let line = lines.length - 1
    const used = widths[line] ?? 0
    const need = used === 0 ? width : used + GAP.length + width
    if (need > room && used > 0) {
      if (lines.length >= SIDE_BY_SIDE_MAX_LINES) {
        overflow = true
        break
      }
      lines.push([])
      widths.push(0)
      line = lines.length - 1
    }
    lines[line]?.push(form)
    widths[line] = (widths[line] ?? 0) === 0 ? width : (widths[line] ?? 0) + GAP.length + width
  }
  const rows = lines.map((parts, idx) => `${idx === 0 ? lead : indent}${parts.join(GAP)}`)
  if (overflow) {
    const lastIdx = rows.length - 1
    const used = (widths[lastIdx] ?? 0) + 2
    rows[lastIdx] =
      used + 1 <= budget ? `${rows[lastIdx]}${ansiStyle.dim(ELLIPSIS)}` : (rows[lastIdx] ?? "")
  }
  return rows
}

/** How many lines the tree may take: half the terminal, header included. */
function lineBudget(rows: number): number {
  return Math.max(2, Math.floor(rows / 2))
}

/**
 * The status rows for the open tool calls, or `[]` when no call runs.
 * One row for one call and nothing queued. Else the header, then the tree.
 */
export function renderToolTree(input: ToolTreeInput): string[] {
  const { running, queued } = input.snapshot
  if (running.length === 0) return []
  const budget = Math.max(10, input.columns - 1)
  const runningItems = running.map((call) => itemOf(call, input))
  const queuedItems = queued.map((call) => itemOf(call, input))
  const only = runningItems[0]
  if (running.length === 1 && queued.length === 0 && only) {
    return [singleRow(input, only, budget)]
  }
  const header = headerRow(input, runningItems)
  // Header plus rows: at most half the terminal. The side-by-side row can
  // take 2 lines, so reserve them when it exists.
  const lines = lineBudget(input.rows) - 1
  let limit = Math.max(1, Math.min(MAX_TREE_ROWS, lines))
  for (;;) {
    // Queued calls take the last row. Running calls that do not fit join them.
    const extraRow = queuedItems.length > 0 ? 1 : 0
    const individual =
      runningItems.length + extraRow <= limit ? runningItems : runningItems.slice(0, limit - 1)
    const rest = [...runningItems.slice(individual.length), ...queuedItems]
    const rows = callRows(input, individual, rest.length === 0, budget)
    const side = rest.length > 0 ? sideBySideRows(rest, input, budget) : []
    const used = rows.length + side.length
    if (used <= lines || limit <= 1) return [header, ...rows, ...side]
    limit -= 1
  }
}
