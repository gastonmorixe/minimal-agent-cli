/**
 * `--debug` request dump, rendered as colored scrollback blocks in the TUI.
 *
 * # History
 *
 * Before the core/CLI split the transport printed this dump itself, with
 * `console.error`, and the live-area `StdioInterceptor` captured those
 * writes and re-emitted them above the prompt. Every part of the request was
 * visible: the header, the per-message role preview, the system blocks, the
 * tool list, and the cache breakpoints — all colorized.
 *
 * The S25 "no engine writes to the terminal" refactor turned that dump into
 * Debug-severity diagnostics (`transport.request-dump`, one line per row) and
 * deleted the ANSI styling, because a plain-text diagnostic travels to the
 * file log. Nothing in the TUI rendered it back: `TuiDiagnosticSurface`
 * ignores Debug, `ScrollbackDiagnosticSink` drops anything above Warning, and
 * the stderr mirror is disabled in interactive mode on purpose (a raw fd 2
 * write tears the live area). So `--debug` looked dead in the REPL even
 * though the events were still being emitted.
 *
 * This module restores the original UX the way the split intended: the engine
 * keeps emitting plain-text diagnostics, and the HOST decides how to display
 * them. Styling is a presentation concern, so the colors live here, not in
 * core.
 *
 * # Input contract
 *
 * The dump arrives one diagnostic per request row, so the renderer rebuilds
 * the request from the plain rows. It parses, it does not guess:
 *
 *   - `--- POST <model> ---`   starts a block (also closes the previous one)
 *   - `  key: value`           header field
 *   - `  Body:`                body section start
 *   - `    <section>: [...]`   body section (messages / system / tools / …)
 *   - `      <row>`            section row
 *
 * Anything that does not match is rendered verbatim, so a future change to
 * the dump format degrades to plain text instead of throwing.
 *
 * # Colors
 *
 * Identical to the pre-split renderer: bold-cyan block header, dim keys,
 * yellow section names, green roles, magenta block/tool names, bright-green
 * cache markers, dim values.
 *
 * @module ui/status/debug-dump
 */

import { c } from "../style/ansi.ts"

/**
 * The `structuredData` shape a diagnostic carries. Declared locally: the
 * public diagnostics barrel exports the event vocabulary but not this alias,
 * and a structural copy is enough for the one field we read.
 */
type StructuredData = Readonly<Record<string, string | number | boolean>>

/** Diagnostic source the transport dumps requests under. */
export const REQUEST_DUMP_SOURCE = "transport.request-dump"

/** `structuredData` flag marking the last row of one request dump. */
const DUMP_LAST_ROW = "last"

/** The key the transport stamps on the final row of a dump. */
const DUMP_ROW_INDEX = "row"

/** A body section row: `messages` / `system` / `tools` / anything else. */
interface BodySection {
  readonly name: string
  readonly count: string | undefined
  readonly rows: readonly string[]
  /**
   * Rows that arrived with no `: ` — the untruncated continuation the
   * transport emits under a preview it had to cut. Counted in the section so
   * the header count never disagrees with what was received.
   */
  readonly continuations?: number
}

/** One collected request: header fields plus ordered body sections. */
export interface DumpBlock {
  /** The `--- POST <model> ---` label, verbatim. */
  readonly label: string
  /** Header fields in dump order (`model`, `stream`, `max_tokens`, …). */
  readonly fields: ReadonlyArray<readonly [string, string]>
  /** Body sections in dump order. Empty when the dump had no body. */
  readonly sections: readonly BodySection[]
}

/** Renderer state: one in-flight block plus the detached byte offset rows. */
interface Pending {
  label: string
  fields: Array<[string, string]>
  sections: BodySection[]
  /** Current section index, or -1 while still in the header. */
  section: number
  /** True once `Body:` has been seen, so `      rows` attach to a section. */
  inBody: boolean
}

