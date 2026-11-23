/**
 * `--dump <sid|last>` command — print a session transcript to stdout.
 *
 * Reads session data with the `sessions:read` capability (`records(sid)`)
 * and builds the text with the local formatter (`session-dump.ts`). Core
 * returns data only.
 *
 * @module commands/dump
 */

import { inspectSessionArtifacts } from "@minimal-agent/core/host/session-artifacts"
import { resolveSessionTarget } from "@minimal-agent/core/host/session-index"
import { createSessionsReadApi } from "@minimal-agent/core/host/sessions-read"
import { loadSidebandOnly, type SidebandOnlyOptions } from "@minimal-agent/core/host/sideband"
import { defaultSessionsDir } from "@minimal-agent/core/host-kit/session-store"
import { writeStdoutSafely } from "../infra/safe-stdout.ts"
import { formatSessionArtifacts } from "./session-artifacts-format.ts"
import { formatSessionAsMarkdown, formatSessionAsXml } from "./session-dump.ts"
import { pasteFileReader } from "./session-dump-paste.ts"

export interface DumpCommandInput {
  target: string
  format: string
  paths?: boolean
  cwd: string
  /**
   * The plugin roots for the sideband-only boot (no handler import). The
   * codec renders the data-URI stubs. Omitted: core discovery defaults.
   */
  pluginRoots?: SidebandOnlyOptions["roots"]
  /** The sessions dir of the paste files. Omitted: the default sessions dir. */
  sessionsDir?: string
}

/** Thrown for user-facing `dump` failures (bad target, no sessions); the CLI prints the message without a stack. */
export class DumpCommandError extends Error {}

/**
 * Implements the `minimal-agent dump <session>` CLI command: resolves the
 * target (id prefix or "last") to a session, renders the whole transcript as
 * markdown or XML via the sessions read API, and writes it to stdout.
 */
export async function runDumpCommand(input: DumpCommandInput): Promise<void> {
  const sid = resolveSessionTarget(input.target, input.cwd)
  if (!sid) {
    throw new DumpCommandError("no saved sessions found to dump")
  }

  const sessionsDir = input.sessionsDir ?? defaultSessionsDir()
  const sessions = createSessionsReadApi({ dir: sessionsDir })
  const data = await sessions.records(sid)
  if (!data) {
    throw new DumpCommandError(`no session file on disk for sid ${JSON.stringify(sid)}`)
  }
  if (input.paths) await writeStdoutSafely(formatSessionArtifacts(inspectSessionArtifacts(sid)))
  // `dump` has no plugin loader: boot the sideband codec and kinds only, once.
  const sb = await loadSidebandOnly(
    input.pluginRoots === undefined ? {} : { roots: input.pluginRoots },
  )
  // Paste refs show the file text (read only, from the same sessions dir).
  const opts = { readPaste: pasteFileReader(sessionsDir, sid) }
  await writeStdoutSafely(
    input.format === "xml"
      ? formatSessionAsXml(data, sb, opts)
      : formatSessionAsMarkdown(data, sb, opts),
  )
}
