/**
 * Diagnostics rendering (LSP / linter / formatter feedback) for the tool
 * transcript. Split out of `format.ts` (max-lines); `format.ts` re-exports the
 * public names so existing imports keep working.
 *
 * @module ui/tool-transcript/diagnostics-panel
 */

import { expandTabs } from "@minimal-agent/core/plugin-api/utils/term-width"
import type { Finding, FindingSeverity } from "@minimal-agent/core/sdk/tool-lifecycle"
import { c } from "../style/ansi.ts"
import { wrapPreserving } from "./diff-rows.ts"
import { toolPreviewBodyWidth } from "./preview-width.ts"

// ---------------------------------------------------------------------------
// Diagnostics rendering (LSP / linter / formatter feedback)
//
// The AGENT owns the TUI; a plugin (`diagnostics`) provides structured
// {@link Finding}s on the `tool.didInvoke` chain. These pure helpers turn that
// data into the agent's own chrome:
//
//  - {@link renderFindingsPanel}: colored transcript rows inside the tool-block
//    gutter (`│ ┊ ╰`), severity dots, dim codes/locations, `·`-joined summary.
//  - {@link formatDiagnosticsAnnotation}: the model-facing
//    `<ma::agent::diagnostics>` block appended to the tool_result content (and
//    stripped from the human preview by `findAnnotationStart`).
//
// Both are deliberately pure (no IO) so they unit-test without a TTY.
// ---------------------------------------------------------------------------

/** Severity sort weight: errors first, then warnings, then info. */
const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 }

/** Default max diagnostic rows rendered in the panel before collapsing. */
export const DIAGNOSTICS_PANEL_MAX_ROWS = 6

/** The severity dot, colored per severity (red error / gold warning / sky info). */
function severityDot(sev: FindingSeverity): string {
  if (sev === "error") return c.red("●")
  if (sev === "warning") return c.gold("●")
  return c.sky("●")
}

/** `12:5` location fragment, dim. Empty when the finding has no location. */
function locationFragment(f: Finding): string {
  if (typeof f.line !== "number") return ""
  return typeof f.col === "number" ? `${f.line}:${f.col}` : `${f.line}`
}

/** Cells a finding's continuation rows hang under: past the `● ` dot. */
const FINDING_HANG = 2

/**
 * Color one line of a finding message. Inside a diff section (entered after a
 * line ending in `:`), `-`/`+` lines take the diff viewer's pink/lime and ` `
 * context lines go dim. Any other line ends the section and prints plain.
 */
function styleMessageLine(line: string, inDiff: boolean): { text: string; inDiff: boolean } {
  if (inDiff && /^[-+ ]/.test(line)) {
    const sign = line[0]
    const text = sign === "+" ? c.lime(line) : sign === "-" ? c.pink(line) : c.dim(line)
    return { text, inDiff: true }
  }
  if (/^…?\(truncated\)$/.test(line.trim())) return { text: c.dim(line), inDiff }
  return { text: line, inDiff: /:\s*$/.test(line) }
}

/**
 * Lay out one finding as transcript rows, without the gutter. Nothing is cut:
 * the first line wraps at word boundaries, and every later message line
 * (multi-line messages like biome's embedded format diff) sits on its own row.
 * Continuation rows hang under the text, past the severity dot. Tabs expand so
 * code in a diff keeps its indentation. With no width signal, lines wrap only
 * at their own newlines.
 */
function findingRows(f: Finding, width: number | undefined): string[] {
  const loc = locationFragment(f)
  const locPart = loc ? `${c.dim(loc)} ` : ""
  const codePart = f.code ? `${c.dim(f.code)} ` : ""
  const lines = f.message
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => expandTabs(l, 0, 4))
  const hang = " ".repeat(FINDING_HANG)
  const wrapW = width === undefined ? 0 : Math.max(1, width - FINDING_HANG)

  const rows: string[] = []
  // First line: dot + location + code + text, wrapped with a hanging indent.
  const head = `${locPart}${codePart}${lines[0] ?? ""}`
  const headFrags = wrapPreserving(head, wrapW)
  rows.push(`${severityDot(f.severity)} ${headFrags[0] ?? ""}`)
  for (const frag of headFrags.slice(1)) rows.push(`${hang}${frag}`)

  let inDiff = /:\s*$/.test(lines[0] ?? "")
  for (const raw of lines.slice(1)) {
    const styled = styleMessageLine(raw, inDiff)
    inDiff = styled.inDiff
    // A wrapped diff line indents its tail one cell past the `-`/`+` sign so
    // the tail never reads as a context line of its own.
    const [first = "", ...rest] = wrapPreserving(styled.text, wrapW)
    rows.push(`${hang}${first}`)
    if (rest.length === 0) continue
    const tail = rest.join("")
    const tailW = inDiff && wrapW > 1 ? wrapW - 1 : wrapW
    const tailHang = inDiff ? `${hang} ` : hang
    for (const frag of wrapPreserving(tail, tailW)) rows.push(`${tailHang}${frag}`)
  }
  return rows
}

