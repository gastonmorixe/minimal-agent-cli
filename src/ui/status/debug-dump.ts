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

import { displayWidth, truncateDisplayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"
import { c } from "../style/ansi.ts"
import { truncHint } from "../style/truncate-hint.ts"
import {
  CACHE_BLOCK_MARK,
  CACHE_MSG_MARK,
  type DumpPart,
  PartCollector,
  rowKind,
} from "./debug-dump-contract.ts"
import {
  renderVerboseSection,
  stripControls,
  type VerboseRenderOptions,
} from "./debug-dump-verbose.ts"

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
  /**
   * Parts built from the typed `--verbose` rows (`structuredData.kind`).
   * Present only when the transport sent them: the section then renders as
   * real lines with a gutter and reference lines.
   */
  readonly parts?: readonly DumpPart[]
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
  /** Typed-row collectors, by section index. */
  typed: Map<number, PartCollector>
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
 * it belongs to, and group 1 keeps that indent so it can be classified.
 * `[^]*` not `.*`: a row must never span lines, but if a
 * producer smuggles one in, the whole row is still captured rather than
 * silently dropped (the bug that made `system: [4 block(s)]` print only
 * `block 0`).
 */
const ROW = /^( {6,})([^]*)$/

/** Indent of a labelled body row. A deeper indent marks a continuation row. */
const ROW_INDENT = 6

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
    // Typed rows route by data BEFORE any regex: a prompt line that reads
    // `--- POST x ---` or `  Body:` must stay a line.
    const kind = rowKind(structuredData)
    if (kind !== undefined && structuredData !== undefined) {
      const p = this.pending
      if (p !== null && p.section >= 0) {
        let typed = p.typed.get(p.section)
        if (typed === undefined) {
          typed = new PartCollector()
          p.typed.set(p.section, typed)
        }
        typed.add(kind, message, structuredData)
      }
      return structuredData[DUMP_LAST_ROW] === true ? this.flush() : null
    }

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
        typed: new Map(),
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
      // The transport writes a labelled row at 6 spaces and, when it capped
      // the preview, the full text on an 8-space continuation row below it.
      // The continuation is counted, never rendered: showing it would print
      // the untruncated text without `--verbose`. Classify by indent first,
      // because prompt text often contains `: ` too. A row with no `: ` or a
      // raw newline is also a continuation (older producers).
      const indent = row[1].length
      const text = row[2].trimEnd()
      const isContinuation = indent > ROW_INDENT || text.includes("\n") || !text.includes(": ")
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
    const sections = p.sections.map((s, i) => {
      const parts = p.typed.get(i)?.result()
      return parts !== undefined && parts.length > 0 ? { ...s, parts } : s
    })
    return { label: p.label, fields: p.fields, sections }
  }
}

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

/** The `...(+Nch)` hint core appends to a preview it capped. */
const CORE_HINT = /\.\.\.\(\+(\d+)ch\)$/

/**
 * Fit `body` into `room` cells.
 *
 * Core already cut the preview to 80 chars and appended `...(+Nch)`. When the
 * line still does not fit, cut more and fold that count into the same hint,
 * so the line keeps one hint and its number stays the true elided total.
 */
function fitBody(body: string, room: number): string {
  if (displayWidth(body) <= room) return body
  const hint = CORE_HINT.exec(body)
  const base = hint ? body.slice(0, hint.index) : body
  const already = hint ? Number(hint[1]) : 0
  // Reserve the widest hint we could need, then cut the base to the rest.
  const keepWidth = room - displayWidth(truncHint(already + base.length))
  if (keepWidth <= 0) return truncateDisplayWidth(body, room)
  const kept = truncateDisplayWidth(base, keepWidth, "")
  return `${kept}${truncHint(already + base.length - kept.length)}`
}

/**
 * Join a styled prefix and a dim body, clipped to `width` cells.
 *
 * `width` undefined means no clip (`--verbose`, or no TTY width).
 */
function fitLine(prefix: string, body: string, width: number | undefined): string {
  if (width === undefined) return `${prefix}${c.dim(body)}`
  const room = width - displayWidth(prefix)
  if (room <= 0) return truncateDisplayWidth(prefix, width)
  return `${prefix}${c.dim(fitBody(body, room))}`
}

/**
 * Style one section row. Section names drive the palette so a `messages`
 * row reads like the old renderer, a `tools` row names the tool in magenta,
 * and cache markers pop in bright green.
 *
 * The row is stripped FIRST, so every field split below and every width
 * measurement works on the text that will actually be painted.
 */
