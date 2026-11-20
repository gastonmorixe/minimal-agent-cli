/**
 * The concurrency cap of the CLI: the largest number of tool calls that run
 * at the same time in a wave.
 *
 * Precedence (highest wins), with core's one resolver:
 *
 *     env (MINIMAL_AGENT_MAX_CONCURRENT_TOOL_CALLS)  \>  config (maxConcurrentToolCalls)  \>  CLI default
 *
 * Core's own default (1, the serial loop) stays the default of SDK hosts.
 * The CLI replaces it with {@link CLI_DEFAULT_MAX_CONCURRENT_TOOL_CALLS},
 * only when env and config give no valid value. The CLI resolves the cap
 * ONCE (startup/entry-args.ts) and passes it to each route (interactive, event stream, host mode).
 *
 * @module config/concurrency-cap
 */

import {
  MAX_CONCURRENT_TOOL_CALLS_ENV,
  resolveMaxConcurrentToolCalls,
} from "@minimal-agent/core/host/config"

/**
 * The CLI default of the concurrency cap. It applies when the env value and
 * the config value are both absent or not valid.
 */
export const CLI_DEFAULT_MAX_CONCURRENT_TOOL_CALLS = 1

/**
 * Give the concurrency cap of this CLI process. `env` is the process env;
 * `config` is the config.jsonc value `maxConcurrentToolCalls` (core's
 * loader already drops a value that is not valid).
 */
export function resolveCliMaxConcurrentToolCalls(
  env: NodeJS.ProcessEnv,
  config: unknown,
  cliDefault: number = CLI_DEFAULT_MAX_CONCURRENT_TOOL_CALLS,
): number {
  const resolved = resolveMaxConcurrentToolCalls({
    env: env[MAX_CONCURRENT_TOOL_CALLS_ENV],
    config,
  })
  return resolved.source === "default" ? cliDefault : resolved.value
}
