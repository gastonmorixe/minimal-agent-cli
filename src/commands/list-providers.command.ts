/**
 * CommandSpec for `providers` (handler: `./list-providers.ts`). Data only.
 *
 * The `providers` node also holds the model lists and the login and logout
 * forms (`normalizeArgs`, cli-args.ts). `providers <other>` falls back to the
 * provider list.
 *
 * @module commands/list-providers.command
 */

import type { CommandSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { PROVIDERS_MODELS_COMMAND } from "./list-models.command.ts"
import { PROVIDERS_MODELS_LIVE_COMMAND } from "./list-models-live.command.ts"
import { LOGIN_COMMAND } from "./login.command.ts"
import { LOGOUT_COMMAND } from "./logout.command.ts"

/** `providers login <id> [method]`: the login spec with a provider `id` arg. */
const PROVIDERS_LOGIN_COMMAND: CommandSpec = {
  name: "login",
  summary: LOGIN_COMMAND.summary,
  usage: ["providers login <id> [method]"],
  args: [
    { name: "id", summary: "Provider id", required: true },
    { name: "method", summary: "Login method, for example oauth or api-key" },
  ],
  flags: LOGIN_COMMAND.flags,
}

/** `providers logout <id>`: the logout spec with a provider `id` arg. */
const PROVIDERS_LOGOUT_COMMAND: CommandSpec = {
  name: "logout",
  summary: LOGOUT_COMMAND.summary,
  usage: ["providers logout <id>"],
  args: [{ name: "id", summary: "Provider id", required: true }],
}

/** `providers [list]`. Flag forms: `--list-providers`, `--providers`. */
export const PROVIDERS_COMMAND: CommandSpec = {
  name: "providers",
  group: "discover",
  summary: "List registered providers",
  usage: ["providers [list]"],
  description: ["aliases: --list-providers, --providers"],
  commands: [
    { name: "list", summary: "List registered providers", usage: ["providers list"] },
    PROVIDERS_MODELS_COMMAND,
    PROVIDERS_MODELS_LIVE_COMMAND,
    PROVIDERS_LOGIN_COMMAND,
    PROVIDERS_LOGOUT_COMMAND,
  ],
}