function renderRow(section: string, raw: string, width: number | undefined, n: number): string {
  const row = stripControls(raw)
  if (section === "messages") {
    // `#N`: the history position. Each request sends the full history, so the
    // labelled row index is that position.
    const num = `${c.bold(`#${n}`)} `
    const parts = splitRole(row)
    if (parts === null) return fitLine(`      ${num}`, row, width)
    const mark = parts.cached ? ` ${c.bold(c.brightGreen(CACHE_MSG_MARK))}` : ""
    return fitLine(`      ${num}${c.green(parts.role)}${mark}: `, parts.body, width)
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
    return fitLine(`      ${c.magenta(name)}${mark}: `, rest, width)
  }

  if (section === "tools") {
    const colon = row.indexOf(": ")
    if (colon <= 0) return fitLine("      ", row, width)
    return fitLine(`      ${c.magenta(row.slice(0, colon))}: `, row.slice(colon + 2), width)
  }

  return fitLine("      ", row, width)
}

/**
 * Strip, then clip one header label to `width` cells.
 *
 * Strip FIRST: `displayWidth` counts an ESC byte as one cell, so a clip before
 * the strip would reserve cells for bytes that are never painted.
 */
function clipLabel(label: string, width: number | undefined): string {
  const clean = stripControls(label)
  return width === undefined ? clean : truncateDisplayWidth(clean, width)
}

/**
 * Render one collected block as the colored lines the user sees in the TUI.
 *
 * Each request becomes one block: the bold-cyan `--- POST … ---` header, dim
 * key/value header fields, then a bold `Body:` line with its yellow section
 * names and per-section rows. The blank line before the header is included so
 * consecutive requests stay visually separated in scrollback.
 *
 * A section that carries typed `--verbose` parts renders as real lines with
 * a gutter and reference lines instead (see `debug-dump-verbose.ts`).
 *
 * Every plugin-, core- and model-controlled string passes through
 * `stripControls` before it reaches the screen, so a control byte from core
 * (core does not strip them) can never start an escape sequence here.
 *
 * @param block - Collected request.
 * @param width - Terminal cells per line. Each line is clipped to it, so a
 *   row never wraps. Omit it to keep lines whole (`--verbose`, or no TTY).
 * @param verbose - Origin data and the hanging-indent wrap width for typed
 *   sections. Verbose lines are never clipped.
 * @returns Styled lines, ready for a single `writeStream` call.
 */
export function renderDumpBlock(
  block: DumpBlock,
  width?: number,
  verbose: VerboseRenderOptions = {},
): string[] {
  const w = width !== undefined && width > 0 ? width : undefined
  const out = ["", c.bold(c.cyan(clipLabel(block.label, w)))]

  for (const [key, value] of block.fields) {
    const prefix = `  ${c.dim(`${stripControls(key)}:`)} `
    const text = stripControls(value)
    // Field values stay at normal intensity, so clip without the dim wrap.
    out.push(
      w === undefined ? `${prefix}${text}` : `${prefix}${fitBody(text, w - displayWidth(prefix))}`,
    )
  }

  if (block.sections.length > 0) out.push(`  ${c.bold("Body:")}`)

  for (const section of block.sections) {
    const name = stripControls(section.name)
    // Verbose is chosen EXPLICITLY, never by the presence of parts. A core
    // that always emits `kind` rows would otherwise turn the compact dump into
    // the gutter form without `--verbose`. Omitted keeps the historical
    // default (typed parts render verbosely), so no call site changes today.
    const verboseParts = section.parts !== undefined && verbose.enabled !== false
    // With verbose switched OFF explicitly there are no raw rows to fall back
    // on, so the parts' own labels and lines print as compact rows. A "no"
    // never loses text.
    const rows =
      section.parts !== undefined && !verboseParts && section.rows.length === 0
        ? section.parts.flatMap((p) => [p.label, ...p.lines.map((l) => l.text)])
        : section.rows
    // The header count must describe what is actually rendered below it. The
    // producer writes `[4 block(s)]`; if a row was dropped in transit the
    // label would lie. Prefer the received count whenever we got rows, and
    // fall back to the producer's label only for an empty section.
    const received = section.parts?.length ?? rows.length
    const label = received > 0 ? `[${received} ${unitFor(name)}]` : (section.count ?? "")
    const count = label === "" ? "" : ` ${c.dim(label)}`
    out.push(`    ${c.yellow(name)}:${count}`)
    if (verboseParts) {
      out.push(...renderVerboseSection(name, section.parts, verbose))
      continue
    }
    rows.forEach((row, i) => {
      out.push(renderRow(name, row, w, i + 1))
    })
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
