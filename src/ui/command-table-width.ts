/**
 * Width mode of the one-shot CLI table renderer.
 *
 * The caller gives a terminal width one time. The layout then:
 * - measures each column by display width (CJK and emoji are two cells),
 * - drops the columns with the lowest `dropPriority` until the flex column
 *   has its minimum width,
 * - gives the free width to the flex column,
 * - draws tree arms (`├` / `╰`) in the first column, which has one width
 *   for all depths, so all columns align,
 * - draws section titles with a dim `─` ruler to the full width,
 * - truncates each row to the width as the last step.
 *
 * @module ui/command-table-width
 */

import { displayWidth, truncateDisplayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"

import type {
  CommandTableColor,
  CommandTableColumn,
  CommandTableRow,
  CommandTableSpan,
  CommandTableSpec,
} from "./command-table-types.ts"
import { ELLIPSIS, fitDisplayWidth, sliceDisplayWidth, toCellText } from "./format/text.ts"
import { c } from "./style/ansi.ts"

const DEFAULT_FLEX_MIN = 10
const DEFAULT_GAP = 2
/** Cells for one tree level: the arm or `│` and one space. */
const TREE_STEP = 2

/** Paint `text` with a table color. With `on` false, the text has no SGR. */
export function paintTableText(
  text: string,
  color: CommandTableColor | undefined,
  on: boolean,
): string {
  if (text.length === 0 || !on) return text
  switch (color) {
    case "cyan":
      return c.cyan(text)
    case "dim":
      return c.dim(text)
    case "bold":
      return c.bold(text)
    case "green":
      return c.green(text)
    case "red":
      return c.red(text)
    case "yellow":
      return c.yellow(text)
    case "none":
    case undefined:
      return text
    default: {
      const _exhaustive: never = color
      return _exhaustive
    }
  }
}

/** The spans of a cell. A plain cell is one span without its own color. */
export function cellSpans(row: CommandTableRow, key: string): CommandTableSpan[] {
  const spans = row.spans?.[key]
  if (spans) return spans.map((span) => ({ text: toCellText(span.text), color: span.color }))
  return [{ text: toCellText(row.cells[key] ?? "") }]
}

const spansText = (spans: readonly CommandTableSpan[]): string => spans.map((s) => s.text).join("")

/** Cut spans to `width` cells, with `…` in the color of the cut span. */
function fitSpans(spans: readonly CommandTableSpan[], width: number): CommandTableSpan[] {
  if (displayWidth(spansText(spans)) <= width) return [...spans]
  if (width <= 0) return []
  const out: CommandTableSpan[] = []
  let room = width - 1
  for (const span of spans) {
    const w = displayWidth(span.text)
    if (w <= room) {
      out.push(span)
      room -= w
      continue
    }
    out.push({ text: `${sliceDisplayWidth(span.text, room)}${ELLIPSIS}`, color: span.color })
    return out
  }
  return out
}

function paintSpans(
  spans: readonly CommandTableSpan[],
  fallback: CommandTableColor | undefined,
  on: boolean,
): string {
  return spans.map((span) => paintTableText(span.text, span.color ?? fallback, on)).join("")
}

/** One planned column with its final width. */
interface PlannedColumn {
  column: CommandTableColumn
  width: number
}

/**
 * Tree prefix of each row in one section: `├ `, `╰ `, with `│ ` or two
 * spaces for each open ancestor level. A root row has no prefix.
 */
export function treePrefixes(rows: readonly CommandTableRow[]): string[] {
  const depths = rows.map((row) => Math.max(0, Math.floor(row.depth ?? 0)))
  /** True when a later row is at `level` before a row with a lower depth. */
  const hasLaterSibling = (index: number, level: number): boolean => {
    for (let j = index + 1; j < depths.length; j++) {
      const d = depths[j] ?? 0
      if (d < level) return false
      if (d === level) return true
    }
    return false
  }
  return depths.map((depth, i) => {
    if (depth === 0) return ""
    let prefix = ""
    for (let level = 1; level < depth; level++) {
      prefix += hasLaterSibling(i, level) ? "│ " : "  "
    }
    return `${prefix}${hasLaterSibling(i, depth) ? "├" : "╰"} `
  })
}

function naturalWidth(
  column: CommandTableColumn,
  index: number,
  rows: readonly CommandTableRow[],
): number {
  if (column.width !== undefined) return Math.max(0, column.width)
  let width = Math.max(column.minWidth ?? 0, displayWidth(column.header ?? ""))
  for (const row of rows) {
    const tree = index === 0 ? TREE_STEP * Math.max(0, Math.floor(row.depth ?? 0)) : 0
    width = Math.max(width, tree + displayWidth(spansText(cellSpans(row, column.key))))
  }
  return column.maxWidth === undefined ? width : Math.min(width, column.maxWidth)
}

/** Choose the columns and their widths for `total` cells. */
export function planColumns(
  columns: readonly CommandTableColumn[],
  rows: readonly CommandTableRow[],
  total: number,
  indent: number,
  gap: number,
): PlannedColumn[] {
  const flexKey = columns.find((col) => col.flex)?.key
  let plan: PlannedColumn[] = columns.map((column, index) => ({
    column,
    width: column.key === flexKey ? 0 : naturalWidth(column, index, rows),
  }))
  const flexMin = (col: CommandTableColumn): number => col.minWidth ?? DEFAULT_FLEX_MIN
  const used = (): number =>
    indent +
    plan.reduce((sum, p) => sum + (p.column.key === flexKey ? flexMin(p.column) : p.width), 0) +
    gap * Math.max(0, plan.length - 1)

  while (used() > total) {
    const victim = plan
      .filter((p) => p.column.dropPriority !== undefined && p.column.key !== flexKey)
      .sort((a, b) => (a.column.dropPriority ?? 0) - (b.column.dropPriority ?? 0))[0]
    if (!victim) break
    plan = plan.filter((p) => p !== victim)
  }

  const flex = plan.find((p) => p.column.key === flexKey)
  if (flex) {
    const others = used() - flexMin(flex.column)
    // When no column can drop, the flex column shrinks below its minimum
    // before a row gets cut at the right edge.
    flex.width = Math.max(1, total - others)
  }
  return plan
}

function renderCell(
  planned: PlannedColumn,
  spans: readonly CommandTableSpan[],
  prefix: string,
  on: boolean,
): string {
  const { column, width } = planned
  const bodyWidth = Math.max(0, width - displayWidth(prefix))
  const fitted = fitSpans(spans, bodyWidth)
  const pad = " ".repeat(Math.max(0, bodyWidth - displayWidth(spansText(fitted))))
  const body = paintSpans(fitted, column.color, on)
  const arm = paintTableText(fitDisplayWidth(prefix, width), "dim", on)
  return column.align === "r" ? `${arm}${pad}${body}` : `${arm}${body}${pad}`
}

function joinLine(indent: string, cells: readonly string[], gap: number): string {
  return `${indent}${cells.join(" ".repeat(gap))}`.trimEnd()
}

/** Cut a finished row to `total` cells. SGR stays balanced. */
function clampRow(row: string, total: number): string {
  return displayWidth(row) <= total ? row : truncateDisplayWidth(row, total, ELLIPSIS)
}

/** A whole number of cells, at least `min`; `fallback` when not finite. */
function wholeCells(value: number | undefined, fallback: number, min: number): number {
  return Math.max(min, Math.floor(value !== undefined && Number.isFinite(value) ? value : fallback))
}

/**
 * Render a table in width mode. See the module doc. `width` must be finite
 * (`renderCommandTable` sends a non-finite width to the compact layout).
 */
export function renderWidthTable(spec: CommandTableSpec, width: number): string[] {
  if (!Number.isFinite(width)) {
    throw new RangeError(`renderWidthTable: width must be finite, got ${width}`)
  }
  const total = Math.max(1, Math.floor(width))
  const on = spec.color ?? true
  // Whole cells only: a fraction in `indent` or `gap` would make the width
  // math differ from the spaces that `repeat` writes.
  const indentWidth = wholeCells(spec.indent, 2, 0)
  const indent = " ".repeat(indentWidth)
  const gap = wholeCells(spec.gap, DEFAULT_GAP, 1)
  const allRows = spec.sections.flatMap((section) => section.rows)
  const rows: string[] = [""]
  const note = (text: string): string =>
    `${indent}${paintTableText(fitDisplayWidth(toCellText(text), total - indentWidth), "dim", on)}`

  if (allRows.length === 0) {
    if (spec.empty) rows.push(note(spec.empty))
    if (spec.summary) rows.push(note(spec.summary))
    return rows.map((row) => clampRow(row, total))
  }

  const plan = planColumns(spec.columns, allRows, total, indentWidth, gap)
  if (plan.some((p) => p.column.header)) {
    const cells = plan.map((p) =>
      renderCell(p, [{ text: toCellText(p.column.header ?? ""), color: "dim" }], "", on),
    )
    rows.push(joinLine(indent, cells, gap))
  }

  for (const section of spec.sections) {
    if (section.rows.length === 0) continue
    if (section.title) {
      const title = fitDisplayWidth(toCellText(section.title), total - indentWidth)
      const rest = total - indentWidth - displayWidth(title) - 1
      const ruler =
        section.ruler !== false && rest > 0 ? ` ${paintTableText("─".repeat(rest), "dim", on)}` : ""
      rows.push(`${indent}${paintTableText(title, "bold", on)}${ruler}`)
    }
    const prefixes = treePrefixes(section.rows)
    section.rows.forEach((row, i) => {
      const cells = plan.map((p, col) =>
        renderCell(p, cellSpans(row, p.column.key), col === 0 ? (prefixes[i] ?? "") : "", on),
      )
      rows.push(joinLine(indent, cells, gap))
    })
  }

  if (spec.summary) rows.push("", note(spec.summary))
  return rows.map((row) => clampRow(row, total))
}
