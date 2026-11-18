/**
 * What the CLI does when the live target of its ONE session changes (the
 * TUI and host mode: one session for each process). The core does the
 * change itself (`AgentCore.switchTarget`, `setModel`, `setEffort`). This
 * module only follows it, from one place, so no front end does it by hand:
 *
 * - `process.env` gets the new model, provider, credential and effort. The
 *   footer and plugins that read the env see the live values, and a
 *   sub-agent that starts later gets them.
 * - The loader gets the live target, for `ctx.queryTarget()`.
 * - The plugin bus gets one `target.didSwitch` event with `from` and `to`.
 *
 * A host with more sessions in one process (the web host) must not use this
 * module: these values are for the process, not for one session.
 *
 * @module host/startup/live-target
 */

import type { TargetSnapshot } from "@minimal-agent/core/plugin-api/types/plugin"
import type { AgentCore } from "@minimal-agent/core/sdk/agent-core"

import { modelHidesReasoning } from "./provider-presentation.ts"

/** Plugin bus event sent after each change of the live target. */
export const TARGET_DID_SWITCH = "target.didSwitch"

/** Payload of {@link TARGET_DID_SWITCH}. No token and no secret. */
export interface TargetDidSwitchPayload {
  readonly from: TargetSnapshot
  readonly to: TargetSnapshot
}

/** The part of the live core this module uses. */
export type LiveTargetCore = Pick<AgentCore, "getTarget" | "onTargetChange">

/** The part of the plugin loader this module uses. `bus` is absent on a loader with no event bus. */
export interface LiveTargetLoader {
  targetSource?: (() => TargetSnapshot | undefined) | undefined
  bus?(): { emit(event: string, payload: TargetDidSwitchPayload): unknown }
}

/** Options for {@link followLiveTarget}. */
export interface FollowLiveTargetOptions {
  /** The plugin loader, or `null` when plugins are disabled. */
  loader: LiveTargetLoader | null
  /** The env to write. Default: `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Whether a model hides reasoning (then the effort var is removed). Default: the registry. */
  hidesReasoning?: (model: string) => boolean
}

const set = (env: NodeJS.ProcessEnv, key: string, value: string | undefined): void => {
  if (value === undefined || value === "") delete env[key]
  else env[key] = value
}

/**
 * Write the target into the env. The effort var keeps the boot rule
 * (`publishResolvedRequestEnv`): removed for a model that hides reasoning,
 * else the level, or "medium" for the model default.
 */
export function publishTargetEnv(
  env: NodeJS.ProcessEnv,
  target: TargetSnapshot,
  hidesReasoning: (model: string) => boolean = modelHidesReasoning,
): void {
  set(env, "MINIMAL_AGENT_MODEL", target.model)
  set(env, "MINIMAL_AGENT_PROVIDER", target.providerId)
  set(env, "MINIMAL_AGENT_CREDENTIAL_NAME", target.credentialName)
  set(
    env,
    "MINIMAL_AGENT_EFFORT",
    hidesReasoning(target.model) ? undefined : (target.effort ?? "medium"),
  )
}

/**
 * Follow the live target of `core` from now on. Sets the loader's target
 * source at once. Returns the function that stops it.
 */
export function followLiveTarget(core: LiveTargetCore, opts: FollowLiveTargetOptions): () => void {
  const env = opts.env ?? process.env
  const { loader } = opts
  if (loader) loader.targetSource = () => core.getTarget()
  return core.onTargetChange(({ from, to }) => {
    publishTargetEnv(env, to, opts.hidesReasoning)
    loader?.bus?.().emit(TARGET_DID_SWITCH, { from, to })
  })
}
