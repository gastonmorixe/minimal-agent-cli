/**
 * Tool input/output formatting for the agentic transcript: header
 * lines, continuation rows, and bordered output previews shown
 * inline between the `╭` and `╰` frames.
 *
 * Names are re-exported from `agent.ts` for back-compat with existing
 * consumers (`session-replay.ts`, tests, etc.).
 *
 * @module ui/tool-transcript/format
 */

import { homedir } from "node:os"
import {
  globPathFromInput,
  globPatternFromInput,
} from "@minimal-agent/core/host/tool-input-aliases"
import { countLines, type TruncationInfo } from "@minimal-agent/core/host/truncation"
import { formatPathCompact } from "@minimal-agent/core/plugin-api/utils/path-compact"
import {
  displayWidth,
  expandTabs,
  truncateDisplayWidth,
  wordWrap,
  wrapIndented,
} from "@minimal-agent/core/plugin-api/utils/term-width"
import type { ToolUseBlock } from "@minimal-agent/core/sdk/messages"
import type { Finding, FindingSeverity } from "@minimal-agent/core/sdk/tool-lifecycle"
import {
  BASH_HEADER_PREFIX_CELLS_DEFAULT,
  shouldSoftSplit,
  splitBashSegments,
} from "../../cli/bash-split.ts"
import { detectInlineScript, type InlineScript } from "../../cli/inline-script.ts"
import { c } from "../style/ansi.ts"
import { truncHint } from "../style/truncate-hint.ts"
import { isNewFileDisplay, renderDiffRows, renderNewFileRows, renderReadRows } from "./diff-rows.ts"

// Colors a plain Edit/Write diff when no code highlighter runs (S41: core
// emits the plain patch).
export { renderUnifiedDiff } from "../../terminal-kit/unified-diff.ts"
export { resolveFileLanguage } from "../formatter/file-language.ts"
export type {
  CodeHighlighter,
  CodeHighlightRequest,
} from "../formatter/mdstream-code-highlighter.ts"
export { highlightReadBody, highlightUnifiedDiff } from "./code-highlight-render.ts"

/**
 * Cosmetic per-tool presentation hints stripped from tool definitions before
 * they go on the model wire. The transcript renderer owns how these hints are
 * applied to the TUI frame.
 */
export interface ToolPresentation {
  /** Glyph drawn before the bold tool name in the transcript header. */
  icon?: string
  /** Palette key (a method name on `c`) for the icon + label color. */
  color?: string
  /**
   * Input field whose value can headline the transcript header before the
   * handler returns.
   */
  headerKey?: string
}

/**
 * Icon for a tool with no presentation row or no row icon (a user plugin,
 * an alias). Every tool header and startup row then shows an icon.
 */
export const DEFAULT_TOOL_ICON = "◆"

/** The icon to draw for a tool: its row icon, else {@link DEFAULT_TOOL_ICON}. */
export function toolIcon(presentation?: ToolPresentation | null): string {
  return presentation?.icon || DEFAULT_TOOL_ICON
}

/**
 * Per-tool char cap for the bordered tool **header** line ("╭ Bash $ ..."),
 * applied only when the input field truly overflows. The cap is generous
 * (500 chars for Bash, 200 for the JSON fallback) : much wider than the
 * old 80-ch hard slice that often cut Bash commands mid-token. We never
 * pad to terminal width; if the line overflows the terminal cells, the
 * terminal wraps and that's fine.
 */
const HEADER_BASH_MAX = 500
const HEADER_JSON_MAX = 200

/**
 * Max continuation rows rendered for a multi-line Bash command in the
 * bordered block before collapsing the rest into a `> ... +NL more` row.
 * Generous enough to show typical heredocs / for-loops / function bodies
 * without dominating the screen.
 *
 * An **inline script** (`python -c '…'`, `node -e '…'`, `jq '…'`) raises the
 * budget to {@link BASH_CONT_MAX_LINES_SCRIPT}: its payload is the content
 * worth reading, and a one-line script that unwraps into 20 statements would
 * otherwise show 16 and hide the rest behind a count.
 */
const BASH_CONT_MAX_LINES = 16
export const BASH_CONT_MAX_LINES_SCRIPT = 30

/**
 * Trim `s` to at most `max` characters, preferring a word boundary so we
 * don't cut mid-token. The primary failure mode of the old hard slice
 * was things like `… | head...(+4ch)` : four characters short of
 * `head -50`, useless. Here we walk back to the last whitespace within
 * the trailing 15% of the budget and prefer it over a hard cut. If no
 * whitespace exists in that window (single-token blob), we fall through
 * to the hard cut so we never balloon past `max` itself.
 */
function trimAtWordBoundary(s: string, max: number): string {
  if (s.length <= max) return s
  const slack = Math.floor(max * 0.15)
  const window = s.slice(0, max)
  // Find the last whitespace within the last `slack` chars of the window.
  const wsIdx = window.search(/\s\S*$/)
  if (wsIdx >= max - slack) return s.slice(0, wsIdx)
  return window
}

/**
 * The two parts a bordered Bash block is built from: the text that follows
 * `$ ` on the header row, and the continuation rows underneath it (each
 * already carrying its own `> ` or `↳ ` sigil, without the frame gutter).
 *
 * {@link formatToolInput} and {@link formatToolInputContinuation} both consume
 * the same plan, built by {@link planBashInput}, so the header and its rows can
 * never disagree about how a command was decomposed.
 */
interface BashInputPlan {
  /** Header body : the command text that follows the `$ ` sigil. */
  body: string
  /** Continuation rows, sigil-prefixed, in source order. */
  rows: string[]
}

/**
 * Cells a row spends before its body starts: `  ╭ ` / `  │ ` frame (4),
 * the icon + label + gap, and the `$ ` sigil (or the continuation indent that
 * lines the sigil up under it). Both the header row and its continuation rows
 * spend the same 14 cells, so one constant covers both.
 */
const BASH_ROW_CHROME_CELLS = BASH_HEADER_PREFIX_CELLS_DEFAULT

/** Narrowest header body worth painting; below this we let the row clamp win. */
const BASH_MIN_BODY_CELLS = 40

/**
 * Trim `s` to `budget` chars at a word boundary and append the canonical
 * `...(+Nch)` hint. Returns `s` untouched when it already fits.
 *
 * Every place that shortens a Bash fragment funnels through here so the
 * elision marker stays consistent with the body previews and the row clamp.
 */
function fit(s: string, budget: number): string {
  if (s.length <= budget) return s
  const trimmed = trimAtWordBoundary(s, Math.max(1, budget - TOOL_PREVIEW_HINT_RESERVE_WIDTH))
  const cut = s.length - trimmed.length
  return cut > 0 ? `${trimmed}${truncHint(cut, "ch")}` : trimmed
}

/**
 * Elide the **middle** of an over-long command, keeping a word-aligned head
 * and tail. Used when a command must be shortened for the terminal: the head
 * says what runs, the tail keeps the final arguments (the `| head -50`, the
 * closing `'`), and the marker reports what went missing in between.
 *
 * Returns `null` when the line cannot be split honestly: no whitespace at all
 * (a base64 blob or a minified bundle argument), or no whitespace far enough
 * back for the tail to fit its share of the budget. A mid-token cut of such a
 * line would just be a wall of noise, so the caller falls back to a plain trim.
 */
function elideMiddle(line: string, budget: number): string | null {
  if (!/\s/.test(line)) return null
  const hintReserve = TOOL_PREVIEW_HINT_RESERVE_WIDTH
  const tailBudget = Math.max(8, Math.floor(budget * 0.35))
  const headBudget = budget - tailBudget - hintReserve
  if (headBudget < 16) return null

  const head = trimAtWordBoundary(line, headBudget)
  // Start the tail at the earliest whitespace that still leaves the tail
  // inside its budget, so the tail is as long as it can be. Walking backwards
  // from the end instead would grab the innermost space (`-50` rather than
  // `| head -50`), which reads as noise.
  let tailStart = Math.max(0, line.length - tailBudget)
  while (tailStart < line.length && line[tailStart] !== " ") tailStart++
  tailStart += 1
  if (tailStart >= line.length || tailStart <= head.length) return null
  const tail = line.slice(tailStart)
  const cut = line.length - head.length - tail.length
  if (cut <= 0) return null
  return `${head} ${truncHint(cut, "ch")} ${tail}`
}

/**
 * Decide how a Bash `command` renders: which text stays on the header row and
 * which (if any) rows follow it.
 *
 * Four strategies, tried in order, each keyed on **what the command contains**
 * rather than on how the model happened to format it:
 *
 *  1. **Inline script** (`python -c '…'`, `node -e '…'`, `jq '…'`) that
 *     overflows, or carries 3+ statements. The prologue stays on the header
 *     row and each depth-0 statement becomes a `> ` row, so the payload reads
 *     exactly like a genuinely multi-line command. This is the case that
 *     previously lost the whole script to a mid-token cut.
 *  2. **Top-level operators** (`&&`, `||`, `|`, `;`) via
 *     {@link shouldSoftSplit}: lead on the header row, one `↳ <op> …` row per
 *     segment.
 *  3. **Plain overflow** with neither of the above: flow the line at
 *     whitespace with trailing `\` markers, bash's own line-continuation
 *     convention, instead of slicing mid-token.
 *  4. **Everything else**: the existing `\n` path, where the header holds the
 *     first line and the tail lines become `> ` PS2 rows.
 *
 * `cols` non-finite means "width unknown" (non-TTY, piped output, most unit
 * tests) and keeps strategies 1–3 inert, so those callers see a stable
 * single-line header.
 */