/**
 * Render plugin-provided {@link Finding}s into bordered tool-block rows.
 *
 * Returns `[]` for an empty list (the caller then emits nothing : a clean edit
 * stays calm). Otherwise: one `│ ● <loc> <code> <message>` row per finding
 * (errors first, capped at `maxRows` with a `┊ +N more` overflow row), then a
 * closing `╰ <summary>` row with `·`-joined counts.
 *
 * The rows reuse the exact gutter glyphs + palette of {@link formatToolPreview}
 * so diagnostics read as part of the same tool block, not a new widget.
 */
export function renderFindingsPanel(
  findings: Finding[],
  opts: { cols?: number; maxRows?: number } = {},
): string[] {
  if (findings.length === 0) return []
  const maxRows = opts.maxRows ?? DIAGNOSTICS_PANEL_MAX_ROWS
  const bodyWidth = toolPreviewBodyWidth(opts.cols)

  const sorted = [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
  const errors = sorted.filter((f) => f.severity === "error").length
  const warnings = sorted.filter((f) => f.severity === "warning").length
  const infos = sorted.filter((f) => f.severity === "info").length

  const shown = sorted.slice(0, maxRows)
  const hidden = sorted.length - shown.length

  const out: string[] = []
  for (const f of shown) {
    for (const row of findingRows(f, bodyWidth)) out.push(`  ${c.dimCyan("│")} ${row}`)
  }
  if (hidden > 0) {
    out.push(`  ${c.dimCyan("┊")} ${c.dim(`+${hidden} more`)}`)
  }

  // Summary line. Badge by worst severity present.
  const parts: string[] = []
  if (errors > 0) parts.push(c.red(`${errors} ${errors === 1 ? "error" : "errors"}`))
  if (warnings > 0) parts.push(c.gold(`${warnings} ${warnings === 1 ? "warning" : "warnings"}`))
  if (infos > 0) parts.push(c.dim(`${infos} info`))
  const badge = errors > 0 ? c.boldRed("✘") : warnings > 0 ? c.gold("▲") : c.sky("●")
  const summary = `${badge} ${parts.join(` ${c.dim("·")} `)}`
  out.push(`  ${c.dimCyan("╰")} ${summary}`)
  return out
}

/**
 * Build the model-facing `<ma::agent::diagnostics>` annotation from the
 * plugin's `notes`. Returns `""` when there are no notes (so the caller appends
 * nothing). The block rides at the tail of `tool_result.content`, separated by
 * `\n\n`, and is stripped from the human transcript by `findAnnotationStart`
 * (the prefix is registered in `ANNOTATION_PREFIXES`).
 *
 * Shape (one note per line, `count` attribute for a quick scan):
 *
 * ```text
 * <ma::agent::diagnostics count="2">
 * 12:5 error TS2322 Type 'string' is not assignable to type 'number'.
 * 7:1 warning no-unused-vars 'x' is never used.
 * </ma::agent::diagnostics>
 * ```
 */
export function formatDiagnosticsAnnotation(notes: string[], scope?: string): string {
  const clean = notes.filter((n) => typeof n === "string" && n.trim().length > 0)
  if (clean.length === 0) return ""
  const inner = clean.join("\n")
  const scopeAttr = scope === "ad-hoc" ? ' scope="ad-hoc"' : ""
  return `\n\n<ma::agent::diagnostics count="${clean.length}"${scopeAttr}>\n${inner}\n</ma::agent::diagnostics>`
}
