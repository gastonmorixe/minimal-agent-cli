/**
 * The REPL tool transcript view (spec S24, S29).
 *
 * Core runs each tool call and sends plain tool view events (a refusal, the
 * start, the live output chunks, the outcome). It builds no rows. This module
 * builds the REPL rows from those events with the CLI tool transcript
 * formatter (`./format.ts`): the framed header, the live Bash body, the
 * preview, the colored or highlighted Edit/Write diff, and the diagnostics
 * panel. The rows never reach the model.
 *
 * The view owns all terminal choices: the width, the tool presentation map
 * (icon, color, early header paint), the header time hint, and the code
 * highlighter.
 *
 * @module ui/tool-transcript/tool-view
 */

import { NO_SIDEBAND, type SidebandReader } from "@minimal-agent/core/host/sideband"
import type {
  ToolViewEvent,
  ToolViewOutcome,
  ToolViewPort,
} from "@minimal-agent/core/host-kit/tool-executor-adapter"
import { expandTabs } from "@minimal-agent/core/plugin-api/utils/term-width"
import type { ToolUseBlock } from "@minimal-agent/core/sdk/messages"
import { c } from "../style/ansi.ts"
import { diffSummary, displayPatch, newFileDisplay, newFileNumberedBody } from "./diff-rows.ts"
import {
  type CodeHighlighter,
  clampBodyWithHint,
  effectiveBodyLineWidth,
  formatModeCloseRow,
  formatRefusalRows,
  formatStreamBodyRow,
  formatToolHeaderRows,
  formatToolPreview,
  highlightReadBody,
  highlightUnifiedDiff,
  renderFindingsPanel,
  renderStreamedTail,
  renderUnifiedDiff,
  reopenFrameCloser,
  resolveFileLanguage,
  TOOL_PREVIEW_GUTTER_WIDTH,
  TOOL_PREVIEW_LINES,
  TOOL_PREVIEW_LINES_DEFAULT,
  type ToolPresentation,
  validBodyEnd,
} from "./format.ts"
import type { ToolTimeTracker } from "./tool-time.ts"

/**
 * The ESC character, built from its code point. The view only DETECTS it in
 * tool output (to skip the highlighter).
 */
const ESC = String.fromCodePoint(0x1b)

/**
 * Cap on a single newline-free pending stream chunk. Mega-lines (minified
 * bundles) must not pile up multi-MB in the view while it waits for a
 * newline that never comes. The preview needs only a few hundred cells.
 */
const STREAM_PENDING_LINE_MAX = 4_096

/**
 * The host side of the live tool tree (`ui/status/tool-tree.ts`). The view
 * tells it when a call starts and when its block reaches the scrollback.
 */
export interface ToolViewCalls {
  /** The call started. `concurrent` is true for a call in a wave. */
  started(tool: ToolUseBlock, concurrent: boolean): void
  /** The block of an ended call is about to be written. */
  beforeBlock(): void
  /** The block of the call `id` was written. Its row goes away now. */
  afterBlock(id: string): void
}

/** What the REPL tool view needs from its host. */
export interface ReplToolViewOptions {
  /** Transcript sink: one call per scrollback row. */
  writeTranscript: (line: string) => void
  /** The CLI static tool presentation map (S41), keyed by tool name. */
  presentation: ReadonlyMap<string, ToolPresentation>
  /** Optional `· HH:MM:SS` header time hint. */
  toolTimeTracker?: ToolTimeTracker | null
  /** Warm, fail-closed syntax highlighter for Read and Edit/Write bodies. */
  codeHighlighter?: CodeHighlighter | null
  /**
   * The render width, read once when a tool call starts. Omitted: the
   * formatter uses its own default width.
   */
  columns?: () => number | undefined
  /**
   * The dir that header paths are shown relative to. Omitted: the formatter
   * uses `process.cwd()`.
   */
  cwd?: string
  /**
   * The live tool tree. When set, a call row goes away in the same frame
   * as the block of that call reaches the scrollback.
   */
  calls?: ToolViewCalls
  /**
   * The sideband reader of the session (`sidebandOf(loader)`). It cuts the
   * model-only annotations from a result with no core `bodyEnd`. Omitted:
   * `NO_SIDEBAND` (no cut).
   */
  sideband?: SidebandReader
}