function planBashInput(command: string, cols?: number): BashInputPlan {
  const nlIdx = command.indexOf("\n")
  const firstLine = nlIdx === -1 ? command : command.slice(0, nlIdx)
  const tailLines = nlIdx === -1 ? [] : command.slice(nlIdx + 1).split("\n")
  const effectiveCols = cols ?? process.stdout.columns ?? Number.POSITIVE_INFINITY
  const known = Number.isFinite(effectiveCols)

  // Budgets. With a real width, the header body must fit the row (`cols` minus
  // the `  ╭ » Bash  $ ` chrome), so the outer `clampTranscriptRow` becomes a
  // safety net instead of the primary cutter. With no width signal we keep the
  // historical 500-char budget so non-TTY callers stay deterministic.
  const budget = known
    ? Math.max(BASH_MIN_BODY_CELLS, Math.floor(effectiveCols) - BASH_ROW_CHROME_CELLS)
    : HEADER_BASH_MAX
  const rowBudget = known
    ? Math.max(BASH_MIN_BODY_CELLS, Math.floor(effectiveCols) - BASH_ROW_CHROME_CELLS - 2)
    : HEADER_BASH_MAX

  /** Shorten a single-line fragment for the header: middle-elide, else trim. */
  const header = (s: string): string => elideMiddle(s, budget) ?? fit(s, budget)
  /** Shorten a continuation fragment for its row. */
  const row = (s: string): string => fit(s, rowBudget)
  const tail = (): string[] => tailLines.map((l) => `> ${row(l)}`)

  // Strategy 1 — inline script payload.
  const script = known ? detectInlineScript(firstLine) : null
  if (script !== null) {
    const overflows = displayWidth(firstLine) + BASH_HEADER_PREFIX_CELLS_DEFAULT > effectiveCols
    const structured = script.statements.length >= MIN_STRUCTURED_SCRIPT_STATEMENTS
    if (overflows || structured) {
      const rows = scriptRows(script).map(row)
      return {
        body: header(script.prologue),
        rows: capRows(rows, tail(), BASH_CONT_MAX_LINES_SCRIPT),
      }
    }
  }

  // Strategy 2 — top-level shell operators.
  const { lead, rest } = splitBashSegments(firstLine)
  if (shouldSoftSplit(firstLine, effectiveCols) && rest.length > 0) {
    const rows = rest.map(({ op, body: seg }) => `↳ ${row(`${op} ${seg}`)}`)
    return { body: header(lead || firstLine), rows: capRows(rows, tail()) }
  }

  // Strategy 3 — no decomposition available: shorten honestly (middle-elide
  // keeps the trailing arguments visible), never slice mid-token.
  // Strategy 4 — same treatment for the first line of a multi-line command.
  return { body: header(firstLine), rows: capRows([], tail()) }
}

/**
 * Statements from which an inline script is worth unwrapping even when the
 * one-liner fits the terminal. Mirrors `MULTI_OP_SOFT_SPLIT_MIN`'s reasoning:
 * at three or more parts, a structured shape reads better row-by-row than an
 * inline run-on, regardless of available width.
 */
const MIN_STRUCTURED_SCRIPT_STATEMENTS = 3

/**
 * `> ` rows for an inline script: one per depth-0 statement, with the closing
 * quote (and any shell tail, e.g. `' | head -20`) attached to the last row so
 * the block still reconstructs the original command visually.
 */
function scriptRows(script: InlineScript): string[] {
  return script.statements.map((stmt, i) =>
    i === script.statements.length - 1 ? `> ${stmt}${script.epilogue}` : `> ${stmt}`,
  )
}

/**
 * Concatenate the leading rows with the trailing `\n` rows and clip the total
 * to `max`, replacing the overflow with one elision row that carries the count.
 *
 * The elision row reuses the sigil of the last visible row so the eye stays
 * oriented, and reports lines (not characters) because a clipped row budget is
 * a line-count story.
 */
function capRows(lead: string[], tail: string[], max = BASH_CONT_MAX_LINES): string[] {
  const combined = [...lead, ...tail]
  if (combined.length <= max) return combined
  const visible = combined.slice(0, max)
  const elided = combined.length - visible.length
  const sigil = visible[visible.length - 1]?.startsWith("↳ ") ? "↳" : ">"
  visible.push(`${sigil} ${truncHint(elided, "L")} more`)
  return visible
}

/**
 * Where a header path is shown from. A path inside `cwd` becomes relative,
 * a path inside `home` becomes `~/...`. Defaults: `process.cwd()` and
 * `os.homedir()`.
 */
export interface ToolHeaderPathContext {
  cwd?: string
  home?: string
}

/** Cells of the `  ╭ ` frame before the icon. */
const HEADER_FRAME_CELLS = 4
/** Cells of the two-space gap after the label in a default header. */
const HEADER_LABEL_GAP_CELLS = 2
/** Narrowest path-header body we size for. Below it the row clamp wins. */
const HEADER_MIN_BODY_CELLS = 12
/** Cells a shortened Grep pattern keeps before the path gives way. */
const GREP_PATTERN_MIN_CELLS = 24
/** Separator between header chunks, same as the truncation footer. */
const HEADER_SEP = " · "
/** Single-cell ellipsis for compacted header parts. */
const HEADER_ELLIPSIS = "\u2026"
/** Tools whose default header body is sized to the row. */
const PATH_HEADER_TOOLS: ReadonlySet<string> = new Set(["Read", "Write", "Edit", "Glob", "Grep"])

/** Fill in the `cwd` and `home` defaults. */
function resolvePathContext(ctx?: ToolHeaderPathContext): Required<ToolHeaderPathContext> {
  return { cwd: ctx?.cwd ?? process.cwd(), home: ctx?.home ?? homedir() }
}

/**
 * Cells left for a header body after `chromeCells` of frame, icon, label and
 * gap, and the 1-cell wrap safety that {@link clampTranscriptRow} keeps.
 * Unknown `cols` gives `Infinity`: no width cut, deterministic non-TTY rows.
 */
function headerBodyBudget(cols: number | undefined, chromeCells: number): number {
  if (cols === undefined || !Number.isFinite(cols) || cols <= 0) return Number.POSITIVE_INFINITY
  // The real room, never more: `formatPathCompact` handles a tiny budget.
  return Math.max(1, Math.floor(cols) - chromeCells - 1)
}

/** Relativize `path`, and compact it to `budget` cells when it is finite. */
function compactPath(path: string, ctx: Required<ToolHeaderPathContext>, budget: number): string {
  const cells = Number.isFinite(budget) ? Math.max(1, budget) : undefined
  return formatPathCompact(path, { cwd: ctx.cwd, home: ctx.home, budget: cells })
}

/** Cut the middle of `s` to `budget` cells with one `…`. */
function elideMiddleCells(s: string, budget: number): string {
  if (displayWidth(s) <= budget) return s
  if (budget <= 1) return HEADER_ELLIPSIS
  const avail = budget - 1
  const head = truncateDisplayWidth(s, Math.ceil((avail * 2) / 3), "")
  const chars = Array.from(s)
  let tailWidth = avail - displayWidth(head)
  let start = chars.length
  while (start > 0 && displayWidth(chars[start - 1]) <= tailWidth) {
    tailWidth -= displayWidth(chars[start - 1])
    start -= 1
  }
  return `${head}${HEADER_ELLIPSIS}${chars.slice(start).join("")}`
}

/**
 * Split a regex at its top-level `|` only. A `|` after a backslash, inside a
 * `[...]` class, or inside a `(...)` group does not split.
 */
function splitTopLevelAlternatives(pattern: string): string[] {
  const chars = Array.from(pattern)
  const alts: string[] = []
  let current = ""
  let depth = 0
  let classStart = -1
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]
    if (ch === "\\") {
      current += ch + (chars[i + 1] ?? "")
      i += 1
      continue
    }
    if (classStart >= 0) {
      // A `]` first in the class (after `[` or `[^`) is a literal.
      const first = i === classStart + 1 || (i === classStart + 2 && chars[classStart + 1] === "^")
      if (ch === "]" && !first) classStart = -1
    } else if (ch === "[") {
      classStart = i
    } else if (ch === "(") {
      depth += 1
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1)
    } else if (ch === "|" && depth === 0) {
      alts.push(current)
      current = ""
      continue
    }
    current += ch
  }
  alts.push(current)
  return alts
}

/**
 * Shorten a Grep pattern to `budget` cells. With top-level `|` alternatives,
 * keep the leading whole alternatives and append `|…`. Else cut the middle.
 */
function shortenGrepPattern(pattern: string, budget: number): string {
  if (displayWidth(pattern) <= budget) return pattern
  const alts = splitTopLevelAlternatives(pattern)
  if (alts.length > 1) {
    let kept = ""
    for (const alt of alts) {
      const next = kept === "" ? alt : `${kept}|${alt}`
      if (displayWidth(`${next}|${HEADER_ELLIPSIS}`) > budget) break
      kept = next
    }
    if (kept !== "") return `${kept}|${HEADER_ELLIPSIS}`
  }
  return elideMiddleCells(pattern, budget)
}

/**
 * Fit a Grep header to `budget` cells. Steps, in order: drop the lowest
 * modifiers (a `+N` chunk counts them), shrink the `in <path>` part, then
 * shorten the pattern. The `/` delimiters and the flags always stay.
 */
