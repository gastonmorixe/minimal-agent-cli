/**
 * `--debug --verbose` section renderer: real lines with a line-number gutter
 * and one reference line per part and per subpart.
 *
 * Each source line prints as its own terminal line behind a dim gutter that is
 * right-aligned to the widest number of its part (` 12 │ text`). Numbers come
 * from the `line` rows, so they restart at 1 for each part. Lines are never
 * cut: with a wrap width, a long line wraps with a hanging indent so the
 * wrapped text starts under the text column, not under the gutter. Without a
 * wrap width, a line stays whole.
 *
 * Reference lines (`↳ …`) name where a part came from: the block type of a
 * message, the tool a `tool_result` answers, the core slot or plugin section
 * of a system block line, the owner of a tool. Missing data prints a dim
 * "origin not recorded".
 *
 * @module ui/status/debug-dump-verbose
 */

import { homedir } from "node:os"
import { relative, sep } from "node:path"
import {
  codePointWidth,
  displayWidth,
  truncateDisplayWidth,
} from "@minimal-agent/core/plugin-api/utils/term-width"
import type {
  DumpElided,
  DumpLine,
  DumpPart,
  DumpSectionName,
} from "../../logging/request-dump-model.ts"
import { type DumpSize, sizeLabel } from "../../logging/request-dump-size.ts"
import { cellWidths, paramCells } from "../../logging/tool-schema.ts"
import { c } from "../style/ansi.ts"
import {
  blockRef,
  type DumpOriginSource,
  type OriginRef,
  systemRefs,
  toolRef,
} from "./debug-dump-origins.ts"

/**
 * Cache label drawn after a `messages` part name. A display constant: the
 * renderer draws it from `DumpPart.cached`, and never parses it.
 */
export const CACHE_MSG_LABEL = "[← cached prefix ends here]"
/** Cache label drawn after a `system` part name (display only, like {@link CACHE_MSG_LABEL}). */
export const CACHE_BLOCK_LABEL = "[cached]"

/** Options for {@link renderVerboseSection}. */
export interface VerboseRenderOptions {
  /**
   * The verbose switch. `true` renders real lines with a gutter (build the
   * view with `dumpView(req, { lines: true })`). Omitted or `false`: the
   * compact row form.
   */
  readonly enabled?: boolean
  /** Origin data for the reference lines. Omitted: refs show "origin not recorded". */
  readonly origins?: DumpOriginSource
  /** Cells per terminal line for the hanging-indent wrap. Omitted: no wrap. */
  readonly wrapWidth?: number
}

/** Indent of a part header row. */
const PART_INDENT = "      "
/** Indent of a gutter and a reference line. */
const SUB_INDENT = "         "

/**
 * Cells one kept tab expands to, so a tab can never drift the gutter.
 *
 * `codePointWidth` counts a tab as 0 cells, while every terminal advances to
 * the next tab stop, so a raw tab makes the width math disagree with what is
 * painted. A fixed expansion keeps both in agreement.
 */
const TAB_SIZE = 4

/**
 * Bytes that must never reach the screen: C0 except tab and newline, DEL, and
 * the whole C1 block U+0080-U+009F.
 *
 * C1 matters: U+009B is the single-character form of CSI, so a text-only strip
 * of ESC still leaves a working escape-sequence opener (ECMA-48).
 * https://ecma-international.org/publications-and-standards/standards/ecma-48/
 */
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g

/**
 * Remove control characters (C0 minus tab, DEL, all of C1) and a trailing CR.
 *
 * ONE strip function for every plugin- or model-controlled string this module
 * puts on the screen: part labels, roles, origin fields, and body lines.
 *
 * @param text - Raw text from core, a plugin manifest, or a model message.
 * @returns The same text with escape-sequence bytes removed.
 */
export function stripControls(text: string): string {
  return text.replace(/\r$/, "").replace(CONTROL, "")
}

/** Strip one body line and expand its tabs, for the gutter text column. */
function sanitize(text: string): string {
  return stripControls(text).replace(/\t/g, " ".repeat(TAB_SIZE))
}

