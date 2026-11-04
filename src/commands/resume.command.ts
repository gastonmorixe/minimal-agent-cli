/**
 * CommandSpecs for `resume` and `resume-same`. Data only.
 *
 * There is no handler module: both run the normal agent path with
 * `resumeArg` (parse-argv.ts). The spec sits here so every built-in spec
 * lives in `src/commands/` (lead decision 5).
 *
 * @module commands/resume.command
 */

import type { ArgSpec, CommandSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

const SID_ARG: ArgSpec = {
  name: "sid",
  summary: "Session id, or last for the newest session",
  required: true,
}

/** `resume <sid|last>`. Flag form: `-r, --resume <sid|last>`. */
export const RESUME_COMMAND: CommandSpec = {
  name: "resume",
  group: "history",
  summary: "Resume a saved session",
  usage: ["resume <sid|last>"],
  args: [SID_ARG],
  // Routes to the agent run, which accepts every run flag (plan M-13 2.4).
  strict: false,
  description: [
    "Also: sessions resume <sid>. Aliases: -r, --resume.",
    "It reuses the credential pin only when the provider matches the session.",
  ],
}

/** `resume-same <sid|last>`. Flag form: `--resume-same-sid <sid|last>`. */
export const RESUME_SAME_COMMAND: CommandSpec = {
  name: "resume-same",
  group: "history",
  summary: "Resume in place, keeping the same session id",
  usage: ["resume-same <sid|last>"],
  args: [SID_ARG],
  // Routes to the agent run, which accepts every run flag (plan M-13 2.4).
  strict: false,
  description: ["Also: sessions resume-same <sid>. Alias: --resume-same-sid."],
}

/** `sessions resume <sid|last>`, the same run as {@link RESUME_COMMAND}. */
export const SESSIONS_RESUME_COMMAND: CommandSpec = {
  name: "resume",
  summary: "Resume a saved session",
  usage: ["sessions resume <sid|last>"],
  args: [SID_ARG],
  // Routes to the agent run, which accepts every run flag (plan M-13 2.4).
  strict: false,
}

/** `sessions resume-same <sid|last>`, the same run as {@link RESUME_SAME_COMMAND}. */
export const SESSIONS_RESUME_SAME_COMMAND: CommandSpec = {
  name: "resume-same",
  summary: "Resume in place, keeping the same session id",
  usage: ["sessions resume-same <sid|last>"],
  args: [SID_ARG],
  // Routes to the agent run, which accepts every run flag (plan M-13 2.4).
  strict: false,
}
