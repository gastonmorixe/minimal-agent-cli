/**
 * CommandSpec for `logout` (handler: `./logout.ts`). Data only.
 *
 * run-subcommand.ts reads only `--provider` (global). `logout <provider>`
 * rewrites to it in `normalizeArgs` (cli-args.ts).
 *
 * @module commands/logout.command
 */

import type { CommandSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

/** `logout [provider]`. Flag form: `--logout`. */
export const LOGOUT_COMMAND: CommandSpec = {
  name: "logout",
  group: "auth",
  summary: "Clear one provider's credentials",
  usage: ["logout [provider]"],
  args: [{ name: "provider", summary: "Provider id" }],
}