/** Show a path relative to the cwd, else with `~`, else as is. */
function showPath(dir: string): string {
  const rel = relative(process.cwd(), dir)
  if (rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep)) return rel
  const home = homedir()
  return dir.startsWith(`${home}${sep}`) ? `~${dir.slice(home.length)}` : dir
}

const DOT = c.dim(" · ")

/** Clip a title line to the wrap width (no wrap: keep it whole). */
export function fitTitle(line: string, wrapWidth: number | undefined): string {
  return wrapWidth === undefined ? line : truncateDisplayWidth(line, wrapWidth, "…")
}

/** The dim size label with a lead space, or nothing. */
export function sizeTag(size: DumpSize | undefined): string {
  return size === undefined ? "" : ` ${c.dim(sizeLabel(size))}`
}
const ARROW = c.dim("↳")
const UNRECORDED = c.dim("origin not recorded")

/**
 * The text after `↳ ` for one ref, with every field stripped.
 *
 * Strip here and not at each call site: every reference line goes through this
 * one function, so a new ref kind cannot print raw core or model text.
 */
function refFields(ref: OriginRef): string {
  switch (ref.kind) {
    case "core-slot":
      return ["core", c.yellow(ref.slot), ...(ref.overridden ? [c.dim("overridden")] : [])].join(
        DOT,
      )
    case "plugin-section":
      return ref.pluginId === undefined
        ? [c.magenta(stripControls(ref.tag)), UNRECORDED].join(DOT)
        : [
            c.cyan(stripControls(ref.pluginId)),
            c.magenta(stripControls(ref.tag)),
            ...(ref.packageDir === undefined ? [] : [c.dim(showPath(ref.packageDir))]),
          ].join(DOT)
    case "plugin-fragment":
      return [
        c.cyan(stripControls(ref.pluginId)),
        `fragment ${c.yellow(stripControls(ref.fragmentId))}`,
        ...(ref.packageDir === undefined ? [] : [c.dim(showPath(ref.packageDir))]),
      ].join(DOT)
    case "host-append":
      return ["host", c.yellow("appended text")].join(DOT)
    case "core-tool":
      return ["core", c.yellow("built-in")].join(DOT)
    case "plugin-tool":
      return [c.cyan(stripControls(ref.pluginId)), c.dim(showPath(ref.packageDir))].join(DOT)
    case "unrecorded":
      return UNRECORDED
    case "msg-text":
      return c.yellow("text")
    case "msg-attachment":
      return [c.yellow("attachment"), c.magenta(stripControls(`<ma::agent::${ref.name}>`))].join(
        DOT,
      )
    case "msg-tool-use":
      return [
        c.yellow("tool_use"),
        ...(ref.toolName === undefined ? [] : [c.magenta(stripControls(ref.toolName))]),
        ...(ref.toolUseId === undefined ? [] : [c.dim(stripControls(`#${ref.toolUseId}`))]),
      ].join(DOT)
    case "msg-tool-result": {
      const name = ref.toolName === undefined ? "" : ` ${c.magenta(stripControls(ref.toolName))}`
      const id = ref.toolUseId === undefined ? "" : ` ${c.dim(stripControls(`#${ref.toolUseId}`))}`
      return [
        c.yellow("tool_result"),
        `from tool_use${name}${id}`,
        ...(ref.isError ? [c.red("error")] : []),
      ].join(DOT)
    }
    default:
      // Only `msg-other` is left. The type check proves it.
      return c.yellow(stripControls(ref.blockType))
  }
}

/** Style one origin ref as the text after `↳ `. */
function refText(ref: OriginRef): string {
  return refFields(ref)
}

/** Indent plus arrow: the cells a ref line spends before its own text. */
const REF_PREFIX = `${SUB_INDENT}${ARROW} `

