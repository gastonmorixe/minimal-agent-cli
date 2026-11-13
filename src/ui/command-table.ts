/**
 * Shared renderer for compact one-shot CLI tables.
 *
 * These commands are outside the live TUI, but their alignment, color, and
 * stream plumbing still belong to UI code rather than command orchestration.
 *
 * @module ui/command-table
 */

import { type CommandOutput, writeCommandRows } from "./command-output.ts"
import { resolveHelpColor } from "./help/policy.ts"
import { c } from "./style/ansi.ts"

export interface CommandTableColumn {
  key: string
  minWidth?: number
  color?: "cyan" | "dim" | "bold" | "none"
}

export interface CommandTableRow {
  cells: Record<string, string | undefined>
}

export interface CommandTableSection {
  title?: string
  rows: CommandTableRow[]
}

export interface CommandTableSpec {
  sections: CommandTableSection[]
  columns: CommandTableColumn[]
  indent?: number
  empty?: string
  summary?: string
  /**
   * Paint with SGR. `undefined` keeps the historical always-painted behavior
   * for direct renderers; {@link writeCommandTable} resolves it from the
   * stream TTY state, `NO_COLOR`, `TERM=dumb` and `--no-color`.
   */
  color?: boolean
}

function paint(text: string, color: CommandTableColumn["color"], on: boolean): string {
  if (text.length === 0 || !on) return text
  switch (color) {
    case "cyan":
      return c.cyan(text)
    case "dim":
      return c.dim(text)
    case "bold":
      return c.bold(text)
    case "none":
    case undefined:
      return text
    default: {
      const _exhaustive: never = color
      return _exhaustive
    }
  }
}

function cellWidth(rows: CommandTableRow[], column: CommandTableColumn): number {
  return Math.max(column.minWidth ?? 0, ...rows.map((row) => (row.cells[column.key] ?? "").length))
}

/** Render titled sections with left-aligned columns. */
export function renderCommandTable(spec: CommandTableSpec): string[] {
  const rows: string[] = [""]
  const on = spec.color ?? true
  const dim = (s: string): string => (on ? c.dim(s) : s)
  const baseIndent = " ".repeat(spec.indent ?? 2)
  const rowIndent = `${baseIndent}  `
  const visibleRows = spec.sections.flatMap((section) => section.rows)

  if (visibleRows.length === 0) {
    if (spec.empty) rows.push(`${baseIndent}${dim(spec.empty)}`)
    if (spec.summary) rows.push(`${baseIndent}${dim(spec.summary)}`)
    return rows
  }

  const widths = new Map(spec.columns.map((column) => [column.key, cellWidth(visibleRows, column)]))

  for (const section of spec.sections) {
    if (section.rows.length === 0) continue
    if (section.title) rows.push(`${baseIndent}${on ? c.bold(section.title) : section.title}`)

    for (const row of section.rows) {
      const paintedCells = spec.columns.map((column) => {
        const value = row.cells[column.key] ?? ""
        return paint(value.padEnd(widths.get(column.key) ?? value.length), column.color, on)
      })
      const lastIndex = paintedCells.length - 1
      if (lastIndex >= 0) {
        const lastColumn = spec.columns[lastIndex]
        const value = row.cells[lastColumn.key] ?? ""
        paintedCells[lastIndex] = paint(value, lastColumn.color, on)
      }
      const line = paintedCells.join(" ").trimEnd()
      rows.push(`${section.title ? rowIndent : baseIndent}${line}`)
    }
    rows.push("")
  }

  if (rows.at(-1) === "") rows.pop()
  if (spec.summary) rows.push(`${baseIndent}${dim(spec.summary)}`)
  return rows
}

/**
 * Write rendered rows with one trailing newline.
 *
 * Color follows the same policy as help output (SPEC-HELP R-29): no SGR when
 * the stream is not a TTY, when `NO_COLOR` is set and not empty, when
 * `TERM=dumb`, or when the caller passed an explicit `color`. Without this a
 * piped or `NO_COLOR` run still emitted escapes for `plugins`, `providers`
 * and `--auth-status`.
 */
export function writeCommandTable(
  spec: CommandTableSpec,
  output: CommandOutput = process.stdout,
): void {
  const env: Readonly<Record<string, string | undefined>> = process.env
  const isTTY = (output as { isTTY?: boolean }).isTTY
  const color = spec.color ?? resolveHelpColor(env, isTTY)
  writeCommandRows(renderCommandTable({ ...spec, color }), output)
}