function fitGrepHeader(opts: {
  pattern: string
  flags: string
  path: string | undefined
  modifiers: string[]
  ctx: Required<ToolHeaderPathContext>
  budget: number
}): string {
  const { pattern, flags, ctx, budget } = opts
  const atom = (p: string): string => `/${p}/${flags}`
  const fullPath = opts.path === undefined ? undefined : compactPath(opts.path, ctx, Infinity)
  const join = (p: string, path: string | undefined, mods: string[], dropped: number): string => {
    const parts = [atom(p)]
    if (path !== undefined) parts.push(`in ${path}`)
    parts.push(...mods)
    if (dropped > 0) parts.push(`+${dropped}`)
    return parts.join(HEADER_SEP)
  }
  let mods = opts.modifiers
  let dropped = 0
  let line = join(pattern, fullPath, mods, dropped)
  if (!Number.isFinite(budget) || displayWidth(line) <= budget) return line

  // 1. Drop modifiers, lowest priority (the tail) first.
  while (mods.length > 0 && displayWidth(line) > budget) {
    mods = mods.slice(0, -1)
    dropped += 1
    line = join(pattern, fullPath, mods, dropped)
  }
  if (displayWidth(line) <= budget) return line

  // 2. Shrink the path into the cells the pattern leaves, down to a floor.
  let path = fullPath
  if (opts.path !== undefined && fullPath !== undefined) {
    const others = displayWidth(join(pattern, "", mods, dropped))
    const floor = Math.min(displayWidth(fullPath), HEADER_MIN_BODY_CELLS)
    path = compactPath(opts.path, ctx, Math.max(floor, budget - others))
    line = join(pattern, path, mods, dropped)
  }
  if (displayWidth(line) <= budget) return line

  // 3. Shorten the pattern into what the floor path leaves, but keep a fair
  //    share for it. The pattern is sized as if every modifier came back, so
  //    it does not take the cells that step 4 gives back to the modifiers.
  const atomCells = displayWidth(atom(""))
  const rest = displayWidth(join("", path, opts.modifiers, 0)) - atomCells
  const patBudget = Math.max(
    Math.min(displayWidth(pattern), GREP_PATTERN_MIN_CELLS, budget - atomCells),
    budget - rest - atomCells,
  )
  const shortPattern = shortenGrepPattern(pattern, patBudget)
  // 4. Give back the highest dropped modifiers that now fit beside the floor
  //    path, then give the path the cells that are left.
  while (dropped > 0) {
    const next = opts.modifiers.slice(0, mods.length + 1)
    if (displayWidth(join(shortPattern, path, next, dropped - 1)) > budget) break
    mods = next
    dropped -= 1
  }
  if (opts.path !== undefined) {
    const others = displayWidth(join(shortPattern, "", mods, dropped))
    path = compactPath(opts.path, ctx, Math.max(1, budget - others))
  }
  line = join(shortPattern, path, mods, dropped)
  if (displayWidth(line) <= budget) return line
  return fitGrepHeaderFinal(opts, shortPattern, fullPath)
}

/**
 * Last Grep fit step, so the row clamp never cuts the closing `/flags`. Drop
 * every modifier (a `+N` chunk stays when it fits), then the `in <path>`
 * part, then shrink the pattern to exactly the cells left.
 */
function fitGrepHeaderFinal(
  opts: Parameters<typeof fitGrepHeader>[0],
  shortPattern: string,
  fullPath: string | undefined,
): string {
  const { pattern, flags, ctx, budget } = opts
  const total = opts.modifiers.length
  const join = (p: string, path: string | undefined, count: number): string =>
    [`/${p}/${flags}`, path === undefined ? "" : `in ${path}`, count > 0 ? `+${count}` : ""]
      .filter((s) => s !== "")
      .join(HEADER_SEP)
  // Keep a compacted path beside the shortened pattern while it has a fair floor.
  for (const count of opts.path !== undefined && fullPath !== undefined ? [total, 0] : []) {
    const room = budget - displayWidth(join(shortPattern, "", count))
    if (room < Math.min(displayWidth(fullPath ?? ""), HEADER_MIN_BODY_CELLS)) continue
    const line = join(shortPattern, compactPath(opts.path ?? "", ctx, room), count)
    if (displayWidth(line) <= budget) return line
  }
  const atomCells = displayWidth(join("", undefined, 0))
  const countCells = total > 0 ? displayWidth(`${HEADER_SEP}+${total}`) : 0
  // The `+N` chunk stays only while the pattern keeps 4 cells beside it.
  const keepCount = total > 0 && budget - atomCells - countCells >= 4
  const room = budget - atomCells - (keepCount ? countCells : 0)
  const p = room >= 1 ? shortenGrepPattern(pattern, room) : ""
  return join(p, undefined, keepCount ? total : 0)
}

/**
 * Format a `tool_use` block's input for the bordered tool header. Picks
 * the most informative field per tool (command for Bash, file_path for
 * file tools, pattern for search tools). Falls back to JSON-stringified
 * input for unknown tools.
 *
 * Returns ONLY the header line (single-line, no embedded newlines).
 * Multi-line Bash commands render their continuation via the sibling
 * {@link formatToolInputContinuation} : the caller writes those after the
 * header as `│ ...` rows inside the same bordered block.
 *
 * # Style: programmer-native + dot-separated chunks
 *
 * Beyond the primary field (path/pattern/command), each tool can carry
 * "subordinate" inputs : `offset`/`limit` for Read, `replace_all` for
 * Edit, `path`/`glob`/`-i`/`-A`/etc. for Grep. Surfacing them in the
 * header is what lets the user see *what was actually run* (e.g.
 * "Read first 4 lines" vs. "Read whole file" : same tool name, very
 * different operation).
 *
 * The vocabulary is "Style A" : programmer-native shorthand:
 *
 *  - **Read**: `<path> · L<start>-<end>` (closed range, 1-indexed to match
 *    the body's line-number gutter), or `· from L<start>` (open-ended,
 *    `offset` only). Bare reads (neither set) render byte-identical to
 *    the pre-extras form.
 *  - **Edit**: `<path> · g` for `replace_all` (sed `s/.../.../g` flavor).
 *  - **Glob**: `<pattern> · in <path>` when `path` (or alias `target_directory`)
 *    is set. `glob_pattern` is accepted as an alias for `pattern`.
 *  - **Grep**: regex flags appended to the pattern (`/foo/i` for `-i`,
 *    `/foo/m` for `multiline`, `/foo/im` for both). Modifiers chain after
 *    ` · `: `in <path>` (where), `<glob>` (filter), `↓N`/`↑N`/`↕N` (after/
 *    before/around context : `-C` takes precedence over `-A`/`-B` since
 *    it's symmetric), `≤N` (`head_limit`), `count`/`paths` (output mode).
 *
 * The ` · ` mid-dot is the same separator used in the truncation footer
 * (`shown 15/1831 L · 8.0 KB/1.5 MB · cut at L1000`), keeping a single
 * visual language across the tool block.
 *
 * Truncation strategy:
 *  - **Bash**: first line only (multi-line continuation rendered separately
 *    by {@link formatToolInputContinuation}); word-boundary trim at 500 chars.
 *  - **Read/Write/Edit/Glob/Grep**: file_path / pattern only : typically
 *    well under 200 chars; no truncation in the common case. Composed
 *    Grep headers (all flags set) come in under ~80 cells in practice;
 *    if real usage ever overflows, prioritize pattern → path → context.
 *  - **Unknown**: JSON.stringify, hard slice at 200 chars (unknown tools
 *    have unknown shape, so word boundaries aren't meaningful).
 */
export function formatToolInput(
  tool: ToolUseBlock,
  cols?: number,
  headerKey?: string,
  pathContext?: ToolHeaderPathContext,
): string {
  const chrome = HEADER_FRAME_CELLS + displayWidth(DEFAULT_TOOL_ICON) + 1 + displayWidth(tool.name)
  return formatToolInputBody(tool, cols, headerKey, pathContext, chrome + HEADER_LABEL_GAP_CELLS)
}

/**
 * The body of {@link formatToolInput}. `chromeCells` is the row width spent
 * before the body (frame, icon, label, gap), so path-bearing headers can
 * size their body to the row.
 */