/**
 * One reference line, fitted to `wrapWidth` cells when one is given.
 *
 * A ref names its origin on one line, so it truncates instead of wrapping:
 * a second line would read as another origin. `truncateDisplayWidth` keeps the
 * SGR sequences and the gutter prefix intact.
 *
 * @param ref - The origin to name.
 * @param wrapWidth - Cells per line. Omitted: no fit.
 */
const refLine = (ref: OriginRef, wrapWidth: number | undefined, size?: DumpSize): string => {
  const text = `${REF_PREFIX}${refText(ref)}${sizeTag(size)}`
  if (wrapWidth === undefined) return text
  return truncateDisplayWidth(text, wrapWidth, "…")
}

/**
 * How {@link hardWrap} breaks a line.
 *
 * - `hard`: cut at the cell limit, also in the middle of a word.
 * - `word`: break at spaces. Cut a word only when it alone is wider than the line.
 */
export type WrapMode = "hard" | "word"

/**
 * Cut `text` into pieces of at most `room` cells. Never returns an empty list.
 *
 * With `room < 1` there is no cell left for text, so the line becomes the bare
 * gutter instead of the whole line: a narrow terminal must clip, not overflow.
 *
 * In `word` mode the spaces at a break go away, and the lead indent of the
 * first piece stays. The verbose dump uses `word` mode. `hard` is the default.
 */
export function hardWrap(text: string, room: number, mode: WrapMode = "hard"): string[] {
  if (room < 1) return [""]
  if (displayWidth(text) <= room) return [text]
  if (mode === "word") return packTokens(text.split(/( +)/), room)
  const out: string[] = []
  let cur = ""
  let w = 0
  for (const ch of text) {
    const cw = codePointWidth(ch.codePointAt(0) ?? 0)
    if (w + cw > room && cur !== "") {
      out.push(cur)
      cur = ""
      w = 0
    }
    cur += ch
    w += cw
  }
  out.push(cur)
  return out
}

/**
 * Wrap a type cell (for example a long enum) to `room` cells. The break goes
 * after a `|` or at a space. A part wider than the line is cut.
 */
export function wrapType(text: string, room: number): string[] {
  if (room < 1) return [""]
  if (displayWidth(text) <= room) return [text]
  return packTokens(text.split(/( +|(?<=\|))/), room)
}

/**
 * Greedy line fill. `tokens` alternate words and space runs (a split with a
 * capture group). A space run that does not fit ends the line and goes away.
 * A word that is wider than the line is cut at the cell limit.
 */
function packTokens(tokens: readonly string[], room: number): string[] {
  const out: string[] = []
  let cur = ""
  for (const tok of tokens) {
    if (tok === "") continue
    if (tok.trim() === "") {
      // A continuation line starts with no spaces.
      if (cur === "" && out.length > 0) continue
      if (displayWidth(cur + tok) <= room) cur += tok
      else if (cur.trim() !== "") {
        out.push(cur.trimEnd())
        cur = ""
      } else cur = ""
      continue
    }
    if (displayWidth(cur + tok) <= room) {
      cur += tok
      continue
    }
    // An indent alone stays with the word, so the first line keeps its indent.
    const words = cur.trim() !== ""
    const head = words ? "" : cur
    if (words) out.push(cur.trimEnd())
    if (words && displayWidth(tok) <= room) {
      cur = tok
      continue
    }
    const pieces = hardWrap(head + tok, room)
    out.push(...pieces.slice(0, -1))
    cur = pieces[pieces.length - 1] ?? ""
  }
  if (cur.trim() !== "" || out.length === 0) out.push(cur.trimEnd())
  return out
}

