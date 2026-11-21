/**
 * The plain-text rows of the `--debug` request dump, for logs.
 *
 * {@link requestDumpTextRows} turns a {@link DumpView} into the same rows that
 * core's old `requestDumpRows` wrote (byte for byte): a `--- POST <model> ---`
 * header, `  key: value` fields, `  Body:`, one `    <section>: [N unit]`
 * row per section, 6-space labelled rows, 8-space continuation rows, and
 * under verbose the typed `block`, `line` and `elided` rows. Each row text is
 * one line, so one row is one diagnostic and one RFC 5424 log line.
 *
 * The cache marker text exists only here: it is plain text for logs. A TUI
 * draws from the typed `DumpPart.cached` flag.
 *
 * @module logging/request-dump-text
 */

import { stripAllTerminalControls } from "../ui/sanitize-scrollback.ts"
import { dumpFrameHeader } from "../ui/status/debug-dump.ts"
import { frameBodyRow, frameCloseRow } from "../ui/tool-transcript/format.ts"
import { type DumpKvSection, keyWidth, kvUnit } from "./request-dump-kv.ts"
import {
  clampWithHint,
  type DumpBlockRef,
  type DumpPart,
  type DumpSectionName,
  type DumpView,
  oneLine,
  PREVIEW_CAP,
} from "./request-dump-model.ts"
import { type DumpSize, sizeLabel } from "./request-dump-size.ts"
import { paramSummary, paramTable } from "./tool-schema.ts"

/** Marker after a `messages` role whose last block has `cache_control`. */
const CACHE_MSG_MARK = " [← cached prefix ends here]"
/** Marker after a `system` block label with `cache_control`. */
const CACHE_BLOCK_MARK = " [cached]"

/**
 * `structuredData` of one `transport.request-dump` row.
 *
 * `row` and `last` are on every dump. The other keys are on verbose dumps
 * only: `kind` says what the row is (`part`: the labelled row of one
 * message, system block, or tool; `block`: one content block of a message;
 * `line`: one raw source line, verbatim; `elided`: lines the row cap hid),
 * so a reader can route rows by data and never by the row text. `line`
 * counts from 1 through the whole part.
 */
export interface RequestDumpRowData {
  /** Index of the row in the dump. */
  readonly row: number
  /** Set on the final row of the dump. */
  readonly last?: true
  /** Row type. Verbose only. */
  readonly kind?: "part" | "block" | "line" | "elided" | "param" | "field"
  /** Lines dropped by the row cap. Set on `elided` rows only. */
  readonly hiddenLines?: number
  /** Body section of the row. Verbose only. */
  readonly section?: DumpSectionName | DumpKvSection["name"]
  /** Header name or body key of a `field` row. Verbose only. */
  readonly key?: string
  /** Index in `messages[]`, `system[]`, or `tools[]`. */
  readonly part?: number
  /** Content block index in the message (messages only). */
  readonly block?: number
  /** Content block type (messages only). */
  readonly blockType?: string
  /** `tool_use.id`, or `tool_result.tool_use_id`. */
  readonly toolUseId?: string
  /** `tool_use.name`. */
  readonly toolName?: string
  /** `tool_result.is_error`. */
  readonly isError?: boolean
  /** 1-based line number, counted through the whole part. */
  readonly line?: number
}

/** The row data before the dump adds `row` and `last`. */
export type RequestDumpRowDetail = Omit<RequestDumpRowData, "row" | "last">

/** One plain-text dump row. */
export interface RequestDumpTextRow {
  /** The row text. Never holds a newline. */
  readonly text: string
  /** Typed row data. Absent on header rows and on every non-verbose row. */
  readonly data?: RequestDumpRowDetail
}

/** The unit word of a section count row. */
function unitOf(section: DumpSectionName): string {
  switch (section) {
    case "tools":
      return "tool(s)"
    case "system":
      return "block(s)"
    case "messages":
      return "message(s)"
    default: {
      const _exhaustive: never = section
      return _exhaustive
    }
  }
}

/** The label of a part row, with its plain-text cache marker. */
/** ` <size>` after a name, or nothing. */
const sz = (size: DumpSize | undefined): string => (size === undefined ? "" : ` ${sizeLabel(size)}`)

/** ` · <size>` after a section count, or nothing. */
const total = (size: DumpSize | undefined): string =>
  size === undefined ? "" : ` · ${sizeLabel(size)}`

function labelOf(p: DumpPart): string {
  return `${cacheLabelOf(p)}${sz(p.size)}`
}

function cacheLabelOf(p: DumpPart): string {
  if (!p.cached) return p.name
  switch (p.section) {
    case "messages":
      return `${p.name}${CACHE_MSG_MARK}`
    case "system":
      return `${p.name}${CACHE_BLOCK_MARK}`
    case "tools":
      return p.name
    default: {
      const _exhaustive: never = p.section
      return _exhaustive
    }
  }
}

/** The data of a `block` row (key order matches the old core rows). */
function blockData(p: DumpPart, b: DumpBlockRef): RequestDumpRowDetail {
  return {
    kind: "block",
    section: p.section,
    part: p.index,
    block: b.block,
    blockType: b.blockType,
    ...(b.toolUseId !== undefined ? { toolUseId: b.toolUseId } : {}),
    ...(b.toolName !== undefined ? { toolName: b.toolName } : {}),
    ...(b.isError !== undefined ? { isError: b.isError } : {}),
  }
}

