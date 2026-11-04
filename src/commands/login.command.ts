/**
 * CommandSpec for `login` (handler: `./login.ts`). Data only.
 *
 * run-subcommand.ts reads `--email` or `--email-hint`, `--provider` (global),
 * `--auth-method`, and `--name`. The positional forms rewrite to these flags
 * in `normalizeArgs` (cli-args.ts).
 *
 * @module commands/login.command
 */

import type { CommandSpec, FlagSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

/** `--auth-method <oauth|api-key>`. */
export const AUTH_METHOD_FLAG: FlagSpec = {
  name: "auth-method",
  type: "string",
  value: "required",
  valueName: "oauth|api-key",
  choices: ["oauth", "api-key"],
  summary: "Choose a login method",
}

/** `--email, --email-hint <address>`. */
export const EMAIL_FLAG: FlagSpec = {
  name: "email",
  aliases: ["email-hint"],
  type: "string",
  value: "required",
  valueName: "address",
  summary: "Pre-fill login email",
}

/** `--name <label>` of login. */
export const LOGIN_NAME_FLAG: FlagSpec = {
  name: "name",
  type: "string",
  value: "required",
  valueName: "label",
  summary: "Label a credential during login",
  description: ["e.g. --name work-account"],
}

/** `login [provider] [method]`. Flag form: `--login`. */
export const LOGIN_COMMAND: CommandSpec = {
  name: "login",
  group: "auth",
  summary: "Sign in to a provider",
  usage: ["login [provider] [method]"],
  args: [
    { name: "provider", summary: "Provider id" },
    { name: "method", summary: "Login method, for example oauth or api-key" },
  ],
  flags: [AUTH_METHOD_FLAG, EMAIL_FLAG, LOGIN_NAME_FLAG],
}
