/**
 * `--debug` request dump, rendered as colored scrollback blocks in the TUI.
 *
 * # History
 *
 * Before the core/CLI split the transport printed this dump itself, with
 * `console.error`, and the live-area `StdioInterceptor` captured those
 * writes and re-emitted them above the prompt. The S25 "no engine writes to
 * the terminal" refactor turned the dump into plain-text Debug diagnostics,
 * and for a time this module parsed those rows back into a block.
 *
 * Now core publishes a typed `llm.requestWillSend` event (a redacted request
 * snapshot), and the CLI builds a {@link DumpView} from it
 * (`logging/request-dump-model.ts`). This module draws that view. It parses
 * no text: the section, the part name and the cache breakpoint are data.
 *
 * # CLI decisions
 *
 * The verbose form, the 80-character preview cap, the width clip, the
 * section order (from the view) and the colors are all decided here and in
 * `debug-dump-verbose.ts`, not in core.
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
import { DUMP_FRAME_LABEL, dumpFacts, dumpModel } from "../../logging/request-dump-header.ts"
import {
  type DumpKvRow,
  type DumpKvSection,
  keyWidth,
  kvUnit,
} from "../../logging/request-dump-kv.ts"
import {
  type DumpPart,
  type DumpSectionName,
  type DumpView,
  oneLine,
  PREVIEW_CAP,
} from "../../logging/request-dump-model.ts"
import { type DumpSize, sizeLabel } from "../../logging/request-dump-size.ts"
import { paramSummary } from "../../logging/tool-schema.ts"
import { c } from "../style/ansi.ts"
import { truncHint } from "../style/truncate-hint.ts"
import {
  DEFAULT_TOOL_ICON,
  formatFrameHeaderRow,
  frameBodyRow,
  frameCloseRow,
  frameHeaderChromeCells,
} from "../tool-transcript/format.ts"
import {
  TOOL_PREVIEW_GUTTER_WIDTH,
  TOOL_PREVIEW_WRAP_SAFETY_WIDTH,
} from "../tool-transcript/preview-width.ts"
import {
  CACHE_BLOCK_LABEL,
  CACHE_MSG_LABEL,
  fitTitle,
  hardWrap,
  renderVerboseSection,
  sizeTag,
  stripControls,
  type VerboseRenderOptions,
} from "./debug-dump-verbose.ts"

/**
 * Fit one preview into `room` cells.
 *
 * `cap` is the preview cap in characters (`undefined`: no cap). A capped
 * preview ends with one `...(+Nch)` hint. When the line still does not fit,
 * the text is cut more and that count is folded into the same hint, so the
 * line keeps one hint and its number stays the true elided total.
 *
 * The count of the cap is taken on the raw text, and the count of the width
 * cut on the text after {@link stripControls}: the same arithmetic as the
 * renderer that parsed the plain rows (the golden tests prove it).
 *
 * @param full - The one-line full preview, raw.
 * @param room - Cells for the text. `undefined`: no width clip.
 * @param cap - Preview cap in characters, or `undefined`.
 * @returns The text to paint (control bytes removed).
 */
function fitBody(full: string, room: number | undefined, cap: number | undefined): string {
  const clamped = cap !== undefined && full.length > cap ? full.slice(0, cap) : full
  const already = full.length - clamped.length
  const base = stripControls(clamped)
  const body = `${base}${truncHint(already)}`
  if (room === undefined || displayWidth(body) <= room) return body
  // Reserve the widest hint we could need, then cut the base to the rest.
  const keepWidth = room - displayWidth(truncHint(already + base.length))
  if (keepWidth <= 0) return truncateDisplayWidth(body, room)
  const kept = truncateDisplayWidth(base, keepWidth, "")
  return `${kept}${truncHint(already + base.length - kept.length)}`
}

/**
 * Join a styled prefix and a dim, capped preview, clipped to `width` cells.
 *
 * `width` undefined means no clip (`--verbose`, or no TTY width).
 */
function fitLine(prefix: string, full: string, width: number | undefined): string {
  if (width === undefined) return `${prefix}${c.dim(fitBody(full, undefined, PREVIEW_CAP))}`
  const room = width - displayWidth(prefix)
  if (room <= 0) return truncateDisplayWidth(prefix, width)
  return `${prefix}${c.dim(fitBody(full, room, PREVIEW_CAP))}`
}

/** Cells a compact preview keeps before the size label is dropped. */
const MIN_PREVIEW_CELLS = 16

/** The bright-green cache label after a part name, or nothing. */
function cacheMark(part: DumpPart, label: string): string {
  return part.cached ? ` ${c.bold(c.brightGreen(label))}` : ""
}

/**
 * Style one compact part row. The section drives the palette, so a
 * `messages` row reads like the old renderer, a `tools` row names the tool in
 * magenta, and cache markers pop in bright green.
 *
 * @param part - The part.
 * @param width - Clip width, or `undefined`.
 * @param n - 1-based position of the part in its section.
 */
