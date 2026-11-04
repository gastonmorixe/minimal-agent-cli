/**
 * CommandSpec for `usage` (handler: `./usage.ts`). Data only.
 *
 * @module commands/usage.command
 */

import type { CommandSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"
import { USAGE_PERIODS } from "@minimal-agent/core/plugin-api/utils/usage-report"

/** `usage [<period>]`. Flag forms: `--usage`, `--usage-stats`. */
export const USAGE_COMMAND: CommandSpec = {
  name: "usage",
  group: "history",
  summary: "Show token usage stats for a period",
  usage: ["usage [<period>]"],
  args: [
    {
      name: "period",
      summary: "Time window of the stats",
      choices: USAGE_PERIODS.map((p) => p.id),
    },
  ],
  description: ["Alias: --usage-stats."],
}
