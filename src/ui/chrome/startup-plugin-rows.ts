/**
 * Format plugin-contributed rows for the startup tree.
 *
 * Plugins answer the `startup.rows` chain with semantic rows (label,
 * summary parts, optional children). They never send ANSI. This module
 * maps the semantic tones onto the CLI theme and lays the rows out as
 * tree lines that line up with the rows `ui/startup/tree.ts` prints:
 *
 *     │ tools      ± ShowDiff · MemoryTool · WebSearch
 *     │ hooks      3 active · 1 untrusted
 *     │   ├ turn.willStart   timestamp.sh  before
 *     │   ├ tool.willInvoke  Bash → guard.sh  claude
 *     │   └ turn.willStop    Stop → run-tests.sh  claude · untrusted
 *     ╰ mode       ASK
 *
 * (each line also has the 2-space left indent that tree.ts uses.)
 *
 * Pure: it returns lines and prints nothing. The caller decides `plain`
 * (for example with `resolveHelpColor` from `ui/help/policy.ts`: no TTY,
 * NO_COLOR, or TERM=dumb) and passes the terminal width.
 *
 * Rules:
 *
 * - Order: rows with a numeric `order` come first, ascending. Rows with
 *   no `order` follow in input order. The sort is stable.
 * - A row with an empty `summary` and no children is skipped.
 * - Row line: `  │ <label.padEnd(9)>  <summary parts joined by " · ">`.
 * - Child line: `  │   ├ <label padded to the widest child label>  <value>`.
 *   The last shown child uses `└`.
 * - Child value: the first part, two spaces, then the other parts
 *   joined by " · " (`Stop → run-tests.sh  claude · untrusted`).
 * - At most 8 children. When more exist, the 8th uses `├` and a final
 *   `└ … N more` line follows.
 * - `last: true` (the group closes the tree): the final row line uses the
 *   `╰` closer and its children draw a blank gutter (no `│` under `╰`).
 *   Earlier rows in the group keep `│`.
 * - Every line is truncated to `cols` with `truncateDisplayWidth`.
 *
 * Tone map (color mode): default = no style, dim = `c.dim`,
 * accent = `c.sky` (the color of the tree labels), warn = `c.yellow`,
 * ok = `c.green` (the yellow/green pair the auth and quota rows use).
 * Gutters and tree glyphs use `c.faintWhite`, separators use `c.dim`,
 * row labels use `c.sky`. In plain mode no styling is applied at all.
 *
 * @module ui/chrome/startup-plugin-rows
 */

import type { StartupRow, StartupRowPart } from "@minimal-agent/core/plugin-api"
import { truncateDisplayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"

import { c } from "../style/ansi.ts"

/** One styled text fragment. Tones are semantic, the CLI picks the color. */
export type Part = StartupRowPart

export type { StartupRow }

/** Options for {@link renderStartupPluginRows}. */
export interface StartupPluginRowsOptions {
  /** Terminal width. Each line is truncated to it. */
  cols: number
  /** True for a non-TTY or NO_COLOR: emit no ANSI at all. */
  plain: boolean
  /** True when this group is the final element of the tree (draw `╰`). */
  last?: boolean
}

/** Maximum children shown per row before the `… N more` line. */
export const MAX_STARTUP_CHILDREN = 8

/** Label column width, same as `label.padEnd(9)` in tree.ts. */
const LABEL_WIDTH = 9

type Painter = (s: string) => string
const identity: Painter = (s) => s

const TONE_PAINTERS: Record<NonNullable<Part["tone"]>, Painter> = {
  default: identity,
  dim: c.dim,
  accent: c.sky,
  warn: c.yellow,
  ok: c.green,
}

interface Theme {
  tone(part: Part): string
  sep(s: string): string
  rail(s: string): string
  label(s: string): string
}

function makeTheme(plain: boolean): Theme {
  if (plain) {
    return { tone: (p) => p.text, sep: identity, rail: identity, label: identity }
  }
  return {
    tone: (p) => TONE_PAINTERS[p.tone ?? "default"](p.text),
    sep: c.dim,
    rail: c.faintWhite,
    label: c.sky,
  }
}

/** Sort rows: ordered rows first (ascending), then unordered in input order. */
function sortRows(rows: ReadonlyArray<StartupRow>): StartupRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const ao = a.row.order
      const bo = b.row.order
      if (ao !== undefined && bo !== undefined && ao !== bo) return ao - bo
      if (ao !== undefined && bo === undefined) return -1
      if (ao === undefined && bo !== undefined) return 1
      return a.index - b.index
    })
    .map((e) => e.row)
}

function joinParts(parts: ReadonlyArray<Part>, theme: Theme): string {
  return parts.map((p) => theme.tone(p)).join(theme.sep(" · "))
}

function formatChildValue(parts: ReadonlyArray<Part>, theme: Theme): string {
  const [head, ...tags] = parts
  if (!head) return ""
  const main = theme.tone(head)
  return tags.length === 0 ? main : `${main}  ${joinParts(tags, theme)}`
}

function renderRow(row: StartupRow, closes: boolean, theme: Theme): string[] {
  const rowGutter = theme.rail(closes ? "╰" : "│")
  const childGutter = closes ? " " : theme.rail("│")
  const summary = joinParts(row.summary, theme)
  const head = `  ${rowGutter} ${theme.label(row.label.padEnd(LABEL_WIDTH))}`
  const lines = [summary === "" ? head.trimEnd() : `${head}  ${summary}`]

  const children = row.children ?? []
  const shown = children.slice(0, MAX_STARTUP_CHILDREN)
  const hidden = children.length - shown.length
  const width = Math.max(0, ...shown.map((ch) => ch.label.length))
  shown.forEach((ch, i) => {
    const isLast = i === shown.length - 1 && hidden === 0
    const glyph = theme.rail(isLast ? "└" : "├")
    const value = formatChildValue(ch.value, theme)
    const label = ch.label.padEnd(width)
    const line = `  ${childGutter}   ${glyph} ${label}${value === "" ? "" : `  ${value}`}`
    lines.push(value === "" ? line.trimEnd() : line)
  })
  if (hidden > 0) {
    lines.push(`  ${childGutter}   ${theme.rail("└")} ${theme.sep(`… ${hidden} more`)}`)
  }
  return lines
}

/**
 * Render plugin-contributed startup rows as tree lines.
 *
 * @param rows - Rows from the `startup.rows` chain.
 * @param opts - Width, plain mode, and whether the group closes the tree.
 * @returns One string per physical line, each fit to `opts.cols`.
 */
export function renderStartupPluginRows(
  rows: ReadonlyArray<StartupRow>,
  opts: StartupPluginRowsOptions,
): string[] {
  const theme = makeTheme(opts.plain)
  const visible = sortRows(rows).filter(
    (row) => row.summary.length > 0 || (row.children?.length ?? 0) > 0,
  )
  const lines: string[] = []
  visible.forEach((row, i) => {
    const closes = opts.last === true && i === visible.length - 1
    lines.push(...renderRow(row, closes, theme))
  })
  return lines.map((line) => truncateDisplayWidth(line, opts.cols))
}