function renderRow(part: DumpPart, width: number | undefined, n: number): string {
  const name = stripControls(part.name)
  // The size label is part of the clamp budget. On a narrow row it goes
  // away, so the preview keeps at least MIN_PREVIEW_CELLS.
  const fits = (prefix: string): boolean =>
    width === undefined || width - displayWidth(prefix) >= MIN_PREVIEW_CELLS
  const pick = (build: (tag: string) => string): string => {
    const full = build(sizeTag(part.size))
    return fits(full) ? full : build("")
  }
  switch (part.section) {
    case "messages": {
      // `#N`: the history position. Each request sends the full history, so
      // the part position is that position.
      const num = `${c.bold(`#${n}`)} `
      const mark = cacheMark(part, CACHE_MSG_LABEL)
      return fitLine(
        pick((t) => `      ${num}${c.green(name)}${mark}${t}: `),
        part.full,
        width,
      )
    }
    case "system":
      return fitLine(
        pick((t) => `      ${c.magenta(name)}${cacheMark(part, CACHE_BLOCK_LABEL)}${t}: `),
        part.full,
        width,
      )
    case "tools":
      return fitLine(
        pick((t) => `      ${c.magenta(name)}${t}: `),
        part.full,
        width,
      )
    default: {
      const _exhaustive: never = part.section
      return _exhaustive
    }
  }
}

/**
 * Render one request as the colored lines the user sees in the TUI.
 *
 * Each request becomes one block in the shared tool transcript frame: the
 * `╭ ◆ request  <model> · <facts>` header row (see `formatFrameHeaderRow`), dim
 * key/value header fields, then a bold `Body:` line with its yellow section
 * names and per-section rows behind the `│` gutter, then the `╰` closer. The blank line before the header is included so
 * consecutive requests stay visually separated in scrollback.
 *
 * With `verbose.enabled`, each section renders as real lines with a gutter
 * and reference lines instead (see `debug-dump-verbose.ts`). Build the view
 * with `dumpView(req, { lines: true })` for that form.
 *
 * Every plugin-, core- and model-controlled string passes through
 * `stripControls` before it reaches the screen, so a control byte can never
 * start an escape sequence here.
 *
 * @param view - The typed dump view.
 * @param width - Terminal cells per line. Each compact line is clipped to it,
 *   so a row never wraps. Omit it to keep lines whole (`--verbose`, or no TTY).
 * @param verbose - The verbose switch, origin data and the hanging-indent
 *   wrap width. Verbose lines are never clipped.
 * @returns Styled lines, ready for a single `writeStream` call.
 */
export function renderDumpBlock(
  view: DumpView,
  width?: number,
  verbose: VerboseRenderOptions = {},
): string[] {
  const cols = width !== undefined && width > 0 ? width : undefined
  // Body rows sit behind the frame gutter, so they get the inner width.
  const w =
    cols === undefined
      ? undefined
      : Math.max(1, cols - TOOL_PREVIEW_GUTTER_WIDTH - TOOL_PREVIEW_WRAP_SAFETY_WIDTH)
  // The header clamps to the terminal width, else to the verbose wrap width.
  const frame = cols ?? verbose.wrapWidth
  const header = dumpFrameHeader(view, frame)
  // Verbose rows are never clipped: they wrap to the room behind the gutter.
  const inner = (n: number | undefined): number | undefined =>
    n === undefined ? undefined : Math.max(1, n - TOOL_PREVIEW_GUTTER_WIDTH)
  const vopts: VerboseRenderOptions = { ...verbose, wrapWidth: inner(verbose.wrapWidth) }
  const out: string[] = []

  for (const [key, value] of view.fields) {
    const prefix = `  ${c.dim(`${stripControls(key)}:`)} `
    // Field values stay at normal intensity, so clip without the dim wrap.
    const room = w === undefined ? undefined : w - displayWidth(prefix)
    out.push(`${prefix}${fitBody(value, room, undefined)}`)
  }

  if (view.sections.length > 0 || view.kv.length > 0) out.push(`  ${c.bold("Body:")}`)
  const on = verbose.enabled === true
  for (const section of view.kv) {
    out.push(...renderKvSection(section, on ? vopts.wrapWidth : w, on))
  }

  for (const section of view.sections) {
    const count = ` ${c.dim(`[${section.parts.length} ${unitFor(section.name)}]`)}`
    out.push(
      fitTitle(
        `    ${c.yellow(section.name)}:${count}${sectionTotal(section.size)}`,
        on ? vopts.wrapWidth : w,
      ),
    )
    if (verbose.enabled === true) {
      out.push(...renderVerboseSection(section.name, section.parts, vopts))
      continue
    }
    section.parts.forEach((part, i) => {
      out.push(renderRow(part, w, i + 1))
      const summary = paramSummary(part.params ?? [])
      if (summary !== "") out.push(fitLine(`        ${c.dim("params:")} `, summary, w))
    })
  }

  return ["", header, ...out.map((row) => frameBodyRow(row, cols)), frameCloseRow()]
}

