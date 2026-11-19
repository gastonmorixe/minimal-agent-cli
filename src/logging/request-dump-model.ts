/**
 * The typed model of the `--debug` request dump.
 *
 * Input: the redacted {@link RequestSnapshot} of core's `llm.requestWillSend`
 * event. Output: a {@link DumpView}, the data that every dump surface draws
 * from (the plain-text log rows in `request-dump-text.ts`, and later the TUI
 * block). Pure: no ANSI, no environment read, no I/O.
 *
 * The preview rules are a port of core's old `llm/transport/debug.ts`, so the
 * text rows stay byte-identical to the rows core wrote before the event
 * existed. The section order and the field rules are CLI decisions now.
 *
 * @module logging/request-dump-model
 */

import type { RequestSnapshot } from "@minimal-agent/core/host/request-inspector"

import { truncHint } from "../ui/style/truncate-hint.ts"

/** The content of one snapshot message (deep-readonly, as the snapshot gives it). */
type SnapshotContent = RequestSnapshot["messages"][number]["content"]

/** One content block of a snapshot message (deep-readonly). */
type SnapshotBlock = Exclude<SnapshotContent, string>[number]

/** The preview cap of a compact (not verbose) row, in characters. */
export const PREVIEW_CAP = 80

/**
 * Most `line` rows one text block contributes.
 *
 * A verbose round resends the whole history, and each `line` row is one
 * diagnostic plus one synchronous file append. Past this cap the block keeps
 * {@link MAX_LINE_ROWS} lines and one {@link DumpElided} entry with the count
 * of the hidden lines. A resource guard: a data number, never a text budget.
 */
export const MAX_LINE_ROWS = 200

/** Deepest input nesting {@link jsonSafeValue} walks before it elides. */
const MAX_JSON_DEPTH = 100

/** A body section name. */
export type DumpSectionName = "messages" | "system" | "tools"

/** One message content block of a verbose part. */
export interface DumpBlockRef {
  /** Index of the block in the message content. */
  readonly block: number
  /** Content block type. */
  readonly blockType: string
  /** `tool_use.id`, or `tool_result.tool_use_id`. */
  readonly toolUseId?: string
  /** `tool_use.name`. */
  readonly toolName?: string
  /** `tool_result.is_error`. */
  readonly isError?: boolean
}

/** One raw source line of a verbose part. `text` is the line, verbatim. */
export interface DumpLine {
  /** 1-based line number, counted through the whole part. */
  readonly line: number
  /** The raw line. */
  readonly text: string
  /** Content block index (messages only). */
  readonly block?: number
}

/** Lines that the {@link MAX_LINE_ROWS} cap hid in one text block. */
export interface DumpElided {
  /** Lines the cap hid. Always more than 0. */
  readonly hiddenLines: number
  /** Content block index (messages only). */
  readonly block?: number
}

/** One part of a body section: a message, a system block, or a tool. */
export interface DumpPart {
  /** Index in `messages[]`, `system[]` or `tools[]`. */
  readonly index: number
  /** Section of the part. */
  readonly section: DumpSectionName
  /** messages: role; system: `block <i>`; tools: tool name. Never holds a marker. */
  readonly name: string
  /** Prompt-cache breakpoint at this part (from `snapshot.cache`). Always false for tools. */
  readonly cached: boolean
  /** One-line full preview text (never truncated here). */
  readonly full: string
  /** Content blocks (verbose messages only). */
  readonly blocks: readonly DumpBlockRef[]
  /** Raw source lines (verbose only). */
  readonly lines: readonly DumpLine[]
  /** Capped blocks. Absent when no block hit the cap. */
  readonly elided?: readonly DumpElided[]
}

/** One body section with its parts. */
export interface DumpSection {
  /** Section name. */
  readonly name: DumpSectionName
  /** Parts, in request order. */
  readonly parts: readonly DumpPart[]
}

/** The typed view of one request dump. */
export interface DumpView {
  /** Model id. `undefined` means the provider default. */
  readonly model: string | undefined
  /** Header fields as `[key, one-line value]`, in display order. */
  readonly fields: ReadonlyArray<readonly [string, string]>
  /** Body sections. Order: tools, system, messages. */
  readonly sections: readonly DumpSection[]
}

/** Options of {@link dumpView}. */
export interface DumpViewOptions {
  /** Fill `blocks`, `lines` and `elided` (the verbose view). */
  readonly lines: boolean
}

/**
 * Cut `s` to `max` characters, plus an `...(+Nch)` hint for the rest.
 *
 * @param s - The text.
 * @param max - The most characters to keep.
 * @returns `s` itself when it fits.
 */
export function clampWithHint(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + truncHint(s.length - max, "ch")
}

