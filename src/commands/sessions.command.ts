/**
 * CommandSpec for `sessions` (handler: `./sessions.ts`). Data only.
 *
 * `--model` and `--json` are global flags (`cli/registry/global-flags.ts`).
 * The list reads them too, so they are in the description and not in
 * `flags` (a long form must be unique across the globals plus one path).
 *
 * @module commands/sessions.command
 */

import type { CommandSpec, FlagSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { DUMP_COMMAND } from "./dump.command.ts"
import { SESSIONS_RESUME_COMMAND, SESSIONS_RESUME_SAME_COMMAND } from "./resume.command.ts"

/** The list flags (`parseSessionsFlags` in `./sessions.ts`). */
const SESSIONS_LIST_FLAGS: FlagSpec[] = [
  {
    name: "limit",
    type: "number",
    value: "required",
    valueName: "n",
    default: 30,
    summary: "Lead sessions per page",
  },
  {
    name: "page",
    type: "number",
    value: "required",
    valueName: "n",
    default: 1,
    summary: "Page number (1 is the newest page)",
  },
  {
    name: "all",
    type: "boolean",
    value: "none",
    summary: "Also show hidden sessions (empty, backup, test, orphan sub-agent)",
  },
  {
    name: "since",
    type: "string",
    value: "required",
    valueName: "age|date",
    summary: "Only sessions started after this age (30m, 12h, 2d, 1w) or date",
  },
  {
    name: "cwd",
    type: "string",
    value: "required",
    valueName: "dir",
    summary: "Only sessions started in this directory (. is this directory)",
  },
  {
    name: "subagents",
    type: "string",
    value: "required",
    valueName: "mode",
    choices: ["none", "tree", "flat"],
    default: "tree",
    summary: "Show sub-agent sessions as a tree under the lead, flat, or not",
  },
  {
    name: "backfill-lineage",
    type: "boolean",
    value: "none",
    summary: "Link old sub-agent sessions to their lead (with --dry-run: count only)",
  },
]

/** `sessions [list|<sid>|<query>]`. Flag forms: `--sessions`, `--session`, `--list-sessions`. */
export const SESSIONS_COMMAND: CommandSpec = {
  name: "sessions",
  group: "history",
  summary: "List saved sessions",
  usage: [
    "sessions [list|<query>] [--limit <n>] [--page <n>] [--all]",
    "sessions [<query>] [--since <age>] [--cwd <dir>] [--json]",
    "sessions <sid|last> [--json]",
    "sessions --backfill-lineage [--dry-run] [--since <age>] [--json]",
  ],
  args: [
    { name: "sid", summary: "Session id, 4+ hex prefix, or last: show one session in detail" },
    {
      name: "query",
      summary: "Else: text in the session id, cwd, model, or the title when known",
    },
  ],
  flags: SESSIONS_LIST_FLAGS,
  description: [
    "Newest last, by day. Sub-agent sessions show under their lead session.",
    "sessions <sid>: one session with its sub-agent tree and timeline. A prefix that starts more than one id lists the matches.",
    "A word of 4+ hex characters (dashes allowed, for example face or 2026-05) that starts a session id is a sid, not a text query: one match opens the detail, more list the matches. With no match it is a text query.",
    "A text query matches the session id, cwd, and model. It matches the title only when the index has a saved summary for the session (the list and the detail view save one when they compute the summary).",
    "A saved title (from ma-title-plugin or a user, in index-meta.jsonl) shows in place of the first prompt, in the list and in the detail view. A dim ✦ marks an AI title. A text query also matches the saved title. The title cost is not in the session cost or in /usage.",
    "sessions last: the same session as sessions resume last (the newest in this directory, else the newest).",
    "The detail view can save the computed summary of the session to the index, as the list does.",
    "--model <text>: only sessions whose model has this text (full model id).",
    "--json: version 1; the raw catalog rows (full model ids, children), newest last. Each row also has title (the shown title), titleSource (user, ai or derived; only for a saved title) and prompt (the first prompt).",
    "--backfill-lineage: find the lead of old sub-agent sessions (saved before the index had a lead id) from the lead transcript or the parent pid, and append lineage lines to index-meta.jsonl. It prints the counts. With --dry-run it writes nothing. A session with 0 or 2+ possible leads is skipped.",
    "Resume one with: ma sessions resume <sid>.",
    "Aliases: --sessions, --session, --list-sessions.",
  ],
  commands: [
    { name: "list", summary: "List saved sessions", usage: ["sessions list"] },
    DUMP_COMMAND,
    SESSIONS_RESUME_COMMAND,
    SESSIONS_RESUME_SAME_COMMAND,
  ],
  examples: [
    { argv: "sessions", summary: "the 30 newest sessions" },
    {
      argv: "sessions auth",
      summary: "sessions that have auth in the id, cwd, model, or known title",
    },
    {
      argv: "sessions --since 2d --cwd .",
      summary: "sessions of the last 2 days in this directory",
    },
    { argv: "sessions --limit 10 --page 2", summary: "sessions 11 to 20, counted from the newest" },
    { argv: "sessions e5fc350a", summary: "one session, its sub-agent tree and timeline" },
    { argv: "sessions last", summary: "the resume last session, in detail" },
    {
      argv: "sessions --backfill-lineage --dry-run",
      summary: "count the old sub-agent sessions that can be linked to a lead",
    },
    { argv: "sessions resume last", summary: "resume the newest session" },
    { argv: "sessions dump last", summary: "dump the newest session" },
  ],
}