/** The `line` and `elided` rows of one block (or of the whole part when `block` is undefined). */
function pushDetail(out: RequestDumpTextRow[], p: DumpPart, block: number | undefined): void {
  const at = block === undefined ? {} : { block }
  for (const l of p.lines) {
    if (l.block !== block) continue
    out.push({
      text: l.text,
      data: { section: p.section, part: p.index, ...at, kind: "line", line: l.line },
    })
  }
  for (const e of p.elided ?? []) {
    if (e.block !== block) continue
    // Data only: the count goes out as `hiddenLines`, and the text stays empty.
    out.push({
      text: "",
      data: {
        section: p.section,
        part: p.index,
        ...at,
        kind: "elided",
        hiddenLines: e.hiddenLines,
      },
    })
  }
}

/**
 * The parameter rows of one tool. Compact: one `params:` row with the
 * summary, capped like a preview (the full text follows when cut). Verbose:
 * a `params:` row, then one aligned row per parameter.
 */
function pushParams(out: RequestDumpTextRow[], p: DumpPart, verbose: boolean): void {
  const params = p.params ?? []
  if (params.length === 0) return
  if (!verbose) {
    const full = paramSummary(params)
    const shown = clampWithHint(full, PREVIEW_CAP)
    out.push({ text: `        params: ${shown}` })
    if (shown !== full) out.push({ text: `          ${full}` })
    return
  }
  const data = { kind: "param", section: p.section, part: p.index } as const
  out.push({ text: "        params:", data })
  for (const line of paramTable(params)) out.push({ text: `          ${line}`, data })
}

/** The rows of one part: the labelled row, the continuation row, and the verbose rows. */
function pushPart(out: RequestDumpTextRow[], p: DumpPart, verbose: boolean): void {
  const preview = verbose ? p.full : clampWithHint(p.full, PREVIEW_CAP)
  const text = `      ${labelOf(p)}: ${preview}`
  out.push(verbose ? { text, data: { kind: "part", section: p.section, part: p.index } } : { text })
  if (p.full !== preview) out.push({ text: `        ${p.full}` })
  if (!verbose) {
    pushParams(out, p, false)
    return
  }
  if (p.section !== "messages") {
    pushDetail(out, p, undefined)
    pushParams(out, p, true)
    return
  }
  for (const b of p.blocks) {
    out.push({
      text: `        block ${b.block} ${b.blockType}${sz(b.size)}`,
      data: blockData(p, b),
    })
    pushDetail(out, p, b.block)
  }
}

/**
 * The rows of one `headers` or `body` section: an aligned `key value` row
 * per entry. Compact: the value is cut at the preview cap with the hint.
 * Verbose: the full value, and an object value as pretty JSON lines behind a
 * `┆` gutter.
 */
function pushKv(out: RequestDumpTextRow[], section: DumpKvSection, verbose: boolean): void {
  out.push({
    text: `    ${section.name}: [${section.rows.length} ${kvUnit(section.name)}]${total(section.size)}`,
  })
  const w = keyWidth(section)
  for (const r of section.rows) {
    const key = r.key.padEnd(w)
    if (!verbose) {
      out.push({
        text: `      ${key}${sz(r.size)}  ${clampWithHint(oneLine(r.value), PREVIEW_CAP)}`,
      })
      continue
    }
    const data = { kind: "field", section: section.name, key: r.key } as const
    if (r.pretty === undefined) {
      out.push({ text: `      ${key}${sz(r.size)}  ${r.value}`, data })
      continue
    }
    out.push({ text: `      ${r.key}${sz(r.size)}`, data })
    for (const line of r.pretty) out.push({ text: `        ┆ ${line}`, data })
  }
}

/**
 * The plain-text rows of one request dump.
 *
 * @param view - The dump view. Build it with `dumpView(req, { lines: verbose })`.
 * @param verbose - No preview cap, and every body row carries typed data.
 *   Without it, no row carries data.
 * @returns The rows, in order.
 */
export function requestDumpTextRows(view: DumpView, verbose: boolean): RequestDumpTextRow[] {
  const out: RequestDumpTextRow[] = [{ text: stripAllTerminalControls(dumpFrameHeader(view)) }]
  for (const [key, value] of view.fields) out.push({ text: `  ${key}: ${value}` })
  out.push({ text: "  Body:" })
  for (const section of view.kv) pushKv(out, section, verbose)
  for (const section of view.sections) {
    out.push({
      text: `    ${section.name}: [${section.parts.length} ${unitOf(section.name)}]${total(section.size)}`,
    })
    for (const p of section.parts) pushPart(out, p, verbose)
  }
  // The shared gutter without color, on each labelled row.
  const gutter = stripAllTerminalControls(frameBodyRow(""))
  for (let i = 1; i < out.length; i++) {
    const row = out[i] as RequestDumpTextRow
    // A verbatim source line (or its elided marker) keeps its exact text.
    if (row.data?.kind === "line" || row.data?.kind === "elided") continue
    out[i] = { ...row, text: `${gutter} ${row.text}` }
  }
  out.push({ text: stripAllTerminalControls(frameCloseRow()) })
  return out
}
