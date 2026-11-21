/**
 * Host-side slash-command dispatch + result application for the live REPL.
 *
 * Extracted from `src/host/repl-live-area.ts` to keep that file under its
 * `max-lines` budget. Behavior is unchanged: the `/compact` live sink is
 * forwarded only for the compact command, an unknown-but-parsed line falls
 * back to the prompt queue, and every result kind renders through the same
 * notice path.
 *
 * @module host/commands/dispatch-submit
 */

import type { CommandDispatchOptions } from "@minimal-agent/core/host-kit/command-registry"
import { parseCommandLine } from "@minimal-agent/core/host-kit/command-registry"
import type {
  CommandResult,
  EditorSubmittedPayload,
  PromptSource,
  PromptSubmittedPayload,
} from "@minimal-agent/core/plugin-api/types/plugin"
import { errorText } from "../startup/core-text.ts"
import { renderCommandNoticeBlock } from "../ui/command-notice.ts"

import {
  type CompactStreamDeps,
  createCompactStream,
  endQuietly,
  renderCompactNotice,
} from "./compact-submit.ts"

/**
 * Queues a prompt; `source` (default `user`) is the origin of the text: see
 * `PromptSource` in the `@minimal-agent/core` plugin-api types (spec: monorepo
 * `research/title-plugin/SPEC.md` §6.1).
 */
export type EnqueuePrompt = (
  text: string,
  commitLines: string[],
  submittedAt?: Date,
  source?: PromptSource,
) => void

/** Origin of a submitted line: typed in the editor, or a `prompt.inject` emit. */
export type SubmitSource = Extract<PromptSource, "user" | "inject">

/** The live-area submit handler. `source` defaults to `user` (the editor path). */
export type SubmitLine = (
  text: string,
  commitLines?: string[],
  submittedAt?: Date,
  source?: SubmitSource,
) => void

/**
 * Build the `prompt.submitted` payload. Kept here so the live area stays
 * under its `max-lines` budget. `source` names the origin of the text.
 *
 * @param text - The queued prompt text.
 * @param sid - The session id, if the host has one.
 * @param queuePos - Position of the prompt in the host queue.
 * @param source - Origin of the text.
 * @returns The payload for the plugin bus.
 */
export function promptSubmittedPayload(
  text: string,
  sid: string | null | undefined,
  queuePos: number,
  source: PromptSource,
): PromptSubmittedPayload {
  return { text, cwd: process.cwd(), sid: sid ?? null, exit: "submitted", queuePos, source }
}

/**
 * Build the `editor.submitted` payload: the raw line that the user typed in
 * the editor, before slash-command dispatch or expansion. Only the editor
 * submit path calls it (never `prompt.inject`, recovery or `/continue`).
 *
 * @param text - The raw submitted line.
 * @param sid - The session id, if the host has one.
 * @param submittedAt - Submit time; defaults to now.
 * @returns The payload for the plugin bus.
 */
export function editorSubmittedPayload(
  text: string,
  sid: string | null | undefined,
  submittedAt?: Date,
): EditorSubmittedPayload {
  return {
    text,
    cwd: process.cwd(),
    sid: sid ?? null,
    submittedAt: (submittedAt ?? new Date()).toISOString(),
  }
}

/**
 * Build the editor `submit` listener. It is the ONLY emitter of
 * `editor.submitted`: for each non-blank typed line it emits the raw text
 * first (before slash-command dispatch, so `/model x` is recorded as typed),
 * then calls `onSubmit` with source `user`. `prompt.inject`, recovery and
 * `/continue` call `onSubmit` / the queue directly and never pass here.
 *
 * @param bus - The plugin bus, or `null` when plugins are disabled.
 * @param sid - The session id, if the host has one.
 * @param onSubmit - The shared submit path.
 * @returns The listener for `editor.on("submit", …)`.
 */
export function editorSubmitListener(
  bus: { emit(event: string, payload: EditorSubmittedPayload): void } | null,
  sid: string | null | undefined,
  onSubmit: SubmitLine,
): (text: string, commitLines?: string[], submittedAt?: Date) => void {
  return (text, commitLines, submittedAt) => {
    if (!text.trim()) return
    bus?.emit("editor.submitted", editorSubmittedPayload(text, sid, submittedAt))
    onSubmit(text, commitLines, submittedAt, "user")
  }
}

