/**
 * Load a saved session for `--resume`.
 *
 * `main()` resolves the session id first. This module reads the session
 * JSONL and its optional `<sid>.tasks.jsonl` sidecar. It returns every value
 * the agent seed and the scrollback replay need, plus the `resume` startup
 * row text. It prints nothing. A read error throws, and `main()` reports it.
 *
 * @module startup/resume-load
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { RoundCheckpoint } from "@minimal-agent/core"
import { parseReplaySidecarTasks } from "@minimal-agent/core/host/session-replay-sidecar"
import {
  compactDisplayBoundaries,
  lastTurnRoundCheckpoint,
  loadSession,
} from "@minimal-agent/core/host/session-restore"
import type { SidebandReader } from "@minimal-agent/core/host/sideband"
import { resolveSessionsDir } from "@minimal-agent/core/plugin-api/utils/agent-paths"
import type { Message, ToolUseBlock } from "@minimal-agent/core/sdk/messages"
import { toolDisplaysFromRecords, userTimestampsFromRecords } from "../session-replay.ts"
import type { ReplaySidecarTask } from "../session-replay-derivers.ts"
import { c } from "../ui/style/ansi.ts"

/** Live transcript presentation overrides for one tool result. */
export interface ResumedToolDisplay {
  display?: string
  displayHeader?: string
  displayFooter?: string
}

/** Everything a `--resume` run takes from the saved session. */
export interface ResumeState {
  /** Model-facing history (compact-aware fold). Seeds the new agent. */
  readonly initialMessages: Message[]
  /**
   * Full transcript for UI replay. It ignores durable compact checkpoints,
   * so it can be longer than {@link initialMessages}.
   */
  readonly displayMessages: Message[]
  /** Compact boundaries in the display transcript, for the replay. */
  readonly compactBoundaries: ReturnType<typeof compactDisplayBoundaries>
  /**
   * Trailing user message that was submitted but never got a reply.
   * `loadSession` takes it out of the history, so the API never sees a
   * `[..., user, user]` sequence. The REPL puts it back in the editor.
   */
  readonly pendingDraft: string | null
  /**
   * tool_use_id → epoch ms of the assistant record that held the
   * tool_use block. The replayed tool headers show this time, not the
   * replay time.
   */
  readonly toolStartTimes: Map<string, number>
  /**
   * Per-message timestamps, index-parallel to {@link initialMessages}. The
   * replay stamps each `<mode-change>` chip with them.
   */
  readonly userTimestamps: (Date | null)[]
  /**
   * tool_use_id → live transcript presentation overrides, so plugin
   * renders (Edit's diff, the Tasks tree) survive `--resume`.
   */
  readonly toolDisplays: Map<string, ResumedToolDisplay>
  /**
   * Last round checkpoint of an unfinished turn (S50), or null when the
   * last turn settled. The resumed run never continues that turn by
   * itself: `/continue` in the REPL resumes it at round `round + 1`, and a
   * new message starts a new turn instead.
   */
  readonly roundCheckpoint: RoundCheckpoint | null
  /** Text for the `resume` startup row. */
  readonly banner: string
}

/**
 * The scrollback hint above the editor for a resumed session whose last
 * turn is unfinished. Nothing runs until the user acts.
 *
 * @param checkpoint - the unfinished turn's last round checkpoint.
 * @returns one dim line, with its trailing blank line.
 */
export function unfinishedTurnHint(checkpoint: RoundCheckpoint): string {
  const text = `unfinished turn (stopped after round ${checkpoint.round}) · /continue to resume it, or send a message`
  return `  ${c.dim("──")} ${c.dim(text)} ${c.dim("──")}\n\n`
}

/**
 * Read the saved session `resumeSid` and build its {@link ResumeState}.
 *
 * @param resumeSid - the resolved session id.
 * @param env - environment for the sessions directory lookup.
 * @param sideband - the sideband reader of the loader, for the Task display cut.
 * @returns the resume state. Throws when the session cannot be read.
 */
export function loadResumeState(
  resumeSid: string,
  env: NodeJS.ProcessEnv,
  sideband?: SidebandReader,
): ResumeState {
  const loaded = loadSession(resumeSid)
  const initialMessages = loaded.messages
  const pendingDraft = loaded.pendingDraft

  // The assistant record's `ts` is the moment the live REPL drew the `╭`
  // header. The tool runs shortly after. This is close enough for the
  // "when did this happen" hint.
  const toolStartTimes = new Map<string, number>()
  for (const r of loaded.records) {
    if (r.kind !== "assistant") continue
    const ms = Date.parse(r.ts)
    if (Number.isNaN(ms)) continue
    for (const blk of r.content) {
      if (blk.type === "tool_use") toolStartTimes.set((blk as ToolUseBlock).id, ms)
    }
  }

  // The `<sid>.tasks.jsonl` sidecar lets the Task deriver render old task
  // calls with full styling and per-call status. It is best-effort: a
  // missing or malformed file gives a null sidecar, and the deriver then
  // takes the structural path. `parseReplaySidecarTasks` mirrors the tasks
  // plugin's parser, so the host never imports the plugin.
  const sidecarPath = join(resolveSessionsDir(env), `${resumeSid}.tasks.jsonl`)
  let sidecarTasks: ReplaySidecarTask[] | null = null
  try {
    if (existsSync(sidecarPath)) {
      sidecarTasks = parseReplaySidecarTasks(readFileSync(sidecarPath, "utf8"))
    }
  } catch {
    sidecarTasks = null
  }

  const droppedNote =
    loaded.dropped.length > 0
      ? ` ${c.dim(`(dropped ${loaded.dropped.length} corrupt line(s))`)}`
      : ""
  const repairNote = loaded.repaired ? ` ${c.dim("(repaired trailing turn)")}` : ""
  // Show the draft restore in the startup tree too, so a user who reads
  // only the banner knows why the editor is not empty.
  const draftNote = pendingDraft !== null ? ` ${c.dim("(unsent draft restored)")}` : ""
  const roundCheckpoint = lastTurnRoundCheckpoint(loaded.records)
  const continueNote = roundCheckpoint !== null ? ` ${c.dim("(unfinished turn)")}` : ""
  const banner = `resume ${c.cyan(resumeSid)} ${c.dim(`(${initialMessages.length} message(s))`)}${repairNote}${droppedNote}${draftNote}${continueNote}`

  return {
    initialMessages,
    displayMessages: loaded.displayMessages,
    compactBoundaries: compactDisplayBoundaries(loaded.records),
    pendingDraft,
    toolStartTimes,
    userTimestamps: userTimestampsFromRecords(loaded.records),
    toolDisplays: toolDisplaysFromRecords(loaded.records, {
      sidecarTasks,
      ...(sideband === undefined ? {} : { sideband }),
    }),
    roundCheckpoint,
    banner,
  }
}