/**
 * Collapse a preview to ONE line: each newline and the space around it
 * becomes ` ⏎ `, each run of spaces and tabs becomes one space, and the ends
 * are trimmed. A dump row must never contain a newline.
 *
 * @param s - The text.
 * @returns The one-line text.
 */
export function oneLine(s: string): string {
  return s
    .replace(/\s*\n\s*/g, " ⏎ ")
    .replace(/[ \t]+/g, " ")
    .trim()
}

/** Last 6 chars of a tool id: enough to pair use and result within a dump. */
function shortId(id: string): string {
  return id.slice(-6)
}

/** One short structural token for a content block. No truncation. */
function previewBlock(b: SnapshotBlock): string {
  switch (b.type) {
    case "text":
      return JSON.stringify(b.text)
    case "thinking":
      return `thinking(${b.thinking.length}ch)`
    case "redacted_thinking":
      return `redacted_thinking(${b.data.length}ch)`
    case "tool_use": {
      const keys = Object.keys(b.input ?? {}).join(",")
      return `tool_use(${b.name}#${shortId(b.id)})${keys ? `{${keys}}` : ""}`
    }
    case "tool_result": {
      const inner =
        typeof b.content === "string"
          ? JSON.stringify(b.content)
          : b.content.map(previewBlock).join(" + ")
      const err = b.is_error ? "!" : ""
      return `tool_result${err}(${shortId(b.tool_use_id)}) ${inner}`
    }
    case "image": {
      const s = b.source
      const detail = s.type === "base64" ? s.media_type : s.type === "url" ? s.url : s.file_id
      return `image(${s.type} ${detail})`
    }
    case "document": {
      const s = b.source
      const detail =
        s.type === "base64"
          ? s.media_type
          : s.type === "url"
            ? s.url
            : s.type === "file"
              ? s.file_id
              : "text/plain"
      return `document(${s.type} ${detail})`
    }
    default: {
      const _exhaustive: never = b
      return `unknown(${(_exhaustive as { type?: string } | null)?.type ?? "?"})`
    }
  }
}

/**
 * The preview text of a message content (string or blocks). No truncation.
 *
 * @param content - The message content.
 * @returns The preview, before {@link oneLine}.
 */
export function previewContent(content: SnapshotContent): string {
  if (typeof content === "string") return content
  return content.map(previewBlock).join("  ⟶  ")
}

/**
 * Copy `value` into a plain structure that `JSON.stringify` accepts.
 *
 * `stack` holds the ANCESTORS of the node, so a real cycle becomes
 * `"[Circular]"` while one object referenced twice from sibling keys is
 * written twice. A bigint becomes its digits plus `n`, and a throwing getter
 * becomes `"[unserializable]"` on that one property.
 */
function jsonSafeValue(value: unknown, stack: object[], depth: number): unknown {
  if (typeof value === "bigint") return `${value}n`
  if (value === null || typeof value !== "object") return value
  if (depth >= MAX_JSON_DEPTH) return "[depth]"
  const obj = value as Record<string, unknown> & { toJSON?: () => unknown }
  if (stack.includes(obj)) return "[Circular]"
  stack.push(obj)
  try {
    if (typeof obj.toJSON === "function") return jsonSafeValue(obj.toJSON(), stack, depth + 1)
    if (Array.isArray(obj)) return obj.map((v) => jsonSafeValue(v, stack, depth + 1))
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj)) {
      try {
        out[k] = jsonSafeValue(obj[k], stack, depth + 1)
      } catch {
        out[k] = "[unserializable]"
      }
    }
    return out
  } finally {
    stack.pop()
  }
}

/**
 * `JSON.stringify` that never throws. The dump runs inside the send path,
 * so a tool input that plain `JSON.stringify` rejects must not break a send.
 *
 * @param value - Any value.
 * @param indent - Indent width. Default 2.
 * @returns The JSON text, or `"[unserializable]"`.
 */
export function safeJson(value: unknown, indent = 2): string {
  try {
    return JSON.stringify(jsonSafeValue(value, [], 0), null, indent) ?? "[unserializable]"
  } catch {
    return "[unserializable]"
  }
}

/** The faithful source text of one content block, or `undefined` when it has none. */
function blockSourceText(b: SnapshotBlock): string | undefined {
  switch (b.type) {
    case "text":
      return b.text
    case "thinking":
      return b.thinking
    case "tool_use":
      return safeJson(b.input ?? {})
    case "tool_result":
      if (typeof b.content === "string") return b.content
      return b.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n")
    default:
      return undefined
  }
}

