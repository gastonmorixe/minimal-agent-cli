/**
 * Worker side of the target control channel. A sub-agent that RUNS when its
 * lead switches the target (credential, provider, model, effort) switches in
 * place: it keeps its process, its history and its work.
 *
 * The lead appends signed lines to this worker's control file (plugins
 * `ma-sub-agents-plugin/lib/target-control-lead.ts`). This module polls the
 * file, checks each line (core `plugin-api/utils/target-control`), applies
 * the follow rule, resolves the auth, and calls `switchTarget` on the
 * worker's own core. The core then ends a retry or quota wait, builds the
 * system prompt again, and discards the old thinking.
 *
 * Security. A line can move this worker to an other credential, so:
 * - {@link takeControlEnv} reads the file path and the key from the
 *   environment and REMOVES them, so the worker's own tools (Bash) never
 *   see the key.
 * - A line needs a correct mac (the key is not in the file), the sid of this
 *   worker's lead, and a newer `seq`. A line names only a credential and a
 *   provider that are already stored on this machine: the core checks the
 *   name, and the host resolves the auth from the store.
 * - A line that fails gives one diagnostic with the cause. It never has the
 *   mac, the key or the file text.
 *
 * @module host/startup/target-control-worker
 */

import { closeSync, fstatSync, openSync, readSync, rmSync } from "node:fs"

