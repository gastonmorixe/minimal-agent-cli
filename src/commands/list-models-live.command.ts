/**
 * CommandSpecs for the live model list (handler: `./list-models-live.ts`).
 * Data only. No `--print-format`: run-subcommand.ts does not pass it.
 *
 * @module commands/list-models-live.command
 */

import type { CommandSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

/** `providers models-live [<id>]`. Flag forms: `--list-models-live`, `--models-live`, `--list-model-live`. */
export const PROVIDERS_MODELS_LIVE_COMMAND: CommandSpec = {
  name: "models-live",
  summary: "List live provider catalogs (network)",
  usage: ["providers models-live [<id>]"],
  args: [{ name: "id", summary: "Only this provider" }],
  description: [
    "also: models-live [list], provider <id> models-live",
    "aliases: --list-models-live, --models-live",
  ],
}

/** `models-live [<id>]`, hidden. Same run as {@link PROVIDERS_MODELS_LIVE_COMMAND}. */
export const MODELS_LIVE_COMMAND: CommandSpec = {
  name: "models-live",
  group: "discover",
  hidden: true,
  summary: "List live provider catalogs (network)",
  usage: ["models-live [<id>]"],
  args: [{ name: "id", summary: "Only this provider" }],
  commands: [
    { name: "list", summary: "List live provider catalogs (network)", usage: ["models-live list"] },
  ],
  seeAlso: [["providers", "models-live"]],
}