/** Render the lines of one part behind a gutter of `digits` width. */
function gutterLines(
  lines: readonly DumpLine[],
  digits: number,
  wrapWidth: number | undefined,
): string[] {
  const bar = c.dim(" │ ")
  const blank = `${SUB_INDENT}${" ".repeat(digits)}${bar}`
  // undefined keeps the "no wrap" mode; a number is the text column width and
  // can go negative on a very narrow terminal, which clips.
  const room = wrapWidth === undefined ? undefined : wrapWidth - (SUB_INDENT.length + digits + 3)
  const out: string[] = []
  for (const l of lines) {
    const num = c.dim(String(l.line).padStart(digits))
    const text = sanitize(l.text)
    if (text === "") {
      out.push(`${SUB_INDENT}${num}${c.dim(" │")}`)
      continue
    }
    if (room === undefined) {
      out.push(`${SUB_INDENT}${num}${bar}${text}`)
      continue
    }
    const [first, ...rest] = hardWrap(text, room, "word")
    out.push(`${SUB_INDENT}${num}${bar}${first}`)
    for (const r of rest) out.push(`${blank}${r}`)
  }
  return out
}

/** Digits of the widest line number of a part. */
const digitsOf = (lines: readonly DumpLine[]): number =>
  String(lines.reduce((m, l) => Math.max(m, l.line), 1)).length

/** Marker that takes the gutter position of a line number the cap hid. */
const ELIDE_MARK = "⋯"

/**
 * The hint text for one `elided` row. Built HERE, not in core.
 *
 * Core sends a count in `hiddenLines` and no text at all, because core holds
 * no user-visible strings. The words, the punctuation and the plural belong to
 * the host, so this is the only place the sentence exists.
 */
function elidedText(e: DumpElided): string {
  return `${e.hiddenLines} more ${e.hiddenLines === 1 ? "line" : "lines"}`
}

/**
 * One truncation hint, aligned under the lines it follows.
 *
 * The marker sits in the number column so the gutter numbering of the shown
 * lines never moves, and the hint starts in the text column like a body line.
 * With a wrap width the hint wraps under the same text column.
 */
function elidedLines(
  elided: readonly DumpElided[],
  digits: number,
  wrapWidth: number | undefined,
): string[] {
  const bar = c.dim(" │ ")
  const mark = `${SUB_INDENT}${c.dim(ELIDE_MARK.padStart(digits))}`
  const blank = `${SUB_INDENT}${" ".repeat(digits)}${bar}`
  const room = wrapWidth === undefined ? undefined : wrapWidth - (SUB_INDENT.length + digits + 3)
  const out: string[] = []
  for (const e of elided) {
    const text = sanitize(elidedText(e))
    if (room === undefined) {
      out.push(`${mark}${bar}${c.dim(text)}`)
      continue
    }
    const [first, ...rest] = hardWrap(text, room, "word")
    out.push(`${mark}${bar}${c.dim(first)}`)
    for (const r of rest) out.push(`${blank}${c.dim(r)}`)
  }
  return out
}

/** A styled part name, plus the bright-green cache label when the part is a breakpoint. */
function styledName(part: DumpPart, markLabel: string, style: (s: string) => string): string {
  const name = style(stripControls(part.name))
  return part.cached ? `${name} ${c.bold(c.brightGreen(markLabel))}` : name
}

/** One message part: `#N role`, then each block's ref and lines. */
function renderMessage(
  part: DumpPart,
  n: number,
  toolNames: Map<string, string>,
  wrapWidth: number | undefined,
): string[] {
  const out = [
    fitTitle(
      `${PART_INDENT}${c.bold(`#${n}`)} ${styledName(part, CACHE_MSG_LABEL, c.green)}${sizeTag(part.size)}`,
      wrapWidth,
    ),
  ]
  const digits = digitsOf(part.lines)
  const used = new Set<DumpLine>()
  for (const b of part.blocks) {
    const own = part.lines.filter((l) => l.block === b.block)
    for (const l of own) used.add(l)
    out.push(refLine(blockRef(b, toolNames, own[0]?.text), wrapWidth, b.size))
    if (b.blockType === "tool_use" && b.toolUseId !== undefined && b.toolName !== undefined) {
      toolNames.set(b.toolUseId, b.toolName)
    }
    out.push(...gutterLines(own, digits, wrapWidth))
  }
  out.push(
    ...gutterLines(
      part.lines.filter((l) => !used.has(l)),
      digits,
      wrapWidth,
    ),
  )
  out.push(...elidedLines(part.elided ?? [], digits, wrapWidth))
  return out
}

