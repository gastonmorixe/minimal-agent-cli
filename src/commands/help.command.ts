/**
 * CommandSpec for `help`. Data only.
 *
 * Help has no handler module in `src/commands/` today: `src/startup/help.ts`
 * renders it. The spec sits here so every built-in spec lives in
 * `src/commands/` (lead decision 5).
 *
 * @module commands/help.command
 */

import type { CommandSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

/** `help [<command>...]`. Same as `-h` and `--help`. */
export const HELP_COMMAND: CommandSpec = {
  name: "help",
  group: "local",
  summary: "Show help for a command",
  usage: ["help [<command>...]"],
  args: [{ name: "command", summary: "Command path, for example sessions dump", variadic: true }],
}