import type { AuthResult } from "@minimal-agent/core/host/auth"
import { findModelForProvider } from "@minimal-agent/core/host/model-registry"
import {
  type ControlReject,
  type ControlTarget,
  ENV_TARGET_CONTROL_FILE,
  ENV_TARGET_CONTROL_KEY,
  MAX_CONTROL_LINE_BYTES,
  MAX_CONTROL_READ_BYTES,
  readSwitchLines,
  type SwitchTargetLine,
} from "@minimal-agent/core/plugin-api/utils/target-control"
import type { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import type { HookContextEntry } from "@minimal-agent/core/sdk/lifecycle"
import { normalizeModelForAPI } from "@minimal-agent/core/sdk/transport-types"

import { errorText } from "./core-text.ts"
import { defaultResolveTargetAuth } from "./host-targets.ts"
import { followLiveTarget, type LiveTargetLoader } from "./live-target.ts"
import { withSessionContext } from "./session-will-start.ts"

/** Env key the sub-agents plugin sets: the session id of this worker's lead. */
export const ENV_SUBAGENT_LEAD = "MINIMAL_AGENT_SUBAGENT_LEAD"
/** Default poll interval, in ms. */
export const DEFAULT_CONTROL_POLL_MS = 1000

/** What a worker needs for the channel, taken from its environment. */
export interface ControlEnv {
  readonly path: string
  readonly key: string
  readonly lead: string
}

/**
 * Read the control file path, the key and the lead sid from `env`, and
 * remove the path and the key from it. Returns `null` in a process that is
 * not a worker with a control channel. Call it one time, early: after it,
 * no child process of this worker inherits the key.
 */
export function takeControlEnv(env: NodeJS.ProcessEnv = process.env): ControlEnv | null {
  const path = env[ENV_TARGET_CONTROL_FILE]
  const key = env[ENV_TARGET_CONTROL_KEY]
  delete env[ENV_TARGET_CONTROL_FILE]
  delete env[ENV_TARGET_CONTROL_KEY]
  const lead = env[ENV_SUBAGENT_LEAD]
  if (!path || !key || !lead || !/^[0-9a-f]{64}$/.test(key)) return null
  return { path, key, lead }
}

/** What the follow rule asks about the model registry. */
export interface FollowRegistry {
  /** True when `providerId` has `model`. */
  hasModel(providerId: string | undefined, model: string): boolean
  /** True when `model` of `providerId` has the effort level. */
  hasEffort(providerId: string | undefined, model: string, effort: string): boolean
}

/** The follow rule on the real model registry. */
export const REGISTRY_FOLLOW: FollowRegistry = {
  hasModel: (providerId, model) =>
    providerId !== undefined &&
    findModelForProvider(normalizeModelForAPI(model), providerId) !== undefined,
  hasEffort: (providerId, model, effort) =>
    providerId !== undefined &&
    (findModelForProvider(
      normalizeModelForAPI(model),
      providerId,
    )?.capabilities.effort.levels.includes(effort) ??
      false),
}

function sameTarget(a: ControlTarget, b: ControlTarget): boolean {
  return (
    a.credentialName === b.credentialName &&
    a.providerId === b.providerId &&
    a.model === b.model &&
    a.effort === b.effort
  )
}

/**
 * The follow rule for one line: what a worker with the target `own` becomes
 * when its lead goes from `from` to `to`. `null`: the worker does not follow.
 *
 * A worker follows the lead only in the values it shared with the lead:
 *
 * 1. Credential and provider. The worker must use the lead's `from`
 *    credential and provider. If not, the user put it on a different target
 *    on purpose: it does not follow. If yes, it takes the `to` pair.
 * 2. Model. With the lead's `from` model, it takes the `to` model. With a
 *    different model, it keeps it when the new provider has it, else it
 *    takes the `to` model.
 * 3. Effort. With the lead's `from` effort, it takes the `to` effort. With a
 *    different effort, it keeps it. An effort that the new model does not
 *    have becomes the model default.
 */
export function followTarget(
  own: ControlTarget,
  line: Pick<SwitchTargetLine, "from" | "to">,
  registry: FollowRegistry,
): ControlTarget | null {
  const { from, to } = line
  if (own.providerId !== from.providerId || own.credentialName !== from.credentialName) return null
  const model =
    own.model === from.model || !registry.hasModel(to.providerId, own.model) ? to.model : own.model
  const wanted = own.effort === from.effort ? to.effort : own.effort
  const effort =
    wanted !== undefined && registry.hasEffort(to.providerId, model, wanted) ? wanted : undefined
  const next: ControlTarget = {
    ...(to.credentialName !== undefined ? { credentialName: to.credentialName } : {}),
    ...(to.providerId !== undefined ? { providerId: to.providerId } : {}),
    model,
    ...(effort !== undefined ? { effort } : {}),
  }
  return sameTarget(next, own) ? null : next
}

/**
 * The follow rule over several lines, in order: the target after the last
 * one. `null` when the worker follows none of them, or ends where it began.
 * The caller makes ONE switch to the result.
 */
export function followTargets(
  own: ControlTarget,
  lines: readonly Pick<SwitchTargetLine, "from" | "to">[],
  registry: FollowRegistry,
): ControlTarget | null {
  let current = own
  for (const line of lines) current = followTarget(current, line, registry) ?? current
  return sameTarget(current, own) ? null : current
}

/** The part of the worker's core this module uses. */
export type ControlCore = Pick<AgentCore, "getTarget" | "switchTarget">

/** What {@link createControlReader} needs. Injectable, so tests read no auth store. */
export interface ControlReaderDeps {
  core: ControlCore
  /** Resolves the auth for one provider + credential + model from the store. */
  resolveAuth(providerId: string, modelId: string, credentialName?: string): Promise<AuthResult>
  /** One diagnostic line. Never gets the mac, the key or the file text. */
  warn(message: string): void
  /** Says that the worker switched. */
  info?(message: string): void
  registry?: FollowRegistry
}

/** One poll of the control file. */
export interface ControlReader {
  /** Read the new lines and switch when the follow rule says so. Returns true after a switch. */
  poll(): Promise<boolean>
}

const describe = (t: ControlTarget): string =>
  `${t.providerId ?? "(no provider)"}${t.credentialName ? ` · ${t.credentialName}` : ""} · ${t.model} · effort ${t.effort ?? "default"}`

/** Up to `max` new bytes of the file from `offset`, and the file size. `null`: no file. */
function readFrom(
  path: string,
  offset: number,
  max: number,
): { text: Buffer; size: number } | null {
  let fd: number
  try {
    fd = openSync(path, "r")
  } catch {
    return null
  }
  try {
    const { size } = fstatSync(fd)
    // The file became shorter (it was cut): read it again from the start.
    const start = size < offset ? 0 : offset
    const length = Math.min(Math.max(size - start, 0), max)
    const text = Buffer.alloc(length)
    if (length > 0) readSync(fd, text, 0, length, start)
    return { text, size: start + length }
  } finally {
    closeSync(fd)
  }
}

/**
 * A reader for one worker's control file. It keeps the read offset and the
 * last accepted `seq`. A partial last line stays for the next poll. Polls
 * do not overlap.
 */
export function createControlReader(env: ControlEnv, deps: ControlReaderDeps): ControlReader {
  const registry = deps.registry ?? REGISTRY_FOLLOW
  let offset = 0
  let lastSeq = 0
  let busy = false
  const reported = new Set<ControlReject | "switch_failed">()
  const warnOnce = (kind: ControlReject | "switch_failed", message: string): void => {
    if (reported.has(kind)) return
    reported.add(kind)
    deps.warn(message)
  }

  const take = (): SwitchTargetLine[] => {
    const read = readFrom(env.path, offset, MAX_CONTROL_READ_BYTES)
    if (!read) return []
    // `start` is 0 again after the file was cut. The seq rule still rejects its old lines.
    const start = read.size - read.text.length
    const end = read.text.lastIndexOf(0x0a)
    if (end < 0) {
      // No complete line. A "line" longer than the limit is skipped, not kept forever.
      if (read.text.length > MAX_CONTROL_LINE_BYTES) {
        offset = read.size
        warnOnce("too_long", "target control: skipped a line that is too long")
      } else offset = start
      return []
    }
    offset = start + end + 1
    const result = readSwitchLines(read.text.subarray(0, end + 1).toString("utf8"), {
      key: env.key,
      lead: env.lead,
      afterSeq: lastSeq,
    })
    lastSeq = result.lastSeq
    for (const reject of result.rejects) {
      warnOnce(reject, `target control: ignored a line (${reject})`)
    }
    return result.lines
  }

  const poll = async (): Promise<boolean> => {
    if (busy) return false
    busy = true
    try {
      const lines = take()
      if (lines.length === 0) return false
      const own = deps.core.getTarget()
      const next = followTargets(own, lines, registry)
      if (!next) return false
      if (next.providerId === undefined) return false
      try {
        const auth = await deps.resolveAuth(
          next.providerId,
          normalizeModelForAPI(next.model),
          next.credentialName,
        )
        deps.core.switchTarget({
          providerId: next.providerId,
          ...(next.credentialName !== undefined ? { credentialName: next.credentialName } : {}),
          model: next.model,
          effort: next.effort,
          auth,
        })
      } catch (e) {
        warnOnce(
          "switch_failed",
          `target control: cannot follow the lead to ${describe(next)}: ${errorText(e)}`,
        )
        return false
      }
      reported.delete("switch_failed")
      deps.info?.(`target control: followed the lead to ${describe(deps.core.getTarget())}`)
      return true
    } finally {
      busy = false
    }
  }
  return { poll }
}

/** A running watch on the control file. */
export interface ControlWatch {
  /** Stop the timer and remove the control file. */
  stop(): void
}

/**
 * Poll the control file on a timer that never keeps the process alive.
 * `stop` removes the file: a worker that ended needs no more lines.
 */
export function watchTargetControl(
  env: ControlEnv,
  deps: ControlReaderDeps,
  intervalMs: number = DEFAULT_CONTROL_POLL_MS,
): ControlWatch {
  const reader = createControlReader(env, deps)
  const timer = setInterval(() => {
    void reader.poll().catch((e) => deps.warn(`target control: poll failed: ${errorText(e)}`))
  }, intervalMs)
  timer.unref?.()
  return {
    stop: () => {
      clearInterval(timer)
      rmSync(env.path, { force: true })
    },
  }
}

/** The part of a session {@link workerSessionWrapper} uses. */
interface WorkerSession {
  agentCore(): AgentCore
  onClose?(callback: () => void): void
}

/**
 * The session wrapper for `main.ts`. In a worker with a control channel
 * (`control` is not null), the session that the worker runs follows its
 * lead: its core is watched for control lines, and its own target changes go
 * to the env, to `ctx.queryTarget` and to the `target.didSwitch` bus event,
 * so the worker's own sub-agents follow too. The watch stops, and the
 * control file is removed, when the session closes or the process exits.
 *
 * In every other process the wrapper only adds the session context, the same
 * as `withSessionContext`.
 */
export function workerSessionWrapper(
  control: ControlEnv | null,
  loader: LiveTargetLoader | null,
  deps: Pick<ControlReaderDeps, "resolveAuth" | "warn" | "info"> = {
    resolveAuth: defaultResolveTargetAuth,
    warn: (message) => process.stderr.write(`${message}\n`),
    info: (message) => process.stderr.write(`${message}\n`),
  },
): <S extends WorkerSession>(
  lines: readonly HookContextEntry[],
  opening: Promise<S>,
) => Promise<S> {
  return async (lines, opening) => {
    const session = await withSessionContext(lines, opening)
    if (!control) return session
    const core = session.agentCore()
    const unfollow = followLiveTarget(core, { loader })
    const watch = watchTargetControl(control, { ...deps, core })
    const end = (): void => {
      unfollow()
      watch.stop()
    }
    session.onClose?.(end)
    // A one-shot worker exits with no session close: remove the file then too.
    process.once("exit", end)
    return session
  }
}
