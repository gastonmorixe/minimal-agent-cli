import type { RequestDumpTextRow } from "./request-dump-text.ts"

/** The size label of a plain dump row: bytes, then an optional token part. */
const LABEL = / (?:· )?\d+(?:\.\d+)? (?:B|kB|MB|GB)\b(?: · ~\d+(?:\.\d+)?[kMB]? tok)?/g

/**
 * Test helper: remove the size labels from plain dump rows, so a layout test
 * can compare the rows without the byte and token counts. The size test
 * (`request-dump-size.test.ts`) checks the labels themselves. The token part
 * is optional: a model with no estimator gives bytes only.
 */
export function stripSizeLabels(text: string): string {
  return text.replace(LABEL, "")
}

/**
 * Test helper: a copy of a dump row with no size labels in its text. The
 * row data stays the same.
 */
export function stripRowSizeLabels(row: RequestDumpTextRow): RequestDumpTextRow {
  const text = stripSizeLabels(row.text)
  return row.data === undefined ? { text } : { text, data: row.data }
}
