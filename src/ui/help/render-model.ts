/**
 * Render any {@link HelpModel} in the spec 8.5 layout (SPEC-HELP 8.5, 8.6,
 * plan M-9b, 4.3).
 *
 * Layout:
 *   - Header: the title at indent 2, the text paragraphs at indent 4.
 *   - Each other section: a blank line, the title at indent 2, the text at
 *     indent 4, the rows at indent 4. A group title sits at indent 4 with
 *     its rows at indent 6.
 *
 * All wrapping, alignment, the long-token rule, and the SGR close come from
 * the M-7 primitives in `render.ts`. The model is plain text (R-3). Color is
 * added here from `style.ts`, only when `policy.color` is true.
 *
 * Root help still renders through `legacy-root.ts` until M-8d. This
 * renderer accepts a root model too, so M-8d can switch to it.
 *
 * @module ui/help/render-model
 */

import type {
  HelpModel,
  HelpModelRow,
  HelpModelSection,
} from "@minimal-agent/core/plugin-api/types/cli-contract"

import { c } from "../style/ansi.ts"
import { type HelpRow, renderHelpSections, wrapHelpText } from "./render.ts"
import { styleSummary, styleTerm, styleTitle } from "./style.ts"

/** Width and color of one render. Same shape as `HelpPolicy` (policy.ts). */
export interface RenderModelPolicy {
  /** Wrap width in cells. Omit for no wrapping. */
  readonly width?: number
  /** True when SGR sequences may be written. Default `false`. */
  readonly color?: boolean
}

/** Indent of a section title. */
const TITLE_INDENT = 2
/** Indent of section text and rows. */
const BODY_INDENT = 4
/** Indent of rows under a group title. */
const GROUP_ROW_INDENT = 6
/** Continuation indent of a wrapped usage line. */
const USAGE_HANG = 6

interface Ctx {
  readonly width: number | undefined
  readonly color: boolean
}

/** Rows at `rowIndent`, through `renderHelpSections` with no title line. */
function rowLines(
  rows: readonly HelpModelRow[],
  rowIndent: number,
  ctx: Ctx,
  id: string,
): string[] {
  if (rows.length === 0) return []
  const opts = { indent: rowIndent, rowIndent, width: ctx.width, color: ctx.color }
  // renderHelpSections always draws a title line first. Draw an empty one and
  // drop it, so the rows keep the shared alignment and wrap rules.
  const head = renderHelpSections([{ title: "", rows: [] }], opts).length
  const styled = rows.map((row) => styleRow(row, id, ctx.color))
  return renderHelpSections([{ title: "", rows: styled }], opts).slice(head)
}

function styleRow(row: HelpModelRow, id: string, color: boolean): HelpRow {
  if (!color) return { term: row.term, summary: row.summary }
  if (id === "examples") return { term: styleTerm(row.term), summary: c.dim(row.summary) }
  return { term: styleTerm(row.term), summary: styleSummary(row.summary) }
}

function text(line: string, indent: number, hang: number, ctx: Ctx): string[] {
  return wrapHelpText(line, { indent, hang, width: ctx.width, color: ctx.color })
}

function styleText(line: string, id: string, color: boolean): string {
  if (!color) return line
  if (id === "usage") return styleTerm(line)
  if (id === "global-flags") return c.dim(line)
  return line
}

function headerLines(section: HelpModelSection, ctx: Ctx): string[] {
  const title = ctx.color ? c.bold(c.cyan(section.title)) : section.title
  return [
    ...text(title, TITLE_INDENT, BODY_INDENT, ctx),
    ...(section.text ?? []).flatMap((line) => text(line, BODY_INDENT, BODY_INDENT, ctx)),
  ]
}

function sectionLines(section: HelpModelSection, ctx: Ctx): string[] {
  const out: string[] = []
  if (section.title !== "") {
    const title = ctx.color ? styleTitle(section.title) : section.title
    out.push(...text(title, TITLE_INDENT, BODY_INDENT, ctx))
  }
  const hang = section.id === "usage" ? USAGE_HANG : BODY_INDENT
  for (const line of section.text ?? []) {
    out.push(...text(styleText(line, section.id, ctx.color), BODY_INDENT, hang, ctx))
  }
  out.push(...rowLines(section.rows ?? [], BODY_INDENT, ctx, section.id))
  for (const group of section.groups ?? []) {
    const title = ctx.color ? styleTitle(group.title) : group.title
    out.push(...text(title, BODY_INDENT, BODY_INDENT + 2, ctx))
    out.push(...rowLines(group.rows, GROUP_ROW_INDENT, ctx, section.id))
  }
  return out
}

/**
 * Render a help model to lines (no trailing newline). Empty sections are
 * already left out by the model builder. A blank line separates sections.
 */
export function renderModel(model: HelpModel, policy: RenderModelPolicy = {}): string[] {
  const width =
    policy.width !== undefined && policy.width > 0 ? Math.floor(policy.width) : undefined
  const ctx: Ctx = { width, color: policy.color === true }
  const out: string[] = []
  for (const section of model.sections) {
    const lines = section.id === "header" ? headerLines(section, ctx) : sectionLines(section, ctx)
    if (lines.length === 0) continue
    if (out.length > 0) out.push("")
    out.push(...lines)
  }
  return out
}