function formatToolInputBody(
  tool: ToolUseBlock,
  cols: number | undefined,
  headerKey: string | undefined,
  pathContext: ToolHeaderPathContext | undefined,
  chromeCells: number,
): string {
  const input = tool.input
  const budget = headerBodyBudget(cols, chromeCells)
  const ctx = resolvePathContext(pathContext)
  // Declarative header field (plugin tools): when the manifest names a
  // `headerKey` AND the input carries a non-empty string there, surface
  // exactly that value instead of the raw `{"k":"v"}` JSON fallback. This
  // is what lets a plugin tool paint a clean identifying header (the URL
  // for Fetch) synchronously, the instant the call starts — before the
  // handler has produced its richer `displayHeader`. Checked first so it
  // wins over the generic per-tool branches below for plugin tools (which
  // never match the built-in names anyway), but the guard keeps it inert
  // for built-ins and for malformed/absent fields.
  if (headerKey) {
    const v = input[headerKey]
    if (typeof v === "string" && v.length > 0) return v
  }
  if (tool.name === "Bash" && input.command) {
    // Decomposition is decided once, by `planBashInput`, and shared with
    // `formatToolInputContinuation` : header and continuation rows must never
    // disagree about how a command was broken up. See `planBashInput` for the
    // strategy ladder (inline script → shell operators → whitespace flow →
    // plain `\n` path) and for the `cols`-unknown rule.
    const plan = planBashInput(String(input.command), cols)
    // Header line only : continuation rendered by formatToolInputContinuation.
    return `$ ${plan.body}`
  }
  if (tool.name === "Read" && input.file_path) {
    const path = String(input.file_path)
    // `offset` is zero-based in the schema; `execRead` prints body lines
    // 1-indexed (`${start + i + 1}\t…`), so we surface the same 1-indexed
    // range here and the header promise matches what the body shows.
    // Bare reads (no offset/limit) render byte-identical to the
    // pre-extras form : the common case is undisturbed.
    const off = typeof input.offset === "number" ? input.offset : undefined
    const lim = typeof input.limit === "number" ? input.limit : undefined
    let suffix = ""
    if (off !== undefined || lim !== undefined) {
      const startL = (off ?? 0) + 1
      suffix = lim !== undefined ? ` · L${startL}-${startL + lim - 1}` : ` · from L${startL}`
    }
    // The suffix is reserved first: the range is the promise the body keeps.
    return `${compactPath(path, ctx, budget - displayWidth(suffix))}${suffix}`
  }
  if (tool.name === "Write" && input.file_path) {
    return compactPath(String(input.file_path), ctx, budget)
  }
  if (tool.name === "Edit" && input.file_path) {
    const path = String(input.file_path)
    // `g` flag : borrowed from sed's `s/old/new/g`. Cheap, recognizable,
    // attaches the modifier visually to the path it modifies.
    const suffix = input.replace_all ? " · g" : ""
    return `${compactPath(path, ctx, budget - displayWidth(suffix))}${suffix}`
  }
  if (tool.name === "Glob") {
    const pat = globPatternFromInput(input)
    if (pat.status === "ok") {
      const dir = globPathFromInput(input)
      if (dir.status !== "ok") return pat.value
      // The pattern stays whole: the dir shrinks into the cells left over.
      const head = `${pat.value} · in `
      return `${head}${compactPath(dir.value, ctx, budget - displayWidth(head))}`
    }
  }
  if (tool.name === "Grep" && input.pattern) {
    // Pattern carries its own JS-regex flags: `i` for -i, `m` for
    // multiline. Then ` · ` between major chunks: where (path, then
    // optional glob filter), context (↑↓↕N), head limit (≤N), output
    // mode. `-n` (line numbers) is intentionally not surfaced : it's the
    // default and would just clutter.
    const flags = `${input["-i"] ? "i" : ""}${input.multiline ? "m" : ""}`
    // Modifiers in priority order, highest first: the glob, then context,
    // then head limit, then output mode. Over budget, the tail drops first.
    const modifiers: string[] = []
    if (input.glob) modifiers.push(String(input.glob))
    // Context arrows. `-C N` (or its `context` alias) takes precedence :
    // it's symmetric so `↕` reads more naturally than two arrows. When
    // only `-A`/`-B` are set, render whichever (or both) are present.
    const ctxC = (input["-C"] as number | undefined) ?? (input.context as number | undefined)
    if (typeof ctxC === "number") {
      modifiers.push(`↕${ctxC}`)
    } else {
      if (typeof input["-A"] === "number") modifiers.push(`↓${input["-A"]}`)
      if (typeof input["-B"] === "number") modifiers.push(`↑${input["-B"]}`)
    }
    if (typeof input.head_limit === "number") modifiers.push(`≤${input.head_limit}`)
    if (input.output_mode === "count") modifiers.push("count")
    else if (input.output_mode === "files_with_matches") modifiers.push("paths")
    return fitGrepHeader({
      pattern: String(input.pattern),
      flags,
      path: input.path ? String(input.path) : undefined,
      modifiers,
      ctx,
      budget,
    })
  }
  // Option A: compact key:value pairs joined by " · ". Replaces the old
  // JSON.stringify fallback that dumped raw JSON into the header (e.g.
  // `{"action":"meta","sid":"019ec3a9"}`) for any tool without a dedicated
  // input branch.
  //
  // Renders as:
  //   action:meta · sid:019ec3a9
  //   action:search · query:"provider login auth…" · limit:20
  //   pattern:"/foo/" · path:src · i
  //
  // Booleans where true → bare key as a flag (e.g. "i" for `-i: true`).
  // Booleans where false → skipped.
  // Short alphanumeric strings → key:value (no quotes).
  // Strings with spaces/special chars → key:"quoted".
  // Long strings → key:"prefix…" (truncated at 60 chars).
  // Objects/arrays → key:{…} / key:[N].
  const parts: string[] = []
  for (const [key, val] of Object.entries(input)) {
    if (val === null || val === undefined) continue
    if (typeof val === "boolean") {
      if (val) parts.push(key)
      continue
    }
    if (typeof val === "number") {
      parts.push(`${key}:${val}`)
      continue
    }
    if (typeof val === "string") {
      const MAX_VAL_CHARS = 60
      const truncated = val.length > MAX_VAL_CHARS ? val.slice(0, MAX_VAL_CHARS) + "…" : val
      const needsQuotes = /[^a-zA-Z0-9_.\-/]/.test(truncated)
      if (needsQuotes) {
        parts.push(`${key}:${JSON.stringify(truncated)}`)
      } else {
        parts.push(`${key}:${truncated}`)
      }
      continue
    }
    // Arrays: `key:[N]` where N is length
    if (Array.isArray(val)) {
      parts.push(`${key}:[${val.length}]`)
      continue
    }
    // Other objects: `key:{…}`
    if (typeof val === "object") {
      parts.push(`${key}:{…}`)
      continue
    }
  }
  const formatted = parts.join(" · ")
  const charsCut = formatted.length > HEADER_JSON_MAX ? formatted.length - HEADER_JSON_MAX : 0
  return charsCut > 0
    ? `${formatted.slice(0, HEADER_JSON_MAX)}${truncHint(charsCut, "ch")}`
    : formatted
}

/**
 * Continuation rows for a multi-line tool input : rendered as `│ ...` rows
 * between the header and the output. Currently emits rows only for
 * multi-line **Bash** commands; other tools have single-line headers.
 *
 * Each returned line carries a leading `> ` (mirroring bash's secondary
 * prompt) so it's visually distinguishable from output rows (which have
 * no prefix). Heredoc-shaped commands like:
 *
 * ```
 *   $ cat > /tmp/x.txt << "EOF"
 *   foo
 *   bar
 *   EOF
 * ```
 *
 * render as:
 *
 * ```
 *   ╭ » Bash  $ cat > /tmp/x.txt << "EOF"
 *   │ > foo
 *   │ > bar
 *   │ > EOF
 *   ╰ (no output)
 * ```
 *
 * Capped at {@link BASH_CONT_MAX_LINES} (default 16). Beyond the cap, a
 * synthetic last row reads `> ... +NL more` so the user knows the rest
 * was elided. Per-line word-boundary trim mirrors `formatToolInput`'s
 * 500-char Bash budget.
 */
export function formatToolInputContinuation(tool: ToolUseBlock, cols?: number): string[] {
  const input = tool.input
  if (tool.name !== "Bash" || !input.command) return []
  return planBashInput(String(input.command), cols).rows
}

/**
 * Cell count of the indent that continuation rows need *after* their
 * `  │ ` frame so the `↳`/`>` sigil aligns directly under the start of
 * the command body in the header row.
 *
 * Header layout (live agent):
 *
 * ```
 *   ╭ » Bash  $ cd /Users/...
 *               ^ command body starts here (col 14)
 * ```
 *
 * Continuation layout (what this indent achieves):
 *
 * ```
 *   │           ↳ && git push ...
 *               ^ ↳ aligned with `c` of `cd` (col 14)
 * ```
 *
 * The math walks the visible cells in the header BEFORE the command
 * body: icon (if any) + trailing space + label + 2-space gap + `$ `
 * sigil. Stripped ANSI is implicit because callers pass the bare text
 * (`tool.name`, manifest `icon`) not the colored render.
 *
 * Returns `0` for non-Bash tools (no continuation rows exist there
 * today). For Bash:
 *  - with `»` icon → 10 cells of padding
 *  - without icon (session-replay header) → 8 cells of padding
 *
 * `formatToolHeaderRows` consumes this for both live execution and
 * session replay. Keeping the arithmetic behind that shared helper makes
 * both paths stay in sync if header shape changes later.
 */
export function toolContinuationIndentCells(toolName: string, iconText?: string): number {
  if (toolName !== "Bash") return 0
  const iconCells = iconText ? displayWidth(iconText) + 1 : 0
  const labelCells = displayWidth(toolName)
  const gapCells = 2
  const cmdSigilCells = 2 // "$ " from formatToolInput
  return iconCells + labelCells + gapCells + cmdSigilCells
}

/**
 * Render the rows that open a tool transcript block:
 *
 *   ╭ [icon] [Tool]  [input/header override] [· time]
 *   │ [continuation rows, when the default header owns Bash wrapping]
 *   │
 *
 * Live execution and session replay both use this helper so frame chrome,
 * width adjustment for the time suffix, continuation indentation, and
 * presentation color fallback stay byte-identical.
 */
