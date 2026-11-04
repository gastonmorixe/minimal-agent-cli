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
  summary: "Token-usage stats",
  usage: ["usage [<period>]"],
  args: [
    {
      name: "period",
      summary: "Time window of the stats",
      choices: USAGE_PERIODS.map((p) => p.id),
    },
  ],
  description: ["today|last-day|last-month|ytd|year|all; alias: --usage-stats"],
}
