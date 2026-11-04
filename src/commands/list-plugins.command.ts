/**
 * CommandSpec for `plugins` (handler: `./list-plugins.ts`). Data only.
 *
 * The handler gets the full args and reads the global `--disable-plugin` and
 * `--enable-plugin` flags, so the spec lists them by reference.
 *
 * @module commands/list-plugins.command
 */

import type { CommandSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { DISABLE_PLUGIN_FLAG, ENABLE_PLUGIN_FLAG } from "../cli/registry/global-flags.ts"

/** `plugins [list]`. Flag forms: `--list-plugins`, `--plugins`, `--list-plugin`. */
export const PLUGINS_COMMAND: CommandSpec = {
  name: "plugins",
  group: "local",
  summary: "List installed plugins and their on or off state",
  usage: ["plugins [list]"],
  flags: [DISABLE_PLUGIN_FLAG, ENABLE_PLUGIN_FLAG],
  description: ["Aliases: --list-plugins, --plugins."],
  commands: [
    {
      name: "list",
      summary: "List installed plugins and their on or off state",
      usage: ["plugins list"],
    },
  ],
}
