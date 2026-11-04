/**
 * CommandSpec for `provider <id> ...`. Data only.
 *
 * There is no `provider` handler module: `normalizeArgs` (cli-args.ts)
 * rewrites each verb to the flag form of another command (login, logout,
 * models, models-live). The spec sits here so every built-in spec lives in
 * `src/commands/` (lead decision 5).
 *
 * @module commands/provider.command
 */

import type { CommandSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { PRINT_FORMAT_FLAG } from "./list-models.command.ts"
import { AUTH_METHOD_FLAG, LOGIN_NAME_FLAG } from "./login.command.ts"

/** `provider <id> ...`. */
export const PROVIDER_COMMAND: CommandSpec = {
  name: "provider",
  group: "auth",
  summary: "Act on one provider",
  usage: ["provider <id> <command>"],
  args: [{ name: "id", summary: "Provider id", required: true }],
  commands: [
    {
      name: "login",
      summary: "Sign in to a provider",
      usage: ["provider <id> login [method]"],
      args: [{ name: "method", summary: "Login method, for example oauth or api-key" }],
      // cli-args.ts consumes only these two flags after `provider <id> login`.
      flags: [LOGIN_NAME_FLAG, AUTH_METHOD_FLAG],
      description: ["Also: login [provider] [method], providers login <id> [method]."],
    },
    {
      name: "logout",
      summary: "Clear one provider's credentials",
      usage: ["provider <id> logout"],
      description: ["Also: logout [provider], providers logout <id>."],
    },
    {
      name: "models",
      summary: "List registered models (offline, no network)",
      usage: ["provider <id> models"],
      flags: [PRINT_FORMAT_FLAG],
    },
    {
      name: "models-live",
      summary: "List live provider catalogs (network)",
      usage: ["provider <id> models-live"],
    },
  ],
}
