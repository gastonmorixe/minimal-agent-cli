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

import type {
  ToolViewEvent,
  ToolViewOutcome,
  ToolViewPort,
} from "@minimal-agent/core/host-kit/tool-executor-adapter"
import { expandTabs } from "@minimal-agent/core/plugin-api/utils/term-width"
import type { ToolUseBlock } from "@minimal-agent/core/sdk/messages"
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

/** The title line of an Edit/Write diff: Write shows the file, Edit shows none. */
function diffTitle(
  toolName: string,
  filePath: string | undefined,
  isNew: boolean,
): string | undefined {
  return toolName === "Write" && filePath
    ? `${isNew ? "New file" : "Write"}: ${filePath}`
    : undefined
}

/** The plain body of a diff: the title line (if any), then the patch. */
function plainDiff(patch: string, title?: string): string {
  return title ? `${title}\n${patch}` : patch
}

/**
 * Build the REPL tool view: a {@link ToolViewPort} that writes the framed
 * tool rows to `opts.writeTranscript`.
 */
export function createReplToolView(opts: ReplToolViewOptions): ToolViewPort {
  const { writeTranscript } = opts
  const calls = new Map<string, CallState>()

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
    }
    calls.set(tool.id, state)
    return state
  }

  const writeHeader = (tool: ToolUseBlock, state: CallState, override?: string): void => {
    if (state.headerWritten) return
    state.headerWritten = true
    const timeText = state.suppressToolTime ? undefined : opts.toolTimeTracker?.format(Date.now())
    const rows = formatToolHeaderRows({
      tool,
      presentation: opts.presentation.get(tool.name),
      headerOverride: override,
      timeText,
      cols: state.cols,
    })
    for (const [idx, row] of rows.entries()) writeTranscript(idx === 0 ? `\n${row}` : row)
  }

  /** Add one finished stream line. The last line stays buffered. */
  const flushLine = (state: CallState, raw: string): void => {
    state.didStream = true
    if (state.streamedLineCount >= state.budget) {
      state.streamedLineCount++
      return
    }
    if (state.bufferedLastLine !== null) {
      writeTranscript(formatStreamBodyRow(state.bufferedLastLine))
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
      writeTranscript,
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
    const title = diff ? diffTitle(tool.name, filePath, diff.newFile) : undefined
    // The plain diff is the body when no color or highlight applies.
    if (diff && display === undefined) display = plainDiff(diff.patch, title)

    // `DiffViewerShowDiff` sends no `file_path` and no `outcome.diff`: its patch
    // arrives in the input and its flat ANSI display from the plugin. The patch
    // header is the only path signal, so resolve the language from it and give
    // the call the same highlight treatment Edit gets.
    const showDiff = isShowDiffTool(tool.name)
    const showDiffPatch = showDiff ? tool.input.patch : undefined
    const patch = typeof showDiffPatch === "string" ? showDiffPatch : diff ? diff.patch : undefined
    const diffTitleText =
      showDiff && typeof tool.input.title === "string" ? tool.input.title : title
    const languagePath =
      filePath ?? (typeof showDiffPatch === "string" ? diffPatchPath(showDiffPatch) : undefined)

    // Highlight presentation only. Detection is O(path + first line). A
    // timeout or failure returns null, so the plain render stays.
    const language = languagePath ? resolveFileLanguage({ path: languagePath, content }) : null
    const highlighter = opts.codeHighlighter ?? null
    let previewContent = content
    let contentHasAnsi = false
    let diffStyled = false
    if (!isError && language && highlighter && !content.includes(ESC)) {
      if (tool.name === "Read" && outcome.display === undefined) {
        // Model-only annotations are plain metadata, not source code. Strip
        // them for the highlighter, then put them back, so the preview's
        // annotation strip still sees the canonical content.
        const annotationMatches = [
          content.indexOf("\n\n<ma::"),
          content.indexOf("\n\n[truncated:"),
          content.indexOf("\n\n[note:"),
        ].filter((index) => index >= 0)
        const annotationIdx = annotationMatches.length === 0 ? -1 : Math.min(...annotationMatches)
        const readBody = annotationIdx < 0 ? content : content.slice(0, annotationIdx)
        const annotation = annotationIdx < 0 ? "" : content.slice(annotationIdx)
        const highlighted = await highlightReadBody(readBody, language, highlighter)
        if (highlighted !== null) {
          previewContent = highlighted + annotation
          contentHasAnsi = true
        }
      } else if ((tool.name === "Edit" || tool.name === "Write") && diff) {
        const highlighted = await highlightUnifiedDiff(diff.patch, language, highlighter, title)
        if (highlighted !== null) {
          display = highlighted
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
    if (!isError && !diffStyled && (tool.name === "Edit" || tool.name === "Write") && diff) {
      display = renderUnifiedDiff(diff.patch, title)
    }

    const previewLines = formatToolPreview(previewContent, isError, display, {
      tool: tool.name,
      info: outcome.truncInfo,
      footer: outcome.displayFooter,
      cols: state.cols,
      ansiContent: contentHasAnsi,
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
    for (const line of previewLines) writeTranscript(line)
    for (const line of panel) writeTranscript(line)
  }

  return {
    async onToolEvent(event: ToolViewEvent): Promise<void> {
      const { tool } = event
      const state = stateFor(tool)
      switch (event.type) {
        case "refused":
          writeHeader(tool, state)
          for (const row of formatRefusalRows(event.message, event.refusedBy)) {
            writeTranscript(row)
          }
          calls.delete(tool.id)
          return
        case "input_error":
          writeHeader(tool, state)
          calls.delete(tool.id)
          return
        case "mode":
          writeHeader(tool, state)
          writeTranscript(formatModeCloseRow(event.label))
          calls.delete(tool.id)
          return
        case "started":
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
            calls.delete(tool.id)
          }
          return
        default:
          throw new Error(`unhandled tool view event: ${JSON.stringify(event satisfies never)}`)
      }
    },
  }
}
