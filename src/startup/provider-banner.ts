import { resolveAgentName } from "@minimal-agent/core/host/agent-identity"
import { describeStartupAuth } from "@minimal-agent/core/host/provider-auth"
import { getSessionId } from "@minimal-agent/core/host/session-id"
import { printStartupHeader, printStartupRow } from "../ui/startup/tree.ts"
import { c } from "../ui/style/ansi.ts"
import { startupAuthText } from "./core-text.ts"
import type { StartupProviderState } from "./provider-boot.ts"

/** Open the session banner only after provider preflight succeeds. Return the name for plugins. */
export function printProviderBanner(
  state: StartupProviderState,
  names: { configName: string | undefined; envName: string | undefined },
  clonedPluginsLabel?: string,
): string | undefined {
  const sessionId = getSessionId()
  const name = resolveAgentName({ sessionId, ...names })
  printStartupHeader()
  printStartupRow("session", c.dim(sessionId))
  if (name) printStartupRow("name", c.dim(name))
  if (clonedPluginsLabel !== undefined) {
    printStartupRow("plugins", `${c.dim("+")} ${c.dim(clonedPluginsLabel)}`)
  }
  const authInfo = describeStartupAuth(state.auth, state.selectedProviderId)
  printStartupRow("auth", startupAuthText(authInfo, c.dim))
  return name
}
