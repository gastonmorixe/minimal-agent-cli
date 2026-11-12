/**
 * CommandSpec for `version` (handler: `./version.ts`). Data only.
 *
 * @module commands/version.command
 */

import type { CommandSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

/** `version`. Flag forms: `--version`, `-V`. `--json` prints the build info object. */
export const VERSION_COMMAND: CommandSpec = {
  name: "version",
  group: "local",
  summary: "Show the version, commit SHAs, and build info",
  usage: ["version [--json]"],
  description: [
    "Aliases: --version, -V.",
    "Prints one line: semver, cli/core/plugins commits, Bun version, target, build mode, and build date. A run from source shows dev for unknown commits.",
    "No network, no session, no credentials. Exit 0.",
  ],
}
