/**
 * `--dump <sid|last>` command — print a session transcript to stdout.
 *
 * Reads session data with the `sessions:read` capability (`records(sid)`)
 * and builds the text with the local formatter (`session-dump.ts`). Core
 * returns data only.
 *
 * @module commands/dump
 */

import { existsSync } from "node:fs"

import { inspectSessionArtifacts } from "@minimal-agent/core/host/session-artifacts"
import {
  readParsedSessionIndex,
  resolveLastSessionSid,
  resolveSidByPrefix,
} from "@minimal-agent/core/host/session-index"
import { createSessionsReadApi } from "@minimal-agent/core/host/sessions-read"
import { loadSidebandOnly, type SidebandOnlyOptions } from "@minimal-agent/core/host/sideband"
import { defaultSessionsDir, sessionFilePath } from "@minimal-agent/core/host-kit/session-store"
import { writeStdoutSafely } from "../infra/safe-stdout.ts"
import { formatSessionArtifacts } from "./session-artifacts-format.ts"
import { formatSessionAsMarkdown, formatSessionAsXml } from "./session-dump.ts"

export interface DumpCommandInput {
  target: string
  format: string
  paths?: boolean
  cwd: string
  /**
   * The plugin roots for the sideband-only boot. The codec renders the
   * data-URI stubs, and the display handlers show the sideband refs (for
   * example a paste). Omitted: core discovery defaults.
   */
  pluginRoots?: SidebandOnlyOptions["roots"]
  /**
   * The sessions dir. The target, the records, the `--dump-paths` list and
   * the display files all come from it. Omitted: the default sessions dir.
   */
  sessionsDir?: string
}

/** Thrown for user-facing `dump` failures (bad target, no sessions); the CLI prints the message without a stack. */
export class DumpCommandError extends Error {}

/**
 * The sid of `target` (an id prefix or `"last"`) in the index of `dir`.
 * The same policy as core `resolveSessionTarget`, which reads only the
 * default sessions dir. A row with no `<sid>.jsonl` in `dir`, or with an
 * unsafe sid, is skipped.
 */
function resolveTarget(target: string, cwd: string, dir: string): string | null {
  const records = readParsedSessionIndex(dir).sessions.filter((rec) => {
    try {
      return existsSync(sessionFilePath(rec.sid, dir))
    } catch {
      return false
    }
  })
  return target === "last"
    ? resolveLastSessionSid(records, cwd)
    : resolveSidByPrefix(target, records)
}

/**
 * Implements the `minimal-agent dump <session>` CLI command: resolves the
 * target (id prefix or "last") to a session, renders the whole transcript as
 * markdown or XML via the sessions read API, and writes it to stdout.
 */
export async function runDumpCommand(input: DumpCommandInput): Promise<void> {
  const sessionsDir = input.sessionsDir ?? defaultSessionsDir()
  const sid = resolveTarget(input.target, input.cwd, sessionsDir)
  if (!sid) {
    throw new DumpCommandError("no saved sessions found to dump")
  }

  const sessions = createSessionsReadApi({ dir: sessionsDir })
  const data = await sessions.records(sid)
  if (!data) {
    throw new DumpCommandError(`no session file on disk for sid ${JSON.stringify(sid)}`)
  }
  if (input.paths) {
    await writeStdoutSafely(formatSessionArtifacts(inspectSessionArtifacts(sid, { sessionsDir })))
  }
  // `dump` has no plugin loader: boot the sideband codec, the kinds and the
  // display handlers only, once. The display host reads from the same dir.
  const sb = await loadSidebandOnly({
    ...(input.pluginRoots === undefined ? {} : { roots: input.pluginRoots }),
    display: { hostOptions: { sessionsDir } },
  })
  const opts = { sid }
  await writeStdoutSafely(
    input.format === "xml"
      ? formatSessionAsXml(data, sb, opts)
      : formatSessionAsMarkdown(data, sb, opts),
  )
}
