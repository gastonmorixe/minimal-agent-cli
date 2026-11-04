/**
 * CommandSpec for `flags` (handler: `./list-flags.ts`). Data only.
 *
 * @module commands/list-flags.command
 */

import type { CommandSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

/** `flags [list]`. Flag forms: `--list-flags`, `--flags`, `--list-flag`. */
export const FLAGS_COMMAND: CommandSpec = {
  name: "flags",
  group: "local",
  summary: "Show beta feature flags",
  usage: ["flags [list]"],
  description: ["aliases: --list-flags, --flags"],
  commands: [{ name: "list", summary: "Show beta feature flags", usage: ["flags list"] }],
}
