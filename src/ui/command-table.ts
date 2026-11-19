/**
 * Shared renderer for compact one-shot CLI tables.
 *
 * These commands are outside the live TUI, but their alignment, color, and
 * stream plumbing still belong to UI code rather than command orchestration.
 *
 * @module ui/command-table
 */

import { displayWidth, stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { type CommandOutput, writeCommandRows } from "./command-output.ts"
import type { CommandTableRow, CommandTableSpec } from "./command-table-types.ts"
import { paintTableText, renderWidthTable } from "./command-table-width.ts"
import { padEndDisplay, toCellText } from "./format/text.ts"
import { resolveHelpColor } from "./help/policy.ts"
import { c } from "./style/ansi.ts"

export type {
  CommandTableColor,
  CommandTableColumn,
  CommandTableRow,
  CommandTableSection,
  CommandTableSpan,
  CommandTableSpec,
} from "./command-table-types.ts"

/**
 * Render titled sections with aligned columns.
 *
 * Without `spec.width` this is the historical compact layout: left-aligned
 * columns sized by their widest cell, one space between columns. With
 * `spec.width` the table uses width mode (see `command-table-width.ts`):
 * alignment, a flex column, drop priority, tree rows, section rulers, and
 * no row wider than `spec.width`.
 */
export function renderCommandTable(spec: CommandTableSpec): string[] {
  // Only a finite width selects width mode. `Infinity` or `NaN` (for example
  // `process.stdout.columns` math on a non-TTY) has no edge to fit, so the
  // table uses the compact layout and does not throw.
  if (spec.width !== undefined && Number.isFinite(spec.width)) {
    return renderWidthTable(spec, Math.max(1, Math.floor(spec.width)))
  }
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

  // Widths are display widths of the plain text, so a pre-painted cell is
  // not counted with its escapes and a CJK cell counts two cells a glyph.
  // A tab or other control becomes one space: it has no display width, so
  // it must not reach a padded cell.
  const plain = (row: CommandTableRow, key: string): string => toCellText(row.cells[key] ?? "")
  const widths = new Map(
    spec.columns.map((column) => [
      column.key,
      Math.max(
        column.minWidth ?? 0,
        ...visibleRows.map((row) => displayWidth(plain(row, column.key))),
      ),
    ]),
  )

  for (const section of spec.sections) {
    if (section.rows.length === 0) continue
    if (section.title) {
      rows.push(`${baseIndent}${on ? c.bold(section.title) : stripAnsi(section.title)}`)
    }

    for (const row of section.rows) {
      const paintedCells = spec.columns.map((column) => {
        const value = plain(row, column.key)
        return paintTableText(padEndDisplay(value, widths.get(column.key) ?? 0), column.color, on)
      })
      const lastIndex = paintedCells.length - 1
      if (lastIndex >= 0) {
        const lastColumn = spec.columns[lastIndex]
        paintedCells[lastIndex] = paintTableText(plain(row, lastColumn.key), lastColumn.color, on)
      }
      const line = paintedCells.join(" ").trimEnd()
      rows.push(`${section.title ? rowIndent : baseIndent}${on ? line : stripAnsi(line)}`)
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
