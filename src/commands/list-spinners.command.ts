/**
 * CommandSpec for `spinners` (handler: `./list-spinners.ts`). Data only.
 *
 * @module commands/list-spinners.command
 */

import type { CommandSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

/** `spinners [list]`. Flag forms: `--list-spinners`, `--spinners`, `--list-spinner`. */
export const SPINNERS_COMMAND: CommandSpec = {
  name: "spinners",
  group: "local",
  summary: "Show available spinner presets",
  usage: ["spinners [list]"],
  description: ["Aliases: --list-spinners, --spinners."],
  commands: [{ name: "list", summary: "Show available spinner presets", usage: ["spinners list"] }],
}