/**
 * The frame header row of one request: the shared tool header with the
 * label `request`, the model as the header text and the facts at the place
 * of the tool `· time`. Narrow: the facts go first, then the row clamp clips
 * the model with the `...(+Nch)` hint.
 */
export function dumpFrameHeader(view: DumpView, cols?: number): string {
  const model = stripControls(dumpModel(view))
  const facts = stripControls(dumpFacts(view))
  const chrome = frameHeaderChromeCells(DEFAULT_TOOL_ICON, DUMP_FRAME_LABEL)
  const room = cols === undefined ? undefined : cols - TOOL_PREVIEW_WRAP_SAFETY_WIDTH - chrome
  const fits = room === undefined || displayWidth(model) + displayWidth(` · ${facts}`) <= room
  return formatFrameHeaderRow({
    label: DUMP_FRAME_LABEL,
    text: model,
    timeText: fits ? facts : undefined,
    cols,
  })
}

/** The dim ` · <size>` total of a section header, or nothing. */
function sectionTotal(size: DumpSize | undefined): string {
  return size === undefined ? "" : c.dim(` · ${sizeLabel(size)}`)
}

/** Paint a value: dim italic when core masked it, normal otherwise. */
function paintValue(r: DumpKvRow, text: string): string {
  return r.redacted ? c.dim(c.italic(text)) : text
}

/**
 * Render one `headers` or `body` section: aligned rows, the key in the
 * accent color (cyan, like tool parameter names). Compact: a one-line value
 * cut at the preview cap and clipped to `width`. Verbose: the full value, and
 * an object value as pretty JSON lines behind the dim `┆` gutter.
 */
export function renderKvSection(
  section: DumpKvSection,
  width: number | undefined,
  verbose: boolean,
): string[] {
  const out = [
    fitTitle(
      `    ${c.yellow(section.name)}: ${c.dim(`[${section.rows.length} ${kvUnit(section.name)}]`)}${sectionTotal(section.size)}`,
      width,
    ),
  ]
  const w = keyWidth(section)
  // Size labels pad to one width, so the values stay in one column.
  const labels = section.rows.map((r) => (r.size === undefined ? "" : sizeLabel(r.size)))
  const lw = labels.reduce((m, l) => Math.max(m, displayWidth(l)), 0)
  const tag = (i: number): string => (lw === 0 ? "" : `${c.dim((labels[i] ?? "").padEnd(lw))}  `)
  section.rows.forEach((r, i) => {
    const key = stripControls(r.key)
    if (!verbose) {
      const prefix = `      ${c.cyan(key.padEnd(w))}  ${tag(i)}`
      const room = width === undefined ? undefined : width - displayWidth(prefix)
      if (room !== undefined && room <= 0) {
        out.push(truncateDisplayWidth(prefix, width ?? 0))
        return
      }
      out.push(`${prefix}${paintValue(r, fitBody(oneLine(r.value), room, PREVIEW_CAP))}`)
      return
    }
    if (r.pretty === undefined) {
      const prefix = `      ${c.cyan(key.padEnd(w))}  ${tag(i)}`
      out.push(...hanging(prefix, stripControls(r.value), width, (t) => paintValue(r, t)))
      return
    }
    const label = labels[i] === "" ? "" : ` ${c.dim(labels[i] ?? "")}`
    out.push(fitTitle(`      ${c.cyan(key)}${label}`, width))
    const gutter = `        ${c.dim("┆")} `
    for (const line of r.pretty) out.push(...hanging(gutter, stripControls(line), width, (t) => t))
  })
  return out
}

/**
 * Word-wrap `text` behind `prefix` to `width` cells. Each next line gets a
 * blank indent of the real prefix width (displayWidth), so no line passes
 * the width. `width` undefined: one line, no wrap.
 */
function hanging(
  prefix: string,
  text: string,
  width: number | undefined,
  paint: (t: string) => string,
): string[] {
  if (width === undefined) return [`${prefix}${paint(text)}`]
  const lead = displayWidth(prefix)
  const room = width - lead
  if (room < 1) return [truncateDisplayWidth(`${prefix}${text}`, width, "…")]
  const [first, ...rest] = hardWrap(text, room, "word")
  const blank = " ".repeat(lead)
  return [`${prefix}${paint(first ?? "")}`, ...rest.map((t) => `${blank}${paint(t)}`)]
}

/** The noun a section's count label uses. */
function unitFor(section: DumpSectionName): string {
  switch (section) {
    case "messages":
      return "message(s)"
    case "system":
      return "block(s)"
    case "tools":
      return "tool(s)"
    default: {
      const _exhaustive: never = section
      return _exhaustive
    }
  }
}
