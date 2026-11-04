/**
 * Help colors (plan M-8, 2.1). The help model holds plain text (SPEC-HELP
 * R-3). These helpers add color at render time only, so the visible text is
 * the same with and without color.
 *
 * @module ui/help/style
 */

import { c } from "../style/ansi.ts"

/** Style one term token by its class. A trailing comma stays unstyled. */
function styleToken(token: string): string {
  if (token === "") return token
  if (token.endsWith(",") && token.length > 1) return `${styleToken(token.slice(0, -1))},`
  if (token === "|") return token
  if (token === "$" || token === "/" || token === "·") return c.dim(token)
  if (token.startsWith("<") || token.startsWith("[")) return c.dim(token)
  return c.cyan(token)
}

/**
 * Color a help term: flags, commands, and literal words cyan, placeholders
 * (`<x>`, `[x]`) and separators (`$`, `/`, `·`) dim, a pipe plain. Each
 * token gets its own style, so nothing stays open at the end.
 */
export function styleTerm(term: string): string {
  return term.split(" ").map(styleToken).join(" ")
}

/**
 * Color a row summary: a trailing `(note)` in balanced brackets renders
 * dim, the text before it stays plain. A summary with no trailing note
 * stays plain.
 */
export function styleSummary(summary: string): string {
  if (!summary.endsWith(")")) return summary
  let depth = 0
  for (let i = summary.length - 1; i >= 0; i--) {
    const ch = summary[i]
    if (ch === ")") depth++
    else if (ch === "(") depth--
    if (depth !== 0) continue
    if (i === 0) return c.dim(summary)
    if (summary[i - 1] !== " ") return summary
    return `${summary.slice(0, i - 1)} ${c.dim(summary.slice(i))}`
  }
  return summary
}

/**
 * Color a section title: the heading bold, a trailing `(note)` dim. The
 * note starts at the first ` (`.
 */
export function styleTitle(title: string): string {
  const at = title.indexOf(" (")
  if (at < 0) return c.bold(title)
  return `${c.bold(title.slice(0, at))} ${c.dim(title.slice(at + 1))}`
}