/** The typed reference of one content block. */
function blockRef(b: SnapshotBlock, block: number): DumpBlockRef {
  if (b.type === "tool_use") return { block, blockType: b.type, toolUseId: b.id, toolName: b.name }
  if (b.type === "tool_result") {
    return {
      block,
      blockType: b.type,
      toolUseId: b.tool_use_id,
      ...(b.is_error !== undefined ? { isError: b.is_error } : {}),
    }
  }
  return { block, blockType: b.type }
}

/** A part that is still collecting its verbose data. */
interface Detail {
  readonly blocks: DumpBlockRef[]
  readonly lines: DumpLine[]
  readonly elided: DumpElided[]
}

/** Add one line per `\n`-separated line of `text`, up to the cap. Returns the next line number. */
function pushLines(out: Detail, text: string, from: number, block: number | undefined): number {
  if (text.length === 0) return from
  const split = text.split("\n")
  const shown = Math.min(split.length, MAX_LINE_ROWS)
  const at = block === undefined ? {} : { block }
  for (let i = 0; i < shown; i++) out.lines.push({ line: from + i, text: split[i], ...at })
  const hidden = split.length - shown
  if (hidden > 0) out.elided.push({ hiddenLines: hidden, ...at })
  return from + split.length
}

/** The verbose data of one message: its blocks, and the lines of each block. */
function messageDetail(content: SnapshotContent): Detail {
  const blocks: readonly SnapshotBlock[] =
    typeof content === "string" ? [{ type: "text", text: content }] : content
  const out: Detail = { blocks: [], lines: [], elided: [] }
  let line = 1
  for (let j = 0; j < blocks.length; j++) {
    const b = blocks[j]
    out.blocks.push(blockRef(b, j))
    const text = blockSourceText(b)
    if (text !== undefined) line = pushLines(out, text, line, j)
  }
  return out
}

/** The verbose data of a system block or a tool: the lines of its text. */
function textDetail(text: string): Detail {
  const out: Detail = { blocks: [], lines: [], elided: [] }
  pushLines(out, text, 1, undefined)
  return out
}

/** Build one part. */
function part(
  section: DumpSectionName,
  index: number,
  name: string,
  cached: boolean,
  full: string,
  detail: Detail | undefined,
): DumpPart {
  const base = { index, section, name, cached, full }
  if (detail === undefined) return { ...base, blocks: [], lines: [] }
  return {
    ...base,
    blocks: detail.blocks,
    lines: detail.lines,
    ...(detail.elided.length > 0 ? { elided: detail.elided } : {}),
  }
}

/** The header fields, with today's rules. */
function headerFields(req: RequestSnapshot): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = []
  const kv = (key: string, value: string): void => {
    out.push([key, oneLine(value)])
  }
  if (req.model) kv("model", req.model)
  kv("stream", String(req.stream))
  if (req.maxTokens != null) kv("max_tokens", String(req.maxTokens))
  kv("request_type", req.requestType)
  if (req.thinking) kv("thinking", JSON.stringify(req.thinking))
  if (req.outputConfig) kv("output_config", JSON.stringify(req.outputConfig))
  if (req.speed && req.speed !== "normal") kv("speed", req.speed)
  return out
}

/**
 * Build the typed dump view of one request.
 *
 * Sections: `tools` and `system` only when the request has at least one
 * entry (the snapshot gives `[]` for an absent list), then `messages`
 * always. `messages` goes last: it is the longest and most-read section, so
 * it ends right above the prompt, and the prompt reads in the order the
 * model sees it.
 *
 * @param req - The redacted request snapshot. Read synchronously, never kept.
 * @param opts - `lines: true` fills the verbose data.
 * @returns The view. It holds no reference to the snapshot arrays.
 */
export function dumpView(req: RequestSnapshot, opts: DumpViewOptions): DumpView {
  const sections: DumpSection[] = []
  if (req.tools.length > 0) {
    sections.push({
      name: "tools",
      parts: req.tools.map((t, i) => {
        const text = t.description ?? ""
        return part(
          "tools",
          i,
          t.name,
          false,
          oneLine(text),
          opts.lines ? textDetail(text) : undefined,
        )
      }),
    })
  }
  if (req.system.length > 0) {
    const cached = new Set(req.cache.system)
    sections.push({
      name: "system",
      parts: req.system.map((b, i) =>
        part(
          "system",
          i,
          `block ${i}`,
          cached.has(i),
          oneLine(b.text),
          opts.lines ? textDetail(b.text) : undefined,
        ),
      ),
    })
  }
  const cachedMessages = new Set(req.cache.messages)
  sections.push({
    name: "messages",
    parts: req.messages.map((m, i) =>
      part(
        "messages",
        i,
        m.role,
        cachedMessages.has(i),
        oneLine(previewContent(m.content)),
        opts.lines ? messageDetail(m.content) : undefined,
      ),
    ),
  })
  return { model: req.model, fields: headerFields(req), sections }
}
