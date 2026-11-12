/**
 * CommandSpec for `update` (handler: `./update.ts`). Data only.
 *
 * @module commands/update.command
 */

import type { CommandSpec, FlagSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

/** `update` flags, in help order. The handler's parser reads exactly these. */
export const UPDATE_FLAGS: readonly FlagSpec[] = [
  {
    name: "check",
    type: "boolean",
    value: "none",
    summary: "Only report: exit 0 when up to date, 10 when an update is available",
  },
  {
    name: "channel",
    type: "string",
    value: "required",
    valueName: "name",
    choices: ["stable", "nightly"],
    default: "stable",
    summary: "Release channel: stable or nightly",
  },
  {
    name: "to",
    type: "string",
    value: "required",
    valueName: "version",
    summary: "Install this exact version or tag, also an older one",
  },
  {
    name: "rollback",
    type: "boolean",
    value: "none",
    summary: "Put back the binary the last update replaced (<exe>.old)",
  },
]

/** `update [--check] [--channel stable|nightly] [--to <version>] [--rollback] [--json]`. */
export const UPDATE_COMMAND: CommandSpec = {
  name: "update",
  group: "local",
  summary: "Update this binary from the GitHub release (stable or nightly)",
  usage: [
    "update [--check] [--channel stable|nightly] [--json]",
    "update --to <version|tag> [--json]",
    "update --rollback [--json]",
  ],
  description: [
    "Replaces a standalone binary in place: downloads the release asset for this host (os, arch, musl, x64 baseline), checks it against SHA256SUMS, runs the new binary's version --json, then renames it over the current one. The old binary is kept as <exe>.old for --rollback.",
    "A run from source prints git pull instead, and a Homebrew install prints brew upgrade. Neither changes anything.",
    "Releases live on the private gastonmorixe/minimal-agent-cli repo, so a GitHub token is required: MINIMAL_AGENT_GITHUB_TOKEN, GITHUB_TOKEN, GH_TOKEN, or gh auth token.",
    "Plugins are embedded in the binary, so update does not touch plugin dirs. A downgrade needs --to.",
    "Exit codes: 0 ok or nothing to do, 1 failed (the binary is unchanged), 2 bad arguments, 3 no token or no access, 4 no release or no build for this host, 5 directory not writable, 10 update available (--check).",
  ],
  flags: [...UPDATE_FLAGS],
  env: [
    {
      name: "MINIMAL_AGENT_GITHUB_TOKEN",
      summary: "GitHub token for the private release repo (then GITHUB_TOKEN, GH_TOKEN, gh)",
    },
  ],
  examples: [
    { argv: "update --check", summary: "Is a newer stable release out?" },
    { argv: "update --channel nightly", summary: "Install the newest nightly" },
    { argv: "update --to 0.1.0", summary: "Install one version, also an older one" },
    { argv: "update --rollback", summary: "Undo the last update" },
  ],
}
