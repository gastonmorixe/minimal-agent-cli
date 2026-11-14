/**
 * The typed row contract of the `--debug --verbose` request dump.
 *
 * Under `--verbose` the transport adds typed rows after each labelled row:
 * one `block` row per message content block, one `line` row per source line,
 * and one `elided` row when its row cap hid part of a block. The row type is
 * in `structuredData.kind`, never in the text, so the collector routes these
 * rows BEFORE any regex. A prompt line that reads `--- POST x ---` or
 * `  Body:` then stays a line.
 *
 * Contract source: `research/verbose-dump/plan.md` section 2.
 *
 * @module ui/status/debug-dump-contract
 */

/** Cache breakpoint marker the transport appends to a `messages` label. */
export const CACHE_MSG_MARK = "[← cached prefix ends here]"
/** Cache marker the transport appends to a `system` label. */
export const CACHE_BLOCK_MARK = "[cached]"

/** `structuredData` of one `transport.request-dump` row, owned by core. */
export type { RequestDumpRowData } from "@minimal-agent/core/host/diagnostics"

/** One message content block, from a `block` row. */
export interface DumpBlockRef {
  readonly block: number
  readonly blockType: string
  readonly toolUseId?: string
  readonly toolName?: string
  readonly isError?: boolean
}

/** One source line, from a `line` row. `text` is the raw line. */
export interface DumpLine {
  readonly line: number
  readonly text: string
  readonly block?: number
}

/**
 * Lines a capped block did not send, from an `elided` row.
 *
 * Core caps a block at a row budget and reports the remainder as data only,
 * so the count carries no text. The host builds the hint the user reads.
 */
export interface DumpElided {
  /** Lines the cap hid. */
  readonly hiddenLines: number
  readonly block?: number
}

/** One part (message, system block, or tool) with its blocks and lines. */
export interface DumpPart {
  /** Index in `messages[]`, `system[]` or `tools[]`. */
  readonly index: number
  /** The labelled row up to its first `: ` (for example `user [← cached prefix ends here]`). */
  readonly label: string
  readonly blocks: readonly DumpBlockRef[]
  readonly lines: readonly DumpLine[]
  /** Truncation hints of this part, in arrival order. Absent when none. */
  readonly elided?: readonly DumpElided[]
}

/** The `structuredData` shape a diagnostic carries. */
type StructuredData = Readonly<Record<string, string | number | boolean>>

/** The four row kinds of the verbose contract. */
const KINDS = new Set(["part", "block", "line", "elided"])

/** The row kind, or undefined for a row outside the verbose contract. */
export function rowKind(
  sd: StructuredData | undefined,
): "part" | "block" | "line" | "elided" | undefined {
  const k = sd?.kind
  return typeof k === "string" && KINDS.has(k)
    ? (k as "part" | "block" | "line" | "elided")
    : undefined
}

/** A part that is still collecting rows. */
interface OpenPart {
  index: number
  label: string
  blocks: DumpBlockRef[]
  lines: DumpLine[]
  elided: DumpElided[]
}

/** Read an optional typed key. */
const str = (sd: StructuredData, k: string): string | undefined =>
  typeof sd[k] === "string" ? (sd[k] as string) : undefined
const num = (sd: StructuredData, k: string): number | undefined =>
  typeof sd[k] === "number" ? (sd[k] as number) : undefined

/**
 * Collect the typed rows of one section into parts.
 *
 * Rows arrive in order: the `part` row, then its `block`, `line` and `elided`
 * rows. A `block`, `line` or `elided` row before any `part` row is dropped,
 * never thrown.
 */
export class PartCollector {
  private readonly parts: OpenPart[] = []

  /**
   * Fold one typed row in.
   *
   * @param kind - The row kind from {@link rowKind}.
   * @param message - The row text. For a `line` row it is the raw line. An
   *   `elided` row carries no text: its count is data.
   * @param sd - The row data.
   */
  add(kind: "part" | "block" | "line" | "elided", message: string, sd: StructuredData): void {
    if (kind === "part") {
      const text = message.trim()
      const colon = text.indexOf(": ")
      this.parts.push({
        index: num(sd, "part") ?? this.parts.length,
        label: colon > 0 ? text.slice(0, colon) : text,
        blocks: [],
        lines: [],
        elided: [],
      })
      return
    }
    const part = this.parts.at(-1)
    if (part === undefined) return
    if (kind === "block") {
      const toolUseId = str(sd, "toolUseId")
      const toolName = str(sd, "toolName")
      part.blocks.push({
        block: num(sd, "block") ?? part.blocks.length,
        blockType: str(sd, "blockType") ?? "unknown",
        ...(toolUseId === undefined ? {} : { toolUseId }),
        ...(toolName === undefined ? {} : { toolName }),
        ...(typeof sd.isError === "boolean" ? { isError: sd.isError } : {}),
      })
      return
    }
    const block = num(sd, "block")
    if (kind === "elided") {
      // A count of zero, or no count at all, is no hint: dropping it keeps a
      // dump without a real truncation byte-identical.
      const hiddenLines = num(sd, "hiddenLines")
      if (hiddenLines === undefined || hiddenLines <= 0) return
      part.elided.push({ hiddenLines, ...(block === undefined ? {} : { block }) })
      return
    }
    part.lines.push({
      line: num(sd, "line") ?? part.lines.length + 1,
      text: message,
      ...(block === undefined ? {} : { block }),
    })
  }

  /** The parts collected so far. */
  result(): readonly DumpPart[] {
    // `elided` is optional: omit it entirely when no row arrived, so a dump
    // with no truncation has exactly the shape it had before.
    return this.parts.map((p) =>
      p.elided.length === 0
        ? { index: p.index, label: p.label, blocks: p.blocks, lines: p.lines }
        : {
            index: p.index,
            label: p.label,
            blocks: p.blocks,
            lines: p.lines,
            elided: p.elided,
          },
    )
  }
}
