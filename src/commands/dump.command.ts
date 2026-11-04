/**
 * CommandSpec for `sessions dump` (handler: `./dump.ts`). Data only.
 *
 * @module commands/dump.command
 */

import type { CommandSpec, FlagSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

/** `--dump-format md|xml` (parse-argv.ts reads it with `rawAfter`, default `md`). */
const DUMP_FORMAT_FLAG: FlagSpec = {
  name: "dump-format",
  type: "string",
  value: "required",
  valueName: "md|xml",
  choices: ["md", "xml"],
  default: "md",
  summary: "Output format of the dump",
}

/** `--dump-paths` (parse-argv.ts, `args.includes`). */
const DUMP_PATHS_FLAG: FlagSpec = {
  name: "dump-paths",
  type: "boolean",
  value: "none",
  summary: "Also print the paths of the session files",
}

/** `sessions dump <sid|last>`. Flag form: `--dump <sid|last>`. */
export const DUMP_COMMAND: CommandSpec = {
  name: "dump",
  summary: "Dump a full session history to stdout",
  usage: ["sessions dump <sid|last>"],
  args: [{ name: "sid", summary: "Session id, or last for the newest session", required: true }],
  flags: [DUMP_FORMAT_FLAG, DUMP_PATHS_FLAG],
  description: ["Alias: --dump <sid|last>."],
}
