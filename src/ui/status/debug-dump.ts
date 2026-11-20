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
import { paramSummary } from "../../logging/tool-schema.ts"
import { c } from "../style/ansi.ts"
import { truncHint } from "../style/truncate-hint.ts"
import {
  CACHE_BLOCK_LABEL,
  CACHE_MSG_LABEL,
  renderVerboseSection,
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
  switch (part.section) {
    case "messages": {
      // `#N`: the history position. Each request sends the full history, so
      // the part position is that position.
      const num = `${c.bold(`#${n}`)} `
      const mark = cacheMark(part, CACHE_MSG_LABEL)
      return fitLine(`      ${num}${c.green(name)}${mark}: `, part.full, width)
    }
    case "system":
      return fitLine(
        `      ${c.magenta(name)}${cacheMark(part, CACHE_BLOCK_LABEL)}: `,
        part.full,
        width,
      )
    case "tools":
      return fitLine(`      ${c.magenta(name)}: `, part.full, width)
    default: {
      const _exhaustive: never = part.section
      return _exhaustive
    }
  }
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
 * Render one request as the colored lines the user sees in the TUI.
 *
 * Each request becomes one block: the bold-cyan `--- POST … ---` header, dim
 * key/value header fields, then a bold `Body:` line with its yellow section
 * names and per-section rows. The blank line before the header is included so
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
  const w = width !== undefined && width > 0 ? width : undefined
  const label = `--- POST ${view.model ?? "(default model)"} ---`
  const out = ["", c.bold(c.cyan(clipLabel(label, w)))]

  for (const [key, value] of view.fields) {
    const prefix = `  ${c.dim(`${stripControls(key)}:`)} `
    // Field values stay at normal intensity, so clip without the dim wrap.
    const room = w === undefined ? undefined : w - displayWidth(prefix)
    out.push(`${prefix}${fitBody(value, room, undefined)}`)
  }

  if (view.sections.length > 0 || view.kv.length > 0) out.push(`  ${c.bold("Body:")}`)
  for (const section of view.kv) out.push(...renderKvSection(section, w, verbose.enabled === true))

  for (const section of view.sections) {
    const count = ` ${c.dim(`[${section.parts.length} ${unitFor(section.name)}]`)}`
    out.push(`    ${c.yellow(section.name)}:${count}`)
    if (verbose.enabled === true) {
      out.push(...renderVerboseSection(section.name, section.parts, verbose))
      continue
    }
    section.parts.forEach((part, i) => {
      out.push(renderRow(part, w, i + 1))
      const summary = paramSummary(part.params ?? [])
      if (summary !== "") out.push(fitLine(`        ${c.dim("params:")} `, summary, w))
    })
  }

  return out
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
    `    ${c.yellow(section.name)}: ${c.dim(`[${section.rows.length} ${kvUnit(section.name)}]`)}`,
  ]
  const w = keyWidth(section)
  for (const r of section.rows) {
    const key = stripControls(r.key)
    const prefix = `      ${c.cyan(key.padEnd(w))}  `
    if (!verbose) {
      const room = width === undefined ? undefined : width - displayWidth(prefix)
      if (room !== undefined && room <= 0) {
        out.push(truncateDisplayWidth(prefix, width ?? 0))
        continue
      }
      out.push(`${prefix}${paintValue(r, fitBody(oneLine(r.value), room, PREVIEW_CAP))}`)
      continue
    }
    if (r.pretty === undefined) {
      out.push(`${prefix}${paintValue(r, stripControls(r.value))}`)
      continue
    }
    out.push(`      ${c.cyan(key)}`)
    for (const line of r.pretty) out.push(`        ${c.dim("┆")} ${stripControls(line)}`)
  }
  return out
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