export function formatToolHeaderRows(opts: {
  tool: ToolUseBlock
  presentation?: ToolPresentation | null
  headerOverride?: string
  timeText?: string
  cols?: number
  /** Where header paths are shown from. Defaults: `process.cwd()`, `os.homedir()`. */
  pathContext?: ToolHeaderPathContext
}): string[] {
  const { tool, presentation, headerOverride, timeText, cols, pathContext } = opts
  const labelColor =
    presentation?.color && (c as Record<string, (s: string) => string>)[presentation.color]
      ? (c as Record<string, (s: string) => string>)[presentation.color]
      : c.orange
  const iconText = toolIcon(presentation)
  const icon = `${c.bold(labelColor(iconText))} `
  const label = c.bold(labelColor(tool.name))
  const TIME_HINT_GUTTER = 2
  const chromeCells =
    HEADER_FRAME_CELLS +
    displayWidth(iconText) +
    1 +
    displayWidth(tool.name) +
    HEADER_LABEL_GAP_CELLS
  // On a narrow row the default header body wins over the time hint: drop
  // the hint when it would leave the body less than the minimum room.
  const timeFits =
    timeText === undefined ||
    headerOverride !== undefined ||
    cols === undefined ||
    !PATH_HEADER_TOOLS.has(tool.name) ||
    cols - displayWidth(` · ${timeText}`) - TIME_HINT_GUTTER - chromeCells - 1 >=
      HEADER_MIN_BODY_CELLS
  const timeSuffix = timeText !== undefined && timeFits ? ` · ${timeText}` : ""
  const adjustedCols =
    cols !== undefined && timeSuffix.length > 0
      ? Math.max(20, cols - displayWidth(timeSuffix) - TIME_HINT_GUTTER)
      : cols
  const dimTimeSuffix = timeSuffix.length > 0 ? c.dim(timeSuffix) : ""
  const content =
    headerOverride !== undefined
      ? headerOverride
      : c.dim(
          formatToolInputBody(
            tool,
            adjustedCols,
            presentation?.headerKey,
            pathContext,
            chromeCells,
          ),
        )
  // Default input summaries keep the historical two-space gap after the label
  // (`Bash  $ cmd`). Plugin-owned `displayHeader` overrides use a single space so
  // chrome like `IntercomSend → Sergio (id)` does not read as a double gap.
  const labelGap = headerOverride !== undefined ? " " : "  "
  const headerLine =
    content.length === 0
      ? `${icon}${label}${dimTimeSuffix}`
      : `${icon}${label}${labelGap}${content}${dimTimeSuffix}`

  const rows = [clampTranscriptRow(`  ${c.dimCyan("╭")} ${headerLine}`, cols)]
  if (headerOverride === undefined) {
    const indent = " ".repeat(toolContinuationIndentCells(tool.name, iconText))
    for (const cont of formatToolInputContinuation(tool, adjustedCols)) {
      rows.push(clampTranscriptRow(`  ${c.dimCyan("│")} ${indent}${c.dim(cont)}`, cols))
    }
  }
  rows.push(`  ${c.dimCyan("│")}`)
  return rows
}

/**
 * Per-tool body line budget for the bordered transcript preview. Tuned by
 * shape of typical output:
 *  - **Bash**: 10 lines : output is variable; 10 covers "exit code + last
 *    few lines" without dominating the screen.
 *  - **Read**: 15 lines : content is dense (line-numbered) and structural;
 *    a few extra lines is high-value.
 *  - **Grep**: 12 lines : content mode; for files-only / count modes
 *    we'd want more, but those are explicit user choices and rarely hit
 *    the cap.
 *  - **Glob**: 25 lines : paths are short, dense, easy to scan.
 *  - **Default**: 10 lines : sensible mid-range for unknown tools.
 *
 * These are TUI display caps, not API caps. The model still sees up to
 * the universal {@link MAX_TOOL_OUTPUT_LINES} (1000 lines) per
 * `tool_result.content`. See `src/tools/truncation.ts` for the API cap.
 */
export const TOOL_PREVIEW_LINES: Record<string, number> = {
  Bash: 10,
  Read: 15,
  Grep: 12,
  Glob: 25,
  Edit: 1000, // diff display channel; effectively unbounded
  Write: 1000,
}
export const TOOL_PREVIEW_LINES_DEFAULT = 10

/**
 * Four flavors of model-only annotation can ride at the end of
 * `tool_result.content`:
 *
 *  - `\n\n[truncated: ...]`              : universal API-cap notice
 *    (see `tools/truncation.ts`).
 *  - `\n\n[note: ...]`                   : streak tracker note
 *    (see `tools/feedback-tracker.ts`).
 *  - `\n\n<ma::agent::output-preview …>…</ma::agent::output-preview>` : TUI elision hint
 *    (this file).
 *  - `\n\n<ma::agent::mode-active id="…" since="…" />`    : active-mode stamp
 *    (this file). Always last : it's the freshest signal the model
 *    should re-read at the very tail of each tool_result.
 *
 * Order at end of content is fixed (above). `findAnnotationStart`
 * returns the index of the EARLIEST true annotation (= start of the
 * annotation region) so callers can slice the body cleanly. Using
 * per-pattern `lastIndexOf` (not a single regex with `.match()`)
 * hardens against the case where the body itself legitimately
 * contains the prefix (e.g. a `Read` of a log that happens to
 * include the string `[truncated:`) : the last occurrence is the
 * real annotation, body-internal occurrences are earlier.
 *
 * Convention note: `[truncated:]` and `[note:]` are legacy
 * bracket-string shapes. New annotations use the `<ma::…>` XML-like
 * namespace (TODOS.md#T-ca2ce1). When the legacy ones are eventually
 * retrofitted (cross-version replay-breaking change), this collapses
 * to a single `<ma::…>` test.
 */
const ANNOTATION_PREFIXES = [
  "\n\n[truncated:",
  "\n\n[note:",
  "\n\n<ma::agent::output-preview",
  "\n\n<ma::agent::diagnostics",
  "\n\n<ma::agent::mode-active",
] as const

function findAnnotationStart(content: string): number {
  let earliest = -1
  for (const p of ANNOTATION_PREFIXES) {
    const i = content.lastIndexOf(p)
    if (i >= 0 && (earliest < 0 || i < earliest)) earliest = i
  }
  return earliest
}

/**
 * Compute the TUI vs body line gap for the `<ma::agent::output-preview>` annotation.
 * Returns `null` when the body fits in the per-tool budget or there's no
 * body at all.
 *
 * Strips any trailing annotation from `content` before counting lines, so
 * re-application of the note is idempotent (a peer agent's prior note in
 * historical content doesn't double up). The line count is taken AFTER
 * stripping, so the note reads "user saw N of M lines of *what you saw*"
 * : accurate even when the API ALSO truncated (in which case `[truncated:]`
 * carries the separate source→model ratio).
 */
export function computeTuiElision(
  content: string,
  tool: string,
): { shown: number; total: number } | null {
  const idx = findAnnotationStart(content)
  const body = idx >= 0 ? content.slice(0, idx) : content
  if (!body) return null
  // Allocation-free line count (see countLines). This runs on the model's
  // full tool_result content; counting by scanning avoids materializing a
  // per-line array we'd immediately discard (Bug 4).
  const total = countLines(body)
  const budget = TOOL_PREVIEW_LINES[tool] ?? TOOL_PREVIEW_LINES_DEFAULT
  if (total <= budget) return null
  return { shown: budget, total }
}

/**
 * Hard per-line cap for body lines. Protects against pathological cases
 * (e.g. a 10_000-char minified JSON line in a `Read` result) on terminals
 * wider than this value : without the cap, one mega-line would still
 * dominate the preview even when it physically fits. 300 cells is
 * generous enough to read most code and structured output.
 *
 * The terminal width takes precedence when narrower : see
 * {@link effectiveBodyLineWidth}. Lines are truncated **at render time**
 * with the current `process.stdout.columns` (or the snapshot the caller
 * passed via `opts.cols`), so a body line never overflows the visible
 * column count and the terminal never has to wrap it. Scrollback is
 * permanent : a later resize does not re-render older blocks, but every
 * new tool block paints correctly under the new width.
 */
/**
 * Hard per-line display-width cap for tool transcript body rows (cells).
 * Intentionally tight: a single mega-line must never paint as a wall of
 * soft-wrapped scrollback. Terminal width still wins when narrower
 * (`effectiveBodyLineWidth` = min(term-gutter-safety, this)).
 */
export const TOOL_PREVIEW_LINE_WIDTH = 200
export const TOOL_PREVIEW_GUTTER_WIDTH = 4
const TOOL_PREVIEW_WRAP_SAFETY_WIDTH = 1

/**
 * Compute the safe body width for a tool transcript line as
 * `terminal_cols - gutter - wrap_safety`. Returns `undefined` when the
 * caller has no width signal (non-TTY contexts like unit tests where
 * `process.stdout.columns` is also unset). That sentinel lets the
 * display-channel branch (Edit/Write diffs) opt out of clamping when
 * width is unknown : tests get deterministic full-width output, and
 * production gets a real number.
 *
 * The `gutter` accounts for the `"  │ "` (or `"  ╰ "`) prefix every row
 * carries (4 cells); the 1-cell `WRAP_SAFETY` keeps a column free at the
 * right edge so a single off-by-one in a wide-glyph terminal can't tip
 * the line into a wrap.
 */
function toolPreviewBodyWidth(cols?: number): number | undefined {
  const raw = cols ?? process.stdout.columns
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined
  const max = Math.floor(raw) - TOOL_PREVIEW_GUTTER_WIDTH - TOOL_PREVIEW_WRAP_SAFETY_WIDTH
  return max > 0 ? max : 0
}

/**
 * Body-line render width for the main preview path : the effective
 * `min(terminal_cols - gutter - safety, TOOL_PREVIEW_LINE_WIDTH)`.
 *
 * Always returns a positive integer. When the terminal width signal is
 * missing OR pathologically small (≤ gutter), falls back to the fixed
 * hard cap so the behavior in unit tests (no TTY, no `cols` argument)
 * stays deterministic at {@link TOOL_PREVIEW_LINE_WIDTH} cells. In
 * production with a real TTY the terminal-derived width almost always
 * wins (e.g. an 127-col terminal gives 127 − 4 − 1 = 122, well below
 * the 200-cell hard cap).
 *
 * Mirrors the semantic of `toolPreviewBodyWidth` but collapses the
 * "no width" sentinel to the hard cap so callers don't need a separate
 * fallback branch.
 */
