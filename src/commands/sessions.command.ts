/**
 * CommandSpec for `sessions` (handler: `./sessions.ts`). Data only.
 *
 * @module commands/sessions.command
 */

import type { CommandSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { DUMP_COMMAND } from "./dump.command.ts"
import { SESSIONS_RESUME_COMMAND, SESSIONS_RESUME_SAME_COMMAND } from "./resume.command.ts"

/** `sessions [list|query]`. Flag forms: `--sessions`, `--session`, `--list-sessions`. */
export const SESSIONS_COMMAND: CommandSpec = {
  name: "sessions",
  group: "history",
  summary: "List saved sessions",
  usage: ["sessions [list|query]"],
  args: [{ name: "query", summary: "Fuzzy filter on date, session id, or cwd" }],
  description: ["Aliases: --sessions, --session, --list-sessions."],
  commands: [
    { name: "list", summary: "List saved sessions", usage: ["sessions list"] },
    DUMP_COMMAND,
    SESSIONS_RESUME_COMMAND,
    SESSIONS_RESUME_SAME_COMMAND,
  ],
  examples: [
    { argv: "sessions auth", summary: "sessions that match auth" },
    { argv: "sessions dump last", summary: "dump the newest session" },
  ],
}
