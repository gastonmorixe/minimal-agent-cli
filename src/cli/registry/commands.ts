/**
 * The built-in command tree (plan M-8a, 2.2).
 *
 * Assembles the specs from `src/commands/*.command.ts` in root help order
 * and adds the root spec. Data only: no handler import.
 *
 * @module cli/registry/commands
 */

import type { CommandSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { AUTH_STATUS_COMMAND } from "../../commands/auth-status.command.ts"
import { HELP_COMMAND } from "../../commands/help.command.ts"
import { FLAGS_COMMAND } from "../../commands/list-flags.command.ts"
import { MODELS_COMMAND } from "../../commands/list-models.command.ts"
import { MODELS_LIVE_COMMAND } from "../../commands/list-models-live.command.ts"
import { PLUGINS_COMMAND } from "../../commands/list-plugins.command.ts"
import { PROVIDERS_COMMAND } from "../../commands/list-providers.command.ts"
import { SPINNERS_COMMAND } from "../../commands/list-spinners.command.ts"
import { LOGIN_COMMAND } from "../../commands/login.command.ts"
import { LOGOUT_COMMAND } from "../../commands/logout.command.ts"
import { PROVIDER_COMMAND } from "../../commands/provider.command.ts"
import { RESUME_COMMAND, RESUME_SAME_COMMAND } from "../../commands/resume.command.ts"
import { SESSIONS_COMMAND } from "../../commands/sessions.command.ts"
import { USAGE_COMMAND } from "../../commands/usage.command.ts"
import { VERSION_COMMAND } from "../../commands/version.command.ts"

/** Program name: the root spec name. */
export const PROGRAM_NAME = "minimal-agent"

/** Top-level built-in commands, in root help order (groups discover, history, auth, local). */
export const BUILTIN_COMMANDS: readonly CommandSpec[] = [
  PROVIDERS_COMMAND,
  MODELS_COMMAND,
  MODELS_LIVE_COMMAND,
  SESSIONS_COMMAND,
  USAGE_COMMAND,
  RESUME_COMMAND,
  RESUME_SAME_COMMAND,
  PROVIDER_COMMAND,
  LOGIN_COMMAND,
  LOGOUT_COMMAND,
  AUTH_STATUS_COMMAND,
  PLUGINS_COMMAND,
  FLAGS_COMMAND,
  SPINNERS_COMMAND,
  VERSION_COMMAND,
  HELP_COMMAND,
]

/** The program node. Root help USAGE and EXAMPLES come from it (spec 8.4). */
export const ROOT_COMMAND: CommandSpec = {
  name: PROGRAM_NAME,
  summary: "A small, inspectable terminal agent harness.",
  usage: ["[flags] [prompt]", "<command> [args] [flags]"],
  args: [{ name: "prompt", summary: "Prompt text, or - to read a prompt from stdin" }],
  examples: [
    { argv: "", summary: "Start the interactive REPL" },
    { argv: '"explain this codebase"', summary: "Run one prompt, then exit" },
    { argv: "-", summary: "Read the prompt from stdin" },
  ],
  commands: [...BUILTIN_COMMANDS],
}