/**
 * The start of the annotation region at the end of `content` (`-1` when
 * there is none), from the sideband codec.
 */
function trailingCut(content: string, sb: SidebandReader): number {
  const { bodyEnd } = sb.trailing(content)
  return bodyEnd < content.length ? bodyEnd : -1
}

/** The live state of one tool call. */
interface CallState {
  cols: number | undefined
  headerWritten: boolean
  suppressToolTime: boolean
  displayHeader: string | undefined
  // Live stream state (Bash).
  budget: number
  streamedLineCount: number
  bufferedLastLine: string | null
  bufferedLastLineRaw: string | null
  pendingChunk: string
  discardingLine: boolean
  didStream: boolean
  /**
   * The rows of a call in a wave of 2 or more, kept until the call ends
   * (D11). `null`: the rows go to the transcript live, as today. A
   * function item makes its rows at flush time (the header: its time text
   * must follow the print order, see `writeHeader`).
   */
  buffer: Array<string | (() => string[])> | null
  /** When a buffered call started. Its header shows this time. */
  startedAt: number | undefined
}

/** The REPL tool view, with the end-of-run safety net. */
export interface ReplToolView extends ToolViewPort {
  /**
   * Write the kept rows of each call that got no `outcome` (for example
   * after an abort), then forget those calls. The host calls it when the
   * run ends. Calls that write live are not changed.
   */
  flushPending(): void
}

/**
 * True when core marks the call as one that runs in a wave of 2 or more.
 * The key is absent for a solo call, at cap 1, and with a core that does
 * not send it yet.
 */
function isConcurrentStart(event: Extract<ToolViewEvent, { type: "started" }>): boolean {
  return event.concurrent === true
}

/**
 * Tool names that render a caller-supplied unified diff. `DiffViewerShowDiff`
 * is the model-facing name (ma-diff-view-plugin). `ShowDiff` and `show_diff`
 * are the plugin manifest's canonical name and its alias, which a resumed
 * session or a muscle-memory call can still carry, so all three get the same
 * host treatment as Edit.
 */
const SHOW_DIFF_TOOLS: ReadonlySet<string> = new Set([
  "DiffViewerShowDiff",
  "ShowDiff",
  "show_diff",
])

/** True when the tool carries a raw unified `patch` input instead of a `diff`. */
function isShowDiffTool(toolName: string): boolean {
  return SHOW_DIFF_TOOLS.has(toolName)
}

/**
 * Read the file path out of a unified diff, so the host can pick a syntax
 * language for a `ShowDiff` patch. The plugin sends only `patch` and `title`;
 * the path lives on the patch's `+++ b/<path>` line, with `--- a/<path>` as
 * the fallback (a deleted or binary-side file). A plain, prefix-free path is
 * accepted too, because `diff -u` output is not always git-shaped.
 */
function diffPatchPath(patch: string): string | undefined {
  let removed: string | undefined
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) return stripDiffPathPrefix(line.slice(4))
    if (line.startsWith("--- ") && removed === undefined) {
      removed = stripDiffPathPrefix(line.slice(4))
    }
  }
  return removed
}

