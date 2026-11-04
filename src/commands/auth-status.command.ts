/**
 * CommandSpec for `auth-status` (handler: `./auth-status.ts`). Data only.
 *
 * run-subcommand.ts picks the sub-verb with `args.includes`, so a sub-verb
 * matches at any position. The flags below are the flags each branch reads.
 *
 * @module commands/auth-status.command
 */

import type { CommandSpec, FlagSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { PROVIDER_FLAG } from "../cli/registry/global-flags.ts"

/** `--table` (`args.includes`). */
const TABLE_FLAG: FlagSpec = {
  name: "table",
  type: "boolean",
  value: "none",
  summary: "Print a Markdown pipe table instead of the human rows",
}

/**
 * `--parallel <n>` (`readFlagValue`, default 4, max 8). True arity: required
 * value. It is in neither arity set of extract-prompt.ts (M-12).
 */
const PARALLEL_FLAG: FlagSpec = {
  name: "parallel",
  type: "number",
  value: "required",
  valueName: "n",
  default: 4,
  summary: "Max parallel workers (max 8)",
}

/** `--name <n>`: the credential name. */
const CREDENTIAL_NAME_FLAG: FlagSpec = {
  name: "name",
  type: "string",
  value: "required",
  valueName: "n",
  summary: "Credential name, in place of the positional credential",
}

/** `auth-status [--table]`. Flag form: `--auth-status`. */
export const AUTH_STATUS_COMMAND: CommandSpec = {
  name: "auth-status",
  group: "auth",
  summary: "Show login status, account, scopes, and expiry",
  usage: ["auth-status [--table]"],
  flags: [TABLE_FLAG],
  commands: [
    {
      name: "refresh",
      summary: "Refresh one stored OAuth credential",
      usage: ["auth-status <credential> refresh [--name <n>] [--provider <id>]"],
      args: [{ name: "credential", summary: "Credential name, label, or provider id" }],
      flags: [CREDENTIAL_NAME_FLAG, PROVIDER_FLAG],
    },
    {
      name: "refresh-all",
      summary: "Refresh all stored OAuth credentials (max 8)",
      usage: ["auth-status refresh-all [--parallel <n>]"],
      flags: [PARALLEL_FLAG],
    },
    {
      name: "plan",
      summary: "Show plan, seat, role, and usage limits (spends no quota)",
      usage: ["auth-status plan [<credential>] [--all] [--table] [--parallel <n>]"],
      args: [{ name: "credential", summary: "Only this credential (name, label, or provider id)" }],
      flags: [
        {
          name: "all",
          type: "boolean",
          value: "none",
          summary: "Keep rows for credentials with no plan lookup",
        },
        TABLE_FLAG,
        PARALLEL_FLAG,
        CREDENTIAL_NAME_FLAG,
      ],
    },
    {
      name: "prune",
      summary: "Delete stored credentials the server rejects (dry run lists only)",
      usage: ["auth-status prune --dry-run|--force [--table] [--parallel <n>]"],
      flags: [
        {
          name: "dry-run",
          type: "boolean",
          value: "none",
          summary: "List the credentials to delete, delete nothing",
        },
        {
          name: "force",
          type: "boolean",
          value: "none",
          summary: "Delete the credentials the server rejects",
        },
        TABLE_FLAG,
        PARALLEL_FLAG,
      ],
    },
  ],
}
