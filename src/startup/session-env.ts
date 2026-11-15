/**
 * Publish the resolved session values into the environment for plugins.
 *
 * @module startup/session-env
 */

import { defaultBinDir } from "@minimal-agent/core/host/binaries"

/** Resolved values that {@link publishSessionEnv} writes. */
export interface SessionEnvValues {
  readonly model: string
  readonly providerId: string
  readonly endpoint?: string | undefined
  readonly format?: string | undefined
  readonly authType?: string | undefined
  readonly apiKey?: string | undefined
  readonly authHeader?: string | undefined
  readonly providerModel?: string | undefined
  readonly effortLevels?: readonly string[] | undefined
  readonly sessionId: string
  readonly pid: number
  readonly version: string
  readonly agentName?: string | undefined
}

/**
 * Write the `MINIMAL_AGENT_*` session values into `env`.
 *
 * Legacy readers use `process.env`, not `ctx.env`, so the host mirrors the
 * values here. An absent agent name clears `MINIMAL_AGENT_AGENT_NAME`, so the
 * `agent-identity` plugin emits nothing. `MINIMAL_AGENT_BIN_DIR` is always set,
 * so a provisioned binary resolves on a scripted `--prompt` run too.
 */
export function publishSessionEnv(env: NodeJS.ProcessEnv, v: SessionEnvValues): void {
  env.MINIMAL_AGENT_MODEL = v.model
  env.MINIMAL_AGENT_PROVIDER = v.providerId
  if (v.endpoint) env.MINIMAL_AGENT_ENDPOINT = v.endpoint
  if (v.format) env.MINIMAL_AGENT_FORMAT = v.format
  if (v.authType) env.MINIMAL_AGENT_AUTH_TYPE = v.authType
  if (v.apiKey) env.MINIMAL_AGENT_API_KEY = v.apiKey
  if (v.authHeader) env.MINIMAL_AGENT_AUTH_HEADER = v.authHeader
  if (v.providerModel) env.MINIMAL_AGENT_PROVIDER_MODEL = v.providerModel
  if (v.effortLevels && v.effortLevels.length > 0) {
    env.MINIMAL_AGENT_EFFORT_LEVELS = v.effortLevels.join(",")
  }
  env.MINIMAL_AGENT_SESSION_ID = v.sessionId
  env.MINIMAL_AGENT_PID = String(v.pid)
  env.MINIMAL_AGENT_VERSION = v.version
  if (v.agentName) {
    env.MINIMAL_AGENT_AGENT_NAME = v.agentName
  } else {
    delete env.MINIMAL_AGENT_AGENT_NAME
  }
  env.MINIMAL_AGENT_BIN_DIR = defaultBinDir()
}