/** One system block part: its refs, each placed before its line. */
function renderSystem(part: DumpPart, opts: VerboseRenderOptions): string[] {
  const out = [
    fitTitle(
      `${PART_INDENT}${styledName(part, CACHE_BLOCK_LABEL, c.magenta)}${sizeTag(part.size)}`,
      opts.wrapWidth,
    ),
  ]
  const text = part.lines.map((l) => l.text).join("\n")
  const refs = systemRefs(text, opts.origins)
  const digits = digitsOf(part.lines)
  let r = 0
  part.lines.forEach((l, i) => {
    for (; r < refs.length && refs[r].atLine <= i + 1; r++)
      out.push(refLine(refs[r].ref, opts.wrapWidth))
    out.push(...gutterLines([l], digits, opts.wrapWidth))
  })
  for (; r < refs.length; r++) out.push(refLine(refs[r].ref, opts.wrapWidth))
  out.push(...elidedLines(part.elided ?? [], digits, opts.wrapWidth))
  return out
}

/**
 * The parameter table of one tool: a dim `params` gutter row, then one row
 * per parameter with aligned columns. Name in cyan, type dim, `required` in
 * bold yellow, description at normal intensity.
 */
function paramLines(part: DumpPart, wrapWidth: number | undefined): string[] {
  const params = part.params ?? []
  if (params.length === 0) return []
  const cells = paramCells(params).map((x) => ({
    name: stripControls(x.name),
    type: stripControls(x.type),
    req: x.req,
    desc: stripControls(x.desc),
  }))
  const w = cellWidths(cells)
  const bar = c.dim(" ┆ ")
  const lead = `${SUB_INDENT}${c.dim("params")}`
  const out = [`${lead}${c.dim(" ┆")}`]
  const pad = `${SUB_INDENT}      ${bar}`
  const paint = (req: string): string =>
    req.trim() === "required" ? c.bold(c.yellow(req)) : c.dim(req)
  if (wrapWidth === undefined) {
    for (const x of cells) {
      const line = `${pad}${c.cyan(x.name.padEnd(w.name))}  ${c.dim(x.type.padEnd(w.type))}  ${paint(x.req.padEnd(w.req))}${x.desc === "" ? "" : `  ${x.desc}`}`
      out.push(line)
    }
    return out
  }
  const room = wrapWidth - displayWidth(pad)
  const layout = paramLayout(w, room)
  for (const x of cells) {
    out.push(
      ...(layout === undefined
        ? stackedParam(x, room)
        : tableParam(x, w, layout.type, layout.desc)
      ).map((l) => `${pad}${l}`),
    )
  }
  return out

  /** Table rows of one parameter: the type and the description wrap in their columns. */
  function tableParam(x: ParamRow, cw: Widths, typeW: number, descW: number): string[] {
    const types = wrapType(x.type, typeW)
    const descs = x.desc === "" ? [] : hardWrap(x.desc, descW, "word")
    const rows: string[] = []
    for (let i = 0; i < Math.max(types.length, descs.length); i++) {
      const name = i === 0 ? c.cyan(x.name.padEnd(cw.name)) : " ".repeat(cw.name)
      const t = types[i] ?? ""
      const desc = descs[i]
      if (i > 0 && desc === undefined) {
        // A type continuation with no description: no padding after the type.
        rows.push(`${name}  ${c.dim(t)}`)
        continue
      }
      const type = c.dim(`${t}${" ".repeat(Math.max(0, typeW - displayWidth(t)))}`)
      const req = i === 0 ? paint(x.req.padEnd(cw.req)) : " ".repeat(cw.req)
      rows.push(`${name}  ${type}  ${req}${desc === undefined ? "" : `  ${desc}`}`)
    }
    return rows
  }

  /** Stacked rows of one parameter, for a narrow room: the head, then the description. */
  function stackedParam(x: ParamRow, width: number): string[] {
    const indent = "    "
    const rows: string[] = []
    if (displayWidth(`${x.name}  ${x.type}  ${x.req}`) <= width) {
      rows.push(`${c.cyan(x.name)}  ${c.dim(x.type)}  ${paint(x.req)}`)
    } else {
      // Too wide for one line: the name and `required`, then the type below.
      const names = hardWrap(x.name, width)
      const last = names.pop() ?? ""
      rows.push(...names.map((n) => c.cyan(n)))
      if (displayWidth(`${last}  ${x.req}`) <= width) rows.push(`${c.cyan(last)}  ${paint(x.req)}`)
      else rows.push(c.cyan(last), paint(x.req))
      for (const t of wrapType(x.type, width - indent.length)) rows.push(`${indent}${c.dim(t)}`)
    }
    if (x.desc !== "") {
      for (const d of hardWrap(x.desc, width - indent.length, "word")) rows.push(`${indent}${d}`)
    }
    return rows
  }
}