const BLOCK_START = /^---\s+(?:POST|GET)\s+(.*?)\s+---$/
const BODY_START = /^ {2}Body:$/
/** A header field: exactly two spaces, then `key: value`. */
const FIELD = /^ {2}([A-Za-z0-9_.-]+):\s(.*)$/
/** A body section header: exactly four spaces, then `name:` and an optional count. */
const SECTION = /^ {4}([A-Za-z0-9_]+):(?:\s(.*))?$/
/**
 * A body row: SIX OR MORE spaces, then anything — including nothing.
 *
 * `{6,}` not `{6}`: a continuation row carries more indentation than the row
 * it belongs to. `[^]*` not `.*`: a row must never span lines, but if a
 * producer smuggles one in, the whole row is still captured rather than
 * silently dropped (the bug that made `system: [4 block(s)]` print only
 * `block 0`).
 */
const ROW = /^ {6,}([^]*)$/

/** True when this diagnostic carries one of our request-dump rows. */
export function isRequestDumpRow(
  source: string,
  structuredData: StructuredData | undefined,
): boolean {
  return source === REQUEST_DUMP_SOURCE && typeof structuredData?.[DUMP_ROW_INDEX] === "number"
}

/**
 * Accumulate request-dump diagnostics into whole blocks.
 *
 * The transport marks the final row with `last: true`; that flushes the
 * block and starts a fresh one on the next header. A dump that never sees a
 * `last` still renders when the next `--- POST … ---` header arrives, and
 * {@link flush} drains whatever is left (session end, turn abort).
 */
export class RequestDumpCollector {
  private pending: Pending | null = null

  /** Feed one diagnostic row. Returns a block when this row completed one. */
  push(message: string, structuredData: StructuredData | undefined): DumpBlock | null {
    const start = BLOCK_START.exec(message)
    if (start) {
      // A header means the previous dump ended without a `last` marker.
      const completed = this.flush()
      this.pending = {
        label: message.trim(),
        fields: [],
        sections: [],
        section: -1,
        inBody: false,
      }
      return completed
    }

    if (this.pending === null) return null
    this.absorb(message)
    // Checked AFTER absorbing, on every row: the last row of a dump can be a
    // section header, a field, or an unrecognized line, not just a row.
    return structuredData?.[DUMP_LAST_ROW] === true ? this.flush() : null
  }

  /** Fold one non-header line into the pending block. */
  private absorb(message: string): void {
    const p = this.pending
    if (p === null) return

    if (BODY_START.test(message)) {
      p.inBody = true
      return
    }

    if (!p.inBody) {
      const field = FIELD.exec(message)
      if (field) p.fields.push([field[1], field[2]])
      return
    }

    const section = SECTION.exec(message)
    if (section) {
      // `system: [4 block(s)]` carries a count; `messages: [9 message(s)]`
      // does too. Both are the section header, not a row.
      p.sections.push({ name: section[1], count: section[2], rows: [] })
      p.section = p.sections.length - 1
      return
    }

    const row = ROW.exec(message)
    if (row && p.section >= 0) {
      const current = p.sections[p.section]
      // A row with no label and no `: ` — or one still carrying a newline —
      // is the untruncated continuation of the row above it. It is counted
      // so the section's content never disappears, but it does not get a
      // label of its own.
      const text = row[1].trimEnd()
      // Every labelled row has a `: ` separator; `block 0` and tool names may
      // contain spaces, so test for the separator, not for a first word.
      const isContinuation = text.includes("\n") || !text.includes(": ")
      p.sections[p.section] = isContinuation
        ? { ...current, continuations: (current.continuations ?? 0) + 1 }
        : { ...current, rows: [...current.rows, text] }
    }
    // Unmatched (or a row before any section): the caller has no row to
    // attach it to, so it is simply not collected. A format change degrades
    // to a shorter block, never a throw.
  }

  /** Detach the in-flight block, if any. */
  flush(): DumpBlock | null {
    const p = this.pending
    this.pending = null
    if (p === null) return null
    return { label: p.label, fields: p.fields, sections: p.sections }
  }
}

/** Cache breakpoint markers the transport appends to a `messages` row. */
const CACHE_MSG_MARK = "[← cached prefix ends here]"
/** Cache marker the transport appends to a `system` row. */
const CACHE_BLOCK_MARK = "[cached]"
/** Message roles the transport prints, used to split role from content. */
const ROLES = ["assistant", "user", "system", "tool"]