export function effectiveBodyLineWidth(cols?: number): number {
  const termBased = toolPreviewBodyWidth(cols)
  if (termBased === undefined || termBased <= 0) return TOOL_PREVIEW_LINE_WIDTH
  return Math.min(termBased, TOOL_PREVIEW_LINE_WIDTH)
}

function clampToolPreviewBodyLine(line: string, maxWidth: number | undefined): string {
  if (maxWidth === undefined || displayWidth(line) <= maxWidth) return line
  // Delegate to the shared `clampBodyWithHint` so the display branch
  // (Edit/Write diffs, tasks plugin display, etc.) gets the same
  // `...(+Nch)` truncation marker the content path has been emitting
  // since the May 2026 width-clamp work. Previously this used a bare
  // `truncateDisplayWidth(line, maxWidth, "...")` which dropped the
  // count, leaving the user unable to tell at-a-glance how much got
  // cut off the end of a long task title (or any other plugin-rendered
  // line). One canonical truncation idiom across all transcript rows.
  return clampBodyWithHint(line, maxWidth)
}

/**
 * Width budget reserved for the `truncHint("ch")` marker
 * (`...(+NNNNch)`) when a body line is clamped. The marker is appended
 * AFTER the trim, so the trim itself must leave room for it inside
 * `maxWidth` : otherwise `body = trimmed + hint` exceeds the visible
 * column count and the terminal soft-wraps the row into the gutter.
 *
 * 12 cells covers `"...(+99999ch)"` (worst realistic case for `head -c`
 * sized output) ; rare overshoots (cut \> 99_999 chars) drift one cell
 * past the cap, far below the `WRAP_SAFETY` slop on the outside of the
 * row. Picked over an iterative "compute hint width, re-trim" loop for
 * simplicity : the lost 1–2 body cells are imperceptible.
 */
const TOOL_PREVIEW_HINT_RESERVE_WIDTH = 12

/**
 * Trim a body line to `maxWidth` cells with the standard `...(+Nch)`
 * truncation marker. Reserves {@link TOOL_PREVIEW_HINT_RESERVE_WIDTH}
 * cells for the marker so the rendered total (`trimmed + hint`) never
 * exceeds `maxWidth`. Returns the line unmodified when it already fits.
 *
 * Shared by the live Bash stream renderer (`flushLineToBuffer`) and the
 * batched `formatToolPreview` body path so both paths produce identical
 * shape under identical widths.
 */
export function clampBodyWithHint(
  line: string,
  maxWidth: number,
  opts: { inheritMarkerStyle?: boolean } = {},
): string {
  if (displayWidth(line) <= maxWidth) return line
  const trimWidth = Math.max(1, maxWidth - TOOL_PREVIEW_HINT_RESERVE_WIDTH)
  const trimmed = truncateDisplayWidth(line, trimWidth, "")
  // eslint-disable-next-line typescript-eslint/no-misused-spread
  const cpCut = [...line].length - [...trimmed].length
  const hint = truncHint(cpCut, "ch")
  if (!opts.inheritMarkerStyle) return `${trimmed}${hint}`
  // truncateDisplayWidth appends a full reset when it copied any ANSI.
  // For already-composed transcript headers, put the marker BEFORE that
  // synthetic reset so it inherits the dim input/path style instead of
  // flaring bright (BUG #192851). This is opt-in because ANSI-colored
  // diff/display rows intentionally keep their truncation marker in the
  // terminal's default foreground rather than inheriting red/green.
  const reset = "\x1b[0m"
  return trimmed.endsWith(reset)
    ? `${trimmed.slice(0, -reset.length)}${hint}${reset}`
    : `${trimmed}${hint}`
}

/**
 * Outer-row clamp for a fully-composed transcript line including its
 * gutter prefix (`  ╭ …` / `  │ …` / `  ╰ …`). When `cols` is known
 * and the row's display width exceeds it, truncate to fit with the
 * standard `...(+Nch)` hint marker; otherwise pass through verbatim.
 *
 * Used by `writeToolHeader` to catch the cases the inner soft-split
 * machinery doesn't cover : Bash commands with no operators that
 * overflow, long single-path Read/Write/Edit/Glob/Grep headers,
 * generic JSON-fallback headers. The body preview path already
 * handles this in `formatToolPreview` (see `clampBodyWithHint`).
 *
 * Trade-off: when a header truly overflows, the trailing time-hint
 * suffix (` · 07:30:26`) gets eaten by the trim. That's preferable to
 * the alternative (preserve time, lose the path tail) since the path
 * tail is far more semantically valuable than the timestamp.
 */
export function clampTranscriptRow(row: string, cols?: number): string {
  if (cols === undefined || !Number.isFinite(cols) || cols <= 0) return row
  const maxWidth = Math.floor(cols) - TOOL_PREVIEW_WRAP_SAFETY_WIDTH
  if (maxWidth <= 0) return row
  return clampBodyWithHint(row, maxWidth, { inheritMarkerStyle: true })
}

/**
 * Format the body of a `tool_result` for the bordered transcript preview.
 *
 * Audience split (this matters): the **model** receives the full clamped
 * `content` including the trailing `[truncated: shown N of M bytes ...]`
 * notice with its action-verb resume hint. The **TUI** (you, looking at
 * the transcript) receives this function's output: the body preview only,
 * plus a bare-facts footer (`shown N/M L · X/Y B · cut at L`) when
 * truncation happened. No verbs, no advice : those go to the model where
 * they're actionable.
 *
 * The `info` parameter, when supplied (see `executeTool`'s `_truncInfo`),
 * is the source of truth for the footer. Without it we fall back to the
 * pre-info legacy behavior (slice at 200 chars + `...(+Nch)` hint) so
 * older callers keep working.
 *
 * Per-tool body line budgets live in {@link TOOL_PREVIEW_LINES}; per-line
 * display width is capped at {@link TOOL_PREVIEW_LINE_WIDTH}.
 */

/**
 * True when `line` is the **outer frame closer** of a tool transcript block
 * (the bottom-left `╰` glyph in the gutter). The live-area sink uses this
 * signal to add one blank row of breathing room before the next block.
 *
 * The discriminator must be specific to the **outer-gutter** position
 * (immediately after the 2 leading spaces and any ANSI prefix), NOT a
 * blanket "anywhere in the line" check : body content can legitimately
 * carry `╰` as a tree-last connector (e.g. the tasks plugin's `treeLast`
 * glyph in the subtask block), in titles, in user-supplied filenames,
 * etc. A blanket match misclassifies those rows as block-closers and
 * the sink emits an extra `\n`, producing a bare blank row with no `│`
 * gutter behind it.
 *
 * Recognized shapes (all match):
 * ```text
 *   "  ╰ 5 done · 1 doing · 2 todo"
 *   "  \x1b[36m╰\x1b[0m  0/3"
 *   "  \x1b[36;2m╰\x1b[0m"               (just the glyph, no body)
 * ```
 *
 * Non-matches (body rows that happen to contain ╰):
 * ```text
 *   "  │        ╰  ○  #abc  Add regression test"   ← tasks treeLast
 *   "  │ note: file named ╰.txt"                   ← body content
 * ```
 */
