/**
 * Types for the shared one-shot CLI table renderer.
 *
 * @module ui/command-table-types
 */

/** Paint names for a column, a span or a row part. */
export type CommandTableColor = "cyan" | "dim" | "bold" | "none" | "green" | "red" | "yellow"

/** One column of a table. Only `key` is necessary. */
export interface CommandTableColumn {
  key: string
  /** Minimum width in cells. For a `flex` column, the smallest width before columns drop. */
  minWidth?: number
  color?: CommandTableColor
  /** Header text. Width mode shows a dim header row when one column has a header. */
  header?: string
  /** Width mode: alignment in the cell. Default `"l"`. */
  align?: "l" | "r"
  /** Width mode: fixed width in cells. Without it, the widest cell sets the width. */
  width?: number
  /** Width mode: the measured width is not more than this. */
  maxWidth?: number
  /**
   * Width mode: this column takes all the free width (at least `minWidth`,
   * default 10). Use it on one column only; the first one wins.
   */
  flex?: boolean
  /**
   * Width mode: when the width is short, the column with the lowest value
   * drops first. A column without a value never drops.
   */
  dropPriority?: number
}

/** A part of a cell with its own paint. */
export interface CommandTableSpan {
  text: string
  color?: CommandTableColor
}

/** One data row. */
export interface CommandTableRow {
  cells: Record<string, string | undefined>
  /**
   * Painted parts of a cell. When a key is here, the spans replace
   * `cells[key]`. The text of the spans is measured without paint.
   */
  spans?: Record<string, readonly CommandTableSpan[] | undefined>
  /**
   * Width mode: tree depth. `0` (default) is a root row; `1` or more is a
   * child of the nearest row above it with a lower depth. The first column
   * gets a `├` or `╰` arm (from the siblings) and the columns stay aligned.
   */
  depth?: number
}

/** A group of rows. */
export interface CommandTableSection {
  title?: string
  rows: CommandTableRow[]
  /** Width mode: show a dim `─` ruler after the title to the full width. Default `true`. */
  ruler?: boolean
}

/** Input of {@link renderCommandTable}. */
export interface CommandTableSpec {
  sections: CommandTableSection[]
  columns: CommandTableColumn[]
  indent?: number
  empty?: string
  summary?: string
  /**
   * Paint with SGR. `undefined` keeps the historical always-painted behavior
   * for direct renderers; `writeCommandTable` resolves it from the
   * stream TTY state, `NO_COLOR`, `TERM=dumb` and `--no-color`.
   */
  color?: boolean
  /**
   * Terminal width in cells. When set, the table uses width mode: column
   * alignment, a flex column, drop priority, tree rows and section rulers,
   * and no output row is wider than this value. The caller reads the width
   * one time; the renderer does not track a resize. A width that is not
   * finite (`Infinity`, `NaN`) uses the compact layout. A fraction is
   * rounded down.
   */
  width?: number
  /** Width mode: spaces between columns. Default 2. A fraction is rounded down; min 1. */
  gap?: number
}