/**
 * Split a messages row into its role and content.
 *
 * The transport writes `user [← cached prefix ends here]: "hi there"`, so the
 * cache marker sits inside the LABEL, before the colon. It is stripped here
 * and returned separately: the role must still match for the row to be
 * styled at all.
 */
function splitRole(row: string): { role: string; body: string; cached: boolean } | null {
  const i = row.indexOf(": ")
  if (i <= 0) return null
  let head = row.slice(0, i).trim()
  const cached = head.endsWith(CACHE_MSG_MARK)
  if (cached) head = head.slice(0, head.length - CACHE_MSG_MARK.length).trimEnd()
  if (!ROLES.includes(head)) return null
  return { role: head, body: row.slice(i + 2), cached }
}

/**
 * Style one section row. Section names drive the palette so a `messages`
 * row reads like the old renderer, a `tools` row names the tool in magenta,
 * and cache markers pop in bright green.
 */
function renderRow(section: string, row: string): string {
  if (section === "messages") {
    const parts = splitRole(row)
    if (parts === null) return `      ${c.dim(row)}`
    const mark = parts.cached ? ` ${c.bold(c.brightGreen(CACHE_MSG_MARK))}` : ""
    return `      ${c.green(parts.role)}${mark}: ${c.dim(parts.body)}`
  }

  if (section === "system") {
    // `block 0 [cached]: <text>` — the marker sits inside the label, before
    // the colon, exactly like the messages row. Split it out so the name is
    // magenta and the marker bright green, as the pre-split renderer had it.
    const colon = row.indexOf(": ")
    const label = colon > 0 ? row.slice(0, colon) : row
    const rest = colon > 0 ? row.slice(colon + 2) : ""
    const withMark = label.endsWith(` ${CACHE_BLOCK_MARK}`)
    const name = withMark ? label.slice(0, label.length - CACHE_BLOCK_MARK.length).trimEnd() : label
    const mark = withMark ? ` ${c.bold(c.brightGreen(CACHE_BLOCK_MARK))}` : ""
    return `      ${c.magenta(name)}${mark}: ${c.dim(rest)}`
  }

  if (section === "tools") {
    const colon = row.indexOf(": ")
    if (colon <= 0) return `      ${c.dim(row)}`
    return `      ${c.magenta(row.slice(0, colon))}: ${c.dim(row.slice(colon + 2))}`
  }

  return `      ${c.dim(row)}`
}

/**
 * Render one collected block as the colored lines the user sees in the TUI.
 *
 * Each request becomes one block: the bold-cyan `--- POST … ---` header, dim
 * key/value header fields, then a bold `Body:` line with its yellow section
 * names and per-section rows. The blank line before the header is included so
 * consecutive requests stay visually separated in scrollback.
 *
 * @param block - Collected request.
 * @returns Styled lines, ready for a single `writeStream` call.
 */
export function renderDumpBlock(block: DumpBlock): string[] {
  const out = ["", c.bold(c.cyan(block.label))]

  for (const [key, value] of block.fields) {
    out.push(`  ${c.dim(`${key}:`)} ${value}`)
  }

  if (block.sections.length > 0) out.push(`  ${c.bold("Body:")}`)

  for (const section of block.sections) {
    // The header count must describe what is actually rendered below it. The
    // producer writes `[4 block(s)]`; if a row was dropped in transit the
    // label would lie. Prefer the received-row count whenever we got rows,
    // and fall back to the producer's label only for an empty section.
    const received = section.rows.length
    const label = received > 0 ? `[${received} ${unitFor(section.name)}]` : (section.count ?? "")
    const count = label === "" ? "" : ` ${c.dim(label)}`
    out.push(`    ${c.yellow(section.name)}:${count}`)
    for (const row of section.rows) out.push(renderRow(section.name, row))
  }

  return out
}

/** The noun a section's count label uses, matching the transport's wording. */
function unitFor(section: string): string {
  if (section === "messages") return "message(s)"
  if (section === "system") return "block(s)"
  if (section === "tools") return "tool(s)"
  return "row(s)"
}