/** Structural view of the command registry the submit path needs. */
export interface DispatchSubmitHost {
  /** Dispatch a `/name` line; `null` means "not a registered command". */
  dispatchCommand(line: string, opts?: CommandDispatchOptions): Promise<CommandResult | null>
  /** Event bus used to announce an expanded `history-edit` prompt. */
  bus(): { emit(event: string, payload: { prompt: string }): void }
}

/** Collaborators the submit path needs from the live-area closure. */
export interface DispatchSubmitDeps {
  /** Command registry, or `null` when plugins are disabled. */
  loader: DispatchSubmitHost | null
  /** Writes fully rendered lines to scrollback. */
  writeNoticeLines: (lines: string[]) => void
  /** Live terminal width, read at call time. */
  liveCols: () => number | undefined
  /** Queues a prompt for the next model turn; `source` tags `prompt.submitted`. */
  enqueuePrompt: EnqueuePrompt
  /** Echoes the submitted command line into scrollback with its timestamp. */
  flushCommandLine: (text: string, commitLines: string[], submittedAt: Date) => void
  /** Formatter geometry + raw sink for `/compact` live output. */
  compactStream: CompactStreamDeps
}

/**
 * Dispatch one submitted slash-command line and apply its result.
 *
 * @param deps - Registry, scrollback, queue, and compact-stream collaborators.
 * @param text - Raw submitted line.
 * @param commitLines - Lines to echo for the submission (may be empty).
 * @param submittedAt - Submission time; defaults to now.
 */
export async function dispatchCommandAndApply(
  deps: DispatchSubmitDeps,
  text: string,
  commitLines: string[] = [],
  submittedAt?: Date,
): Promise<void> {
  const loader = deps.loader
  if (!loader) return
  const submittedAtDate = submittedAt ?? new Date()
  deps.flushCommandLine(text, commitLines, submittedAtDate)
  let result: CommandResult | null
  const isCompactCmd = parseCommandLine(text)?.name === "compact"
  const compactStream = isCompactCmd ? createCompactStream(deps.compactStream) : null
  try {
    result = await loader.dispatchCommand(text, {
      cwd: process.cwd(),
      ...(compactStream
        ? { writeStream: compactStream.write, onSummaryAttempt: compactStream.onAttempt }
        : {}),
    })
  } catch (e) {
    deps.writeNoticeLines([`✗ command failed: ${errorText(e)}`])
    return
  } finally {
    await endQuietly(compactStream)
  }
  if (!result) {
    deps.enqueuePrompt(text, commitLines, submittedAt, "command")
    return
  }
  await applyCommandResult(deps, loader, text, result)
}

/**
 * Render one command result into scrollback.
 *
 * @param deps - Scrollback + compact-render collaborators.
 * @param loader - Registry, for the `history-edit` expand announcement.
 * @param text - Raw submitted line (selects the compact renderer).
 * @param result - Result returned by the command handler.
 */
async function applyCommandResult(
  deps: DispatchSubmitDeps,
  loader: DispatchSubmitHost,
  text: string,
  result: CommandResult,
): Promise<void> {
  switch (result.kind) {
    case "expand":
      // The typed `/cmd` line is already in scrollback; the expanded
      // prompt drives the turn with no extra commit lines.
      // The host `/continue` command expands to "": tag it `continue`.
      deps.enqueuePrompt(
        result.prompt,
        [],
        undefined,
        parseCommandLine(text)?.name === "continue" ? "continue" : "expand",
      )
      if (parseCommandLine(text)?.name === "history-edit") {
        loader.bus().emit("history.edit.expanded", { prompt: result.prompt })
      }
      return
    case "notice": {
      const block = result.block
      const rendered =
        block && parseCommandLine(text)?.name === "compact"
          ? await renderCompactNotice(block, deps.compactStream)
          : block
            ? renderCommandNoticeBlock(block, deps.liveCols())
            : []
      deps.writeNoticeLines([...rendered, ...(result.lines ?? [])])
      return
    }
    case "error":
      deps.writeNoticeLines([`✗ ${result.message}`])
      return
    case "none":
      return
    default: {
      throw new Error(`unhandled command result: ${JSON.stringify(result satisfies never)}`)
    }
  }
}