/** The stripped cells of one parameter row. */
interface ParamRow {
  readonly name: string
  readonly type: string
  readonly req: string
  readonly desc: string
}

/** Column widths of the parameter table. */
type Widths = ReturnType<typeof cellWidths>

/** Cells of the gaps between the four table columns. */
const PARAM_GAPS = 6
/** Fraction of the room that the type column can take before it wraps. */
const TYPE_SHARE = 0.3
/** The type column keeps at least this many cells (or its full width). */
const MIN_TYPE_CELLS = 8
/** Below this many description cells, the table changes to the stacked form. */
const MIN_DESC_CELLS = 20

/**
 * The type and description column widths for `room` cells, or `undefined`
 * when the description column is too narrow (then use the stacked form).
 */
function paramLayout(w: Widths, room: number): { type: number; desc: number } | undefined {
  const cap = Math.max(MIN_TYPE_CELLS, Math.floor(room * TYPE_SHARE))
  const type = Math.min(w.type, cap)
  const desc = room - w.name - type - w.req - PARAM_GAPS
  return desc < MIN_DESC_CELLS ? undefined : { type, desc }
}

/** One tool part: the owner ref, the description lines, then the parameter table. */
function renderTool(part: DumpPart, opts: VerboseRenderOptions): string[] {
  // Stripped once, then used for both the header and the owner lookup: a
  // control byte must not change which plugin the name resolves to either.
  const label = stripControls(part.name)
  const digits = digitsOf(part.lines)
  return [
    fitTitle(`${PART_INDENT}${c.magenta(label)}${sizeTag(part.size)}`, opts.wrapWidth),
    refLine(toolRef(label, opts.origins), opts.wrapWidth),
    ...gutterLines(part.lines, digits, opts.wrapWidth),
    ...elidedLines(part.elided ?? [], digits, opts.wrapWidth),
    ...paramLines(part, opts.wrapWidth),
  ]
}

/** One part of a section, by section. */
function renderPart(
  section: DumpSectionName,
  part: DumpPart,
  n: number,
  toolNames: Map<string, string>,
  opts: VerboseRenderOptions,
): string[] {
  switch (section) {
    case "messages":
      return renderMessage(part, n, toolNames, opts.wrapWidth)
    case "system":
      return renderSystem(part, opts)
    case "tools":
      return renderTool(part, opts)
    default: {
      const _exhaustive: never = section
      return _exhaustive
    }
  }
}

/**
 * Render the parts of one body section in verbose form.
 *
 * @param section - Section name.
 * @param parts - Parts of the section, from `dumpView(req, { lines: true })`.
 * @param opts - Origin data and wrap width.
 * @returns Styled lines, without the section header.
 */
export function renderVerboseSection(
  section: DumpSectionName,
  parts: readonly DumpPart[],
  opts: VerboseRenderOptions = {},
): string[] {
  const out: string[] = []
  const toolNames = new Map<string, string>()
  parts.forEach((part, i) => {
    out.push(...renderPart(section, part, i + 1, toolNames, opts))
  })
  return out
}