// Match the outer-gutter `╰`: start-of-line, optional ≤2 leading spaces
// (the gutter indent), then any number of ANSI CSI SGR sequences
// (`\x1b[<digits-and-semicolons>m`), then the `╰` glyph. Anchored at
// `^` so it cannot fire on `╰` appearing later in the body.
//
// Why CSI-only: every glyph emitted at this position goes through one of
// the `c.*` color combinators in this file, which exclusively use SGR
// (CSI `m`) sequences : we don't need to handle OSC / DCS / etc. here.
const OUTER_FRAME_CLOSE_RE = /^ {0,2}(?:\x1b\[[\d;]*m)*╰/

/**
 * Detect whether a transcript line is the outermost-gutter `╰` closer of
 * a tool block (as opposed to a body line that incidentally contains the
 * `╰` glyph — e.g. tasks subtree connectors, Bash grep output, Edit diff
 * bodies). Used by `runReplLiveArea`'s transcript sink to decide whether
 * to emit the extra trailing `\n` that visually separates one tool block
 * from the next.
 *
 * Strict anchor at `^`, ≤2 leading spaces (the outer gutter indent),
 * optional SGR CSI sequences for color, then `╰`. NOT a substring match —
 * see regression coverage in `src/agent.outer-frame-close.test.ts`.
 */
export function isOuterFrameClose(line: string): boolean {
  return OUTER_FRAME_CLOSE_RE.test(line)
}

/**
 * Turn a tool-block's trailing `╰` closer back into a `│` continuation, so an
 * appended block (the diagnostics panel) can own the final `╰` and the two
 * read as one fused frame instead of producing a double-closer.
 *
 * Only the outer-gutter `╰` is rewritten (same anchor as {@link
 * isOuterFrameClose}); a line that isn't an outer-frame close is returned
 * unchanged. The color treatment is preserved : we swap only the glyph inside
 * whatever SGR envelope the caller used.
 */
export function reopenFrameCloser(line: string): string {
  if (!isOuterFrameClose(line)) return line
  return line.replace("╰", "│")
}

/**
 * How a tool's `display` channel reflows when a body line exceeds the
 * visible width:
 *
 *  - `prose`      — collapse whitespace and word-wrap (default). For
 *                   free-flowing display text (agent summaries, schedule
 *                   prompts) where internal spacing carries no meaning.
 *  - `structured` — word-wrap while preserving the line's leading
 *                   indentation and first-fragment column spacing, with
 *                   hang-indented continuations (see {@link wrapIndented}).
 *                   For row-structured trees whose `col · col · title`
 *                   layout must survive but whose trailing title should
 *                   flow onto continuation lines instead of truncating.
 *  - `truncate`   — clip the line at the width with a `...(+Nch)` marker.
 *                   For genuinely tabular content (diff hunks, fleet
 *                   tables, lock tables) where a wrap would shear columns
 *                   apart mid-row.
 *  - `none`       — no width signal (non-TTY / tests): emit verbatim.
 */
type DisplayWrapMode = "prose" | "structured" | "truncate" | "none"

/**
 * Tools whose `display` channel is a column-aligned table where wrapping
 * a row would shear the columns apart. These keep per-line truncation.
 * `Task` is intentionally NOT here: its rows are `col · col · title` with
 * the title last, so {@link wrapIndented} can flow the title without
 * disturbing the leading columns. See {@link DisplayWrapMode}.
 */
const TABULAR_DISPLAY_TOOLS = new Set(["ListAgents", "ShowDiff", "LockStatus", "Edit", "Write"])

/**
 * Tools whose `display` is a unified diff. Their rows get a line-number
 * gutter and wrap up to {@link getDiffWrapLines} rows before a dim cut hint.
 */
const DIFF_DISPLAY_TOOLS = new Set(["Edit", "Write", "ShowDiff", "DiffViewerShowDiff", "show_diff"])

/** Diff tools that show one file. Their `@@` hunk header rows are hidden. */
const FILE_DIFF_TOOLS = new Set(["Edit", "Write"])

/** Tools whose `display` rows are structured (indent + columns + trailing title). */
const STRUCTURED_DISPLAY_TOOLS = new Set(["Task"])

/** Pick the reflow strategy for a tool's display body. */
function displayWrapMode(tool: string | undefined, bodyWidth: number | undefined): DisplayWrapMode {
  if (bodyWidth === undefined) return "none"
  const name = tool ?? ""
  if (TABULAR_DISPLAY_TOOLS.has(name)) return "truncate"
  if (STRUCTURED_DISPLAY_TOOLS.has(name)) return "structured"
  return "prose"
}

/** Reflow one display body line into fragments per the chosen {@link DisplayWrapMode}. */
function wrapDisplayLine(
  line: string,
  mode: DisplayWrapMode,
  bodyWidth: number | undefined,
): string[] {
  switch (mode) {
    case "none":
      return [clampToolPreviewBodyLine(line, bodyWidth)]
    case "truncate":
      return [clampToolPreviewBodyLine(line, bodyWidth)]
    case "prose":
      return wordWrap(line, bodyWidth!).map((f) => clampToolPreviewBodyLine(f, bodyWidth))
    case "structured":
      // `wrapIndented` already guarantees each fragment fits `bodyWidth`;
      // the clamp is a no-op safety net for the rare degenerate fallback
      // (single unbreakable token) and any wide-glyph off-by-one.
      return wrapIndented(line, bodyWidth!).map((f) => clampToolPreviewBodyLine(f, bodyWidth))
    default: {
      void (mode satisfies never)
      return [clampToolPreviewBodyLine(line, bodyWidth)]
    }
  }
}

/**
 * Render a tool's result block for the transcript: the rows between
 * `╭ <header>` (written separately by the caller) and the closing `╰`.
 * Inserts the `│ ` gutter on each row, applies the per-tool body line
 * budget (`TOOL_PREVIEW_LINES`), and appends a structured footer for
 * truncation / line-count overflow when applicable.
 *
 * When `display` is provided AND `isError` is falsy, the pre-rendered
 * ANSI string (Edit/Write diffs, plugin custom payloads) is emitted
 * verbatim without truncation — diffs and structured renders are the
 * point of the override channel.
 *
 * @param content - Raw tool output (model-facing payload); may carry a
 *                  trailing `[truncated: ...]` notice which is stripped
 *                  before display (the human-facing footer carries the
 *                  same facts in compact form).
 * @param isError - When true, render bias toward visibility (no display
 *                  override, no overflow trim).
 * @param display - Optional pre-rendered ANSI payload to use instead of
 *                  the truncated `content`.
 * The trailing options bag carries `tool` (line budget), `info`
 * (truncation facts for the footer), `footer` (display-mode footer
 * override), and `cols` (per-line clamp width).
 */
export function formatToolPreview(
  content: string,
  isError?: boolean,
  display?: string,
  opts?: {
    tool?: string
    info?: TruncationInfo
    footer?: string
    cols?: number
    /** Content already carries balanced syntax-highlighting ANSI. */
    ansiContent?: boolean
  },
): string[] {
  // If the tool provided a pre-rendered display string (e.g. ANSI-colored
  // unified diff from Edit/Write), render it as-is, line by line, with the
  // standard `│ ... └` connector gutter. Per-line clamp to the live
  // terminal width still applies so a 400-char diff line in a 90-col
  // terminal doesn't soft-wrap into the gutter ; we don't apply the
  // TOOL_PREVIEW_LINE_WIDTH preview cap here (diffs are the point on wide
  // terminals). When the caller has no width signal (e.g. unit tests with
  // no TTY and no `opts.cols`), `toolPreviewBodyWidth` returns `undefined`
  // and `clampToolPreviewBodyLine` becomes a no-op : full-width verbatim
  // output for tests, terminal-aware clamping in production.
  if (display !== undefined && !isError) {
    const out: string[] = []
    const footer = opts?.footer
    const bodyWidth = toolPreviewBodyWidth(opts?.cols)
    const wrapMode = displayWrapMode(opts?.tool, bodyWidth)
    const body = footer === undefined ? display.replace(/\n$/, "") : display
    const dlines = body.length === 0 ? [] : body.split("\n")
    if (dlines.length === 0 && footer === undefined) {
      out.push(`  ${c.dimCyan("╰")}`)
      return out
    }
    // Diff tools get a line-number gutter and wrap-then-cut rows (see
    // `diff-rows.ts`). Each rendered row is then one fragment. Edit and Write
    // show one file, so their `@@` rows are hidden. A Write that created a
    // file shows Read-style rows, and its footer gets the `┊` cut row.
    const tool = opts?.tool ?? ""
    const newFile = tool === "Write" && isNewFileDisplay(body)
    const rowGroups: string[][] = newFile
      ? renderNewFileRows(dlines, bodyWidth).map((row) => [row])
      : DIFF_DISPLAY_TOOLS.has(tool)
        ? renderDiffRows(dlines, bodyWidth, undefined, {
            hideHunkHeaders: FILE_DIFF_TOOLS.has(tool),
          }).map((row) => [row])
        : dlines.map((line) => wrapDisplayLine(line, wrapMode, bodyWidth))
    for (let i = 0; i < rowGroups.length; i++) {
      const fragments = rowGroups[i]!
      for (let fi = 0; fi < fragments.length; fi++) {
        const isLastLine = i === rowGroups.length - 1
        const isLastFrag = fi === fragments.length - 1
        const conn = footer === undefined && isLastLine && isLastFrag ? "╰" : "│"
        const fragLine = fragments[fi]
        out.push(
          fragLine.length === 0 ? `  ${c.dimCyan(conn)}` : `  ${c.dimCyan(conn)} ${fragLine}`,
        )
      }
    }
    if (footer !== undefined) {
      if (newFile && footer.length > 0) out.push(`  ${c.dimCyan("┊")}`)
      const footerLine = clampToolPreviewBodyLine(footer, bodyWidth)
      out.push(
        footerLine.length === 0 ? `  ${c.dimCyan("╰")}` : `  ${c.dimCyan("╰")} ${footerLine}`,
      )
    }
    return out
  }

  const tool = opts?.tool
  const info = opts?.info
  const color = isError ? c.red : opts?.ansiContent ? (line: string) => line : c.dim

  // 1. Strip ALL model-only trailing annotations from what we display to
  //    the human. Three flavors today : `[truncated: ...]`, `[note: ...]`,
  //    `<ma::agent::output-preview ...>...</ma::agent::output-preview>` (see
  //    `findAnnotationStart`). They live at end-of-content separated by
  //    `\n\n` and stack in a fixed order, so the earliest of their
  //    last-occurrences is the start of the annotation region and we slice
  //    from there. The structured `info` (when supplied) carries the same
  //    truncation numbers in machine form : we render those as the
  //    bare-facts footer instead.
  const noticeIdx = findAnnotationStart(content)
  let body = noticeIdx >= 0 ? content.slice(0, noticeIdx) : content

  // 2. Per-line width clamp (display-width-aware so wide chars / emoji /
  //    CJK don't blow past the budget). The clamp is the effective body
  //    width : `min(terminal_cols - gutter, TOOL_PREVIEW_LINE_WIDTH)`.
  //    Without the terminal-width factor an N-cell preview line in an
  //    M-col terminal where N > M would soft-wrap and produce the
  //    "  │ start..." / "...end of line" split scrollback (user-reported,
  //    May 2026). Scrollback never re-renders on resize, but every new
  //    tool block paints under the live width. See {@link
  //    effectiveBodyLineWidth} for the cap rationale and {@link
  //    clampBodyWithHint} for the hint-reserve detail.
  const maxLines = TOOL_PREVIEW_LINES[tool ?? ""] ?? TOOL_PREVIEW_LINES_DEFAULT
  const allLines = (body || "(no output)").split("\n")
  const shown = allLines.slice(0, maxLines)
  // Read shares the diff line-number gutter (see `renderReadRows`).
  const visible = tool === "Read" ? renderReadRows(shown) : shown
  const linesElided = allLines.length - visible.length
  const lineWidth = effectiveBodyLineWidth(opts?.cols)
  // Expand `\t` to spaces using the gutter as the starting column. A
  // literal tab is a 0-cell glyph under `displayWidth` but the
  // terminal renders it as an advance to the next tab stop, so
  // without this the body row can overflow the visible columns by up
  // to one tab-size and wrap into the gutter. Common offender is
  // Read's `<linenum>\t<content>` format (see `expandTabs` rationale).
  const renderedLines: string[] = visible.map((line) =>
    clampBodyWithHint(expandTabs(line, TOOL_PREVIEW_GUTTER_WIDTH), lineWidth),
  )

  // 3. Build the footer.
  //    The footer always reads "shown <visible-in-TUI> / <real-source-total>"
  //    : one ratio, two domains. The user immediately sees how much of the
  //    underlying tool result they're actually looking at.
  //    - API truncation present (info.truncated): include byte ratio
  //      (model-shown / source-total) and the cut line.
  //    - TUI-only elision (long body but the API did not clamp): just the
  //      line ratio. Bytes are uniformative when nothing was cut at the API.
  //    - Body fits within budget AND no API truncation: no footer at all.
  let footerStat: string | null = null
  if (info?.truncated) {
    footerStat = formatTruncFooter(info, visible.length)
  } else if (linesElided > 0) {
    const totalLines = info?.totalLines ?? allLines.length
    footerStat = `shown ${visible.length}/${totalLines} L`
  }

  // 4. Stitch lines + footer with the bordered gutter.
  //    When a truncation footer is present we slot a `┊` (light-dotted
  //    vertical) row between the last body line and the `╰ <footer>` row.
  //    The dotted glyph reads as "something has been cut here" : visually
  //    foreshadowing the bare-facts footer below it (e.g. `shown 10/520 L`).
  //    No `┊` is emitted on a clean run (body fits, no API clamp): in that
  //    case there's nothing missing, so the body just closes with `╰`.
  const out: string[] = []
  const totalRender = renderedLines.length
  for (let i = 0; i < totalRender; i++) {
    // Last rendered line is `╰` only when there's no footer below it.
    const isLast = i === totalRender - 1 && footerStat === null
    const connector = isLast ? "╰" : "│"
    out.push(`  ${c.dimCyan(connector)} ${color(renderedLines[i])}`)
  }
  if (footerStat !== null) {
    out.push(`  ${c.dimCyan("┊")}`)
    out.push(`  ${c.dimCyan("╰")} ${c.dim(footerStat)}`)
  }
  return out
}

/**
 * Render the two-row transcript block for a tool the active mode REFUSED to
 * run: a `│ ⊘ <message>` row (dim message behind the bold-red deny glyph)
 * and a `╰ (refused by <mode>)` closer. The core tool loop owns the semantic
 * decision (which tool, which mode, what message); the box-drawing frame and
 * palette live here so core `src/loops/tool-round.ts` never imports the ANSI helpers.
 */
export function formatRefusalRows(message: string, refusedBy: string): string[] {
  return [
    `  ${c.dimCyan("│")} ${c.boldRed("⊘")} ${c.dim(message)}`,
    `  ${c.dimCyan("╰")} ${c.dim(`(refused by ${refusedBy})`)}`,
  ]
}

/**
 * Render the single closing row for the built-in `Mode` tool:
 * `╰ active mode: <label>`. The structured JSON result goes to the model;
 * this row just shows the user the mode was checked. Presentation-only, so
 * it lives in the host next to the rest of the tool-block chrome.
 */
export function formatModeCloseRow(labelDisplay: string): string {
  return `  ${c.dimCyan("╰")} ${c.dim(`active mode: ${labelDisplay}`)}`
}

/**
 * Render one streamed body row (`│ <line>`) for the live Bash stream path.
 * The core streamer buffers the previous line and emits it through this
 * helper before buffering the next, so the box-drawing gutter + dim styling
 * stay in the host instead of being hand-built in core `src/loops/tool-round.ts`.
 */
export function formatStreamBodyRow(line: string): string {
  return `  ${c.dimCyan("│")} ${c.dim(line)}`
}

/**
 * Emit the closing rows for a tool whose body was already streamed `│`-line
 * by `│`-line into scrollback (live, while the child process ran). We held
 * back the LAST emitted line so we can either:
 *
 *   - rewrite it as `╰ <line>` when there's nothing to summarize (clean
 *     run, body fits in budget, no truncation), OR
 *   - emit it as `│ <line>`, then a `┊` truncation separator, then a
 *     `╰ <footer>` row when there IS something to say (truncation, elision,
 *     or zero-output abort). The `┊` reads as "something cut here" and
 *     visually foreshadows the bare-facts footer (e.g. `shown 10/520 L`).
 *
 * Scrollback is permanent : once a `│` row is written we can't rewrite it
 * : so the buffered-last-line trick is the only way to keep the close
 * glyph attached to the body in the no-footer case.
 *
 * Mirrors the audience-split invariant in {@link formatToolPreview}: footer
 * carries bare facts (lines / bytes / cut location); no verbs / advice.
 * Mirrors its `┊`-before-`╰` convention too, so streamed and non-streamed
 * tool blocks have identical shape from the user's eye.
 */
export function renderStreamedTail(opts: {
  bufferedLastLine: string | null
  bufferedLastLineRaw?: string | null
  streamedLineCount: number
  budget: number
  truncInfo?: TruncationInfo
  isError?: boolean
  writeTranscript: (line: string) => void
  cols?: number
}): void {
  const { bufferedLastLine, streamedLineCount, budget, truncInfo, isError, writeTranscript } = opts
  const visibleCount = Math.min(streamedLineCount, budget)
  const color = isError ? c.red : c.dim

  let footer: string | null = null
  if (truncInfo?.truncated) {
    footer = formatTruncFooter(truncInfo, visibleCount)
  } else if (streamedLineCount > budget) {
    const totalLines = truncInfo?.totalLines ?? streamedLineCount
    footer = `shown ${visibleCount}/${totalLines} L`
  }

  // Always emit the pre-clamped single row. Never word-wrap
  // `bufferedLastLineRaw`: a minified mega-line (webpack bundles, etc.)
  // would otherwise expand into tens of thousands of `│` rows and flood
  // the transcript (Adrian 2026-08-05: 7.2 MB single-line `rg` hit →
  // wall of soft-wrapped scrollback under a truncation footer).
  // `bufferedLastLine` was already width-clamped in `flushLineToBuffer`.
  const writeLastLine = (connector: string) => {
    if (bufferedLastLine === null) {
      writeTranscript(`  ${c.dimCyan(connector)}`)
      return
    }
    writeTranscript(
      bufferedLastLine.length === 0
        ? `  ${c.dimCyan(connector)}`
        : `  ${c.dimCyan(connector)} ${color(bufferedLastLine)}`,
    )
  }

  if (bufferedLastLine === null) {
    writeTranscript(`  ${c.dimCyan("╰")} ${c.dim(footer ?? "(no output)")}`)
    return
  }

  if (footer === null) {
    writeLastLine("\u2570")
    return
  }

  writeLastLine("\u2502")
  writeTranscript(`  ${c.dimCyan("┊")}`)
  writeTranscript(`  ${c.dimCyan("╰")} ${c.dim(footer)}`)
}

/**
 * Format a {@link TruncationInfo} as the bare-facts footer string.
 * No verbs, no advice : totals and cut location only.
 *
 * Format: `shown <V>/<T> L · <X>/<Y> B · cut at L<L>`
 *
 *   - **V** = lines visible in the TUI right now (`tuiVisible` argument).
 *     This is what the user is looking at : the most user-relevant count.
 *   - **T** = total lines the underlying source produced (`info.totalLines`).
 *     The denominator the user cares about ("how big was this really?").
 *   - **X** = bytes shown to the model (`info.shownBytes`). Note: this is
 *     model-domain, not user-domain : the user sees fewer body bytes than
 *     the model when the TUI body budget is below the API cap. Showing
 *     model-bytes here gives the user the size of the actual `tool_result`
 *     ride-back, which is what tokens are spent on.
 *   - **Y** = total bytes from the source (`info.totalBytes`).
 *   - **L** = cut line index (`info.cutLine`).
 */
function formatTruncFooter(info: TruncationInfo, tuiVisible: number): string {
  const totalL = info.totalLines ?? info.shownLines
  const totalB = info.totalBytes ?? info.shownBytes
  const lineFrag = `shown ${tuiVisible}/${totalL} L`
  const byteFrag = `${formatBytes(info.shownBytes)}/${formatBytes(totalB)}`
  const cutFrag = `cut at L${info.cutLine}`
  return `${lineFrag} · ${byteFrag} · ${cutFrag}`
}

/** Format byte counts with K/M suffix for compactness. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

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
    const dot = severityDot(f.severity)
    const loc = locationFragment(f)
    const locPart = loc ? `${c.dim(loc)} ` : ""
    const codePart = f.code ? `${c.dim(f.code)} ` : ""
    const body = `${dot} ${locPart}${codePart}${f.message}`
    const line = clampToolPreviewBodyLine(body, bodyWidth)
    out.push(`  ${c.dimCyan("│")} ${line}`)
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
