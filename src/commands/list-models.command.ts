/**
 * CommandSpecs for the offline model list (handler: `./list-models.ts`).
 * Data only.
 *
 * @module commands/list-models.command
 */

import type { CommandSpec, FlagSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

/** `--print-format <text|json|md|xml>`. Only the offline list reads it (run-subcommand.ts). */
export const PRINT_FORMAT_FLAG: FlagSpec = {
  name: "print-format",
  type: "string",
  value: "required",
  valueName: "text|json|md|xml",
  choices: ["text", "json", "md", "xml"],
  default: "text",
  env: "MINIMAL_AGENT_PRINT_FORMAT",
  summary: "Output shape for providers models",
  description: ["The values tui, console, and stdout mean text."],
}

/** `providers models [<id>]`. Flag forms: `--list-models`, `--models`, `--list-model`. */
export const PROVIDERS_MODELS_COMMAND: CommandSpec = {
  name: "models",
  summary: "List registered models (offline, no network)",
  usage: ["providers models [<id>]"],
  args: [{ name: "id", summary: "Only this provider" }],
  flags: [PRINT_FORMAT_FLAG],
  description: ["Also: models [list], provider <id> models.", "Aliases: --list-models, --models."],
}

/** `models [<id>]`, hidden. Same run as {@link PROVIDERS_MODELS_COMMAND}. */
export const MODELS_COMMAND: CommandSpec = {
  name: "models",
  group: "discover",
  hidden: true,
  summary: "List registered models (offline, no network)",
  usage: ["models [<id>]"],
  args: [{ name: "id", summary: "Only this provider" }],
  flags: [PRINT_FORMAT_FLAG],
  commands: [
    {
      name: "list",
      summary: "List registered models (offline, no network)",
      usage: ["models list"],
    },
  ],
  seeAlso: [["providers", "models"]],
}
