/**
 * The host-owned slash commands of the TUI, registered in one call after
 * the session exists: `/compact`, `/continue`, and the target commands
 * (`/provider`, `/credential-name`, `/model`, `/effort`).
 *
 * @module host/commands/host-commands
 */

import type { ResolvedCommand } from "@minimal-agent/core/plugin-api/types/plugin"

import { defaultDiscoverTargets, defaultResolveTargetAuth } from "../startup/host-targets.ts"

import { registerCompactHostCommand } from "./compact.ts"
import { registerContinueHostCommand } from "./continue.ts"
import { registerTargetHostCommands, type TargetCore } from "./target-commands.ts"

/** The agent surface the host commands need. */
export type HostCommandAgent = Parameters<typeof registerCompactHostCommand>[1] &
  Parameters<typeof registerContinueHostCommand>[1] & { agentCore(): TargetCore }

/** Register every host command on `loader`. They need the live `agent`. */
export function registerHostCommands(
  loader: { registerHostCommand(cmd: ResolvedCommand): boolean },
  agent: HostCommandAgent,
): void {
  registerCompactHostCommand(loader, agent)
  registerContinueHostCommand(loader, agent)
  registerTargetHostCommands(loader, {
    core: () => agent.agentCore(),
    discover: defaultDiscoverTargets,
    resolveAuth: defaultResolveTargetAuth,
  })
}