/** Strip the `a/`/`b/` git prefix and any tab-separated metadata from a header path. */
function stripDiffPathPrefix(raw: string): string | undefined {
  // `diff -u` appends a tab and a timestamp to each header path.
  const path = raw.split("\t")[0]?.trim()
  if (!path || path === "/dev/null") return undefined
  return path.replace(/^[ab]\//, "")
}

/**
 * Build the REPL tool view: a {@link ToolViewPort} that writes the framed
 * tool rows to `opts.writeTranscript`.
 */
export function createReplToolView(opts: ReplToolViewOptions): ReplToolView {
  const sideband = opts.sideband ?? NO_SIDEBAND
  const { writeTranscript } = opts
  const calls = new Map<string, CallState>()

  /** Write one row now, or keep it in the call's block (D11). */
  const emitRow = (state: CallState, row: string): void => {
    if (state.buffer) state.buffer.push(row)
    else writeTranscript(row)
  }

  /**
   * Write the kept block of a call. The rows go out in one synchronous
   * loop, so no row of another call can come between them, and each row
   * gets the same writer step as a live row (the live area adds its blank
   * row after each `╰` closer).
   */
  const flushBlock = (state: CallState): void => {
    const rows = state.buffer
    if (!rows) return
    state.buffer = null
    for (const item of rows) {
      if (typeof item === "string") writeTranscript(item)
      else for (const row of item()) writeTranscript(row)
    }
  }

  /** The call ended: write its kept block, and drop its live row in the same frame. */
  const endCall = (tool: ToolUseBlock, state: CallState): void => {
    opts.calls?.beforeBlock()
    try {
      flushBlock(state)
    } finally {
      opts.calls?.afterBlock(tool.id)
    }
  }

  const stateFor = (tool: ToolUseBlock): CallState => {
    const known = calls.get(tool.id)
    if (known) return known
    const state: CallState = {
      cols: opts.columns?.(),
      headerWritten: false,
      suppressToolTime: false,
      displayHeader: undefined,
      budget: TOOL_PREVIEW_LINES[tool.name] ?? TOOL_PREVIEW_LINES_DEFAULT,
      streamedLineCount: 0,
      bufferedLastLine: null,
      bufferedLastLineRaw: null,
      pendingChunk: "",
      discardingLine: false,
      didStream: false,
      buffer: null,
      startedAt: undefined,
    }
    calls.set(tool.id, state)
    return state
  }

  const writeHeader = (tool: ToolUseBlock, state: CallState, override?: string): void => {
    if (state.headerWritten) return
    state.headerWritten = true
    const headerRows = (at: number): string[] => {
      const timeText = state.suppressToolTime ? undefined : opts.toolTimeTracker?.format(at)
      const rows = formatToolHeaderRows({
        tool,
        presentation: opts.presentation.get(tool.name),
        headerOverride: override,
        timeText,
        cols: state.cols,
        pathContext: opts.cwd !== undefined ? { cwd: opts.cwd } : undefined,
      })
      return rows.map((row, idx) => (idx === 0 ? `\n${row}` : row))
    }
    const startedAt = state.startedAt
    if (state.buffer && startedAt !== undefined) {
      // A kept block shows the time its call started, not the time it
      // ends. The time text is made at flush time: the tracker adds the
      // date when the day changes, so it must see the headers in the order
      // they print (end order), not in start order.
      state.buffer.push(() => headerRows(startedAt))
      return
    }
    for (const row of headerRows(Date.now())) emitRow(state, row)
  }

  /** Add one finished stream line. The last line stays buffered. */
  const flushLine = (state: CallState, raw: string): void => {
    state.didStream = true
    if (state.streamedLineCount >= state.budget) {
      state.streamedLineCount++
      return
    }
    if (state.bufferedLastLine !== null) {
      emitRow(state, formatStreamBodyRow(state.bufferedLastLine))
    }
    // Cheap pre-slice before the width math: a mega-line is already
    // ruined for the preview.
    const previewRaw =
      raw.length > STREAM_PENDING_LINE_MAX ? raw.slice(0, STREAM_PENDING_LINE_MAX) : raw
    // Live width (no `cols` argument), so a resize takes effect on the next
    // line. Expand tabs from the body start column first, so the width math
    // counts the tab-stop advance.
    state.bufferedLastLine = clampBodyWithHint(
      expandTabs(previewRaw, TOOL_PREVIEW_GUTTER_WIDTH),
      effectiveBodyLineWidth(),
    )
    state.bufferedLastLineRaw = previewRaw
    state.streamedLineCount++
  }

  const onOutput = (state: CallState, text: string): void => {
    let chunk = text
    if (state.discardingLine) {
      const nl = chunk.indexOf("\n")
      if (nl === -1) return
      state.discardingLine = false
      chunk = chunk.slice(nl + 1)
      if (!chunk) return
    }
    state.pendingChunk += chunk
    let nl: number
    while ((nl = state.pendingChunk.indexOf("\n")) !== -1) {
      flushLine(state, state.pendingChunk.slice(0, nl))
      state.pendingChunk = state.pendingChunk.slice(nl + 1)
    }
    // No newline yet and the pending line is already huge: flush a
    // preview-sized head and drop the rest until the next newline.
    if (state.pendingChunk.length > STREAM_PENDING_LINE_MAX) {
      flushLine(state, state.pendingChunk.slice(0, STREAM_PENDING_LINE_MAX))
      state.pendingChunk = ""
      state.discardingLine = true
    }
  }

  const onExecuted = (state: CallState, ev: Extract<ToolViewEvent, { type: "executed" }>) => {
    // Flush a trailing partial line (no terminating newline).
    if (state.pendingChunk.length > 0) {
      flushLine(state, state.pendingChunk)
      state.pendingChunk = ""
    }
    if (!state.didStream) return
    renderStreamedTail({
      bufferedLastLine: state.bufferedLastLine,
      bufferedLastLineRaw: state.bufferedLastLineRaw,
      streamedLineCount: state.streamedLineCount,
      budget: state.budget,
      truncInfo: ev.truncInfo,
      isError: ev.isError,
      writeTranscript: (line) => emitRow(state, line),
      cols: state.cols,
    })
  }

  const onOutcome = async (
    tool: ToolUseBlock,
    state: CallState,
    outcome: ToolViewOutcome,
  ): Promise<void> => {
    // A streamed body is already closed. Its outcome adds no rows.
    if (state.didStream) return
    writeHeader(tool, state, state.displayHeader)

    const { content, isError } = outcome
    let display = outcome.display
    const diff = outcome.diff
    const filePath = typeof tool.input.file_path === "string" ? tool.input.file_path : undefined
    const isFileDiff = (tool.name === "Edit" || tool.name === "Write") && diff !== undefined
    // A Write that created a file shows a Read-style preview, not a diff.
    const newFilePatch =
      tool.name === "Write" && diff !== undefined && diff.newFile ? diff.patch : undefined
    let displayFooter = outcome.displayFooter
    const editPatch =
      isFileDiff && newFilePatch === undefined ? displayPatch(diff.patch) : undefined
    const summary = isFileDiff ? c.dim(diffSummary(diff.patch, diff.newFile)) : undefined
    // The plain diff is the body when no color or highlight applies.
    if (editPatch !== undefined && display === undefined) display = `${summary}\n${editPatch}`

    // `DiffViewerShowDiff` sends no `file_path` and no `outcome.diff`: its patch
    // arrives in the input and its flat ANSI display from the plugin. The patch
    // header is the only path signal, so resolve the language from it and give
    // the call the same highlight treatment Edit gets.
    const showDiff = isShowDiffTool(tool.name)
    const showDiffPatch = showDiff ? tool.input.patch : undefined
    const patch = typeof showDiffPatch === "string" ? showDiffPatch : diff ? diff.patch : undefined
    const diffTitleText =
      showDiff && typeof tool.input.title === "string" ? tool.input.title : undefined
    const languagePath =
      filePath ?? (typeof showDiffPatch === "string" ? diffPatchPath(showDiffPatch) : undefined)

    // Highlight presentation only. Detection is O(path + first line). A
    // timeout or failure returns null, so the plain render stays.
    const language = languagePath ? resolveFileLanguage({ path: languagePath, content }) : null
    const highlighter = opts.codeHighlighter ?? null
    let previewContent = content
    // The core cut, when valid. A highlighted Read body changes it (below).
    let previewBodyEnd = validBodyEnd(content, outcome.outcome?.bodyEnd)
    let contentHasAnsi = false
    let diffStyled = false
    if (!isError && language && highlighter && !content.includes(ESC)) {
      if (tool.name === "Read" && outcome.display === undefined) {
        // Model-only annotations are plain metadata, not source code. Strip
        // them for the highlighter, then put them back, so the preview's
        // annotation strip still sees the canonical content.
        // The core `bodyEnd` is the cut. Without it, the sideband codec
        // finds the annotation region at the end.
        const annotationIdx = previewBodyEnd ?? trailingCut(content, sideband)
        const readBody = annotationIdx < 0 ? content : content.slice(0, annotationIdx)
        const annotation = annotationIdx < 0 ? "" : content.slice(annotationIdx)
        const highlighted = await highlightReadBody(readBody, language, highlighter)
        if (highlighted !== null) {
          previewContent = highlighted + annotation
          // The body length changed: the new cut is the end of `highlighted`.
          previewBodyEnd = highlighted.length
          contentHasAnsi = true
        }
      } else if (editPatch !== undefined) {
        const highlighted = await highlightUnifiedDiff(editPatch, language, highlighter)
        if (highlighted !== null) {
          display = `${summary}\n${highlighted}`
          diffStyled = true
        }
      } else if (showDiff && patch !== undefined) {
        // The plugin's flat `renderUnifiedDiff` display stays as the fallback:
        // only a non-null highlight replaces it.
        const highlighted = await highlightUnifiedDiff(patch, language, highlighter, diffTitleText)
        if (highlighted !== null) {
          display = highlighted
          diffStyled = true
        }
      }
    }
    // No highlighted diff: color the plain Edit/Write diff (S41).
    if (!isError && !diffStyled && editPatch !== undefined) {
      display = `${summary}\n${renderUnifiedDiff(editPatch)}`
    }
    if (!isError && newFilePatch !== undefined && outcome.display === undefined) {
      const highlighted =
        language && highlighter
          ? await highlightReadBody(newFileNumberedBody(newFilePatch), language, highlighter)
          : null
      const preview = newFileDisplay(newFilePatch, highlighted)
      display = preview.display
      displayFooter ??= preview.footer
    }

    const previewLines = formatToolPreview(previewContent, isError, display, {
      tool: tool.name,
      info: outcome.truncInfo,
      footer: displayFooter,
      cols: state.cols,
      ansiContent: contentHasAnsi,
      ...(previewBodyEnd === undefined ? {} : { bodyEnd: previewBodyEnd }),
      sideband,
    })
    const panel =
      outcome.findings.length > 0
        ? renderFindingsPanel(outcome.findings, state.cols ? { cols: state.cols } : {})
        : []
    // The diagnostics panel owns the final `╰`. Re-open the preview's own
    // closer to a `│`, so the two blocks make one frame.
    if (panel.length > 0 && previewLines.length > 0) {
      const lastIdx = previewLines.length - 1
      previewLines[lastIdx] = reopenFrameCloser(previewLines[lastIdx] ?? "")
    }
    for (const line of previewLines) emitRow(state, line)
    for (const line of panel) emitRow(state, line)
  }

  return {
    flushPending(): void {
      for (const state of calls.values()) flushBlock(state)
      calls.clear()
    },
    async onToolEvent(event: ToolViewEvent): Promise<void> {
      const { tool } = event
      const state = stateFor(tool)
      switch (event.type) {
        case "refused":
          writeHeader(tool, state)
          for (const row of formatRefusalRows(event.message, event.refusedBy)) {
            emitRow(state, row)
          }
          endCall(tool, state)
          calls.delete(tool.id)
          return
        case "input_error":
          writeHeader(tool, state)
          endCall(tool, state)
          calls.delete(tool.id)
          return
        case "mode":
          writeHeader(tool, state)
          emitRow(state, formatModeCloseRow(event.label))
          endCall(tool, state)
          calls.delete(tool.id)
          return
        case "started":
          opts.calls?.started(tool, isConcurrentStart(event))
          // A call in a wave keeps its rows until it ends (D11). Bash stays
          // live: its rows stream as the command runs (X4).
          if (isConcurrentStart(event) && tool.name !== "Bash") {
            state.buffer = []
            state.startedAt = Date.now()
          }
          // A built-in tool, or a plugin tool with a header key, shows its
          // header at once. Other plugin tools wait for their header text.
          if (!event.pluginTool || opts.presentation.get(tool.name)?.headerKey != null) {
            writeHeader(tool, state)
          }
          return
        case "plugin_result":
          state.suppressToolTime = event.view.suppressToolTime
          state.displayHeader = event.view.displayHeader
          writeHeader(tool, state, event.view.displayHeader)
          return
        case "output":
          onOutput(state, event.chunk)
          return
        case "executed":
          onExecuted(state, event)
          return
        case "outcome":
          try {
            await onOutcome(tool, state, event.outcome)
          } finally {
            endCall(tool, state)
            calls.delete(tool.id)
          }
          return
        default:
          throw new Error(`unhandled tool view event: ${JSON.stringify(event satisfies never)}`)
      }
    },
  }
}
