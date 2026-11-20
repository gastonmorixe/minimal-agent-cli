/**
 * The terminal host countdown: the {@link CountdownFn} that the CLI gives
 * the plugin loader (`PluginLoaderOptions.countdown`), so a hook handler
 * that calls `ctx.countdown(...)` gets a live status row and an Esc skip.
 *
 * Core has a plain-timer default (`plugins/loader/countdown.ts`). This
 * module adds the terminal UI to the same contract:
 *
 * - A status row in the global status bus (the channel of the spinner and
 *   of the `Running <tool>` row): `<label> · Ns remaining · press Esc to skip`.
 *   The leading pause glyph comes from the live-area status icon (see
 *   {@link HOST_COUNTDOWN_NOTIFICATION_ID} in `src/ui/spinner/presets.ts`).
 *   Thus the label must not have a glyph of its own.
 * - An input capture (the input capture stack) for the life of the wait:
 *   Esc ends the wait with `"skipped"`, and the turn continues. Esc does not
 *   go to the abort-quit state machine while the row shows.
 *
 * The wait ends in one of three ways:
 *
 *  1. `"elapsed"`: the time `ms` passed.
 *  2. `"skipped"`: the user pressed Esc (only with an input capture stack).
 *  3. `"aborted"`: `signal` aborted, also before the call.
 *
 * It never rejects. `ms <= 0` (or a value that is not finite) gives
 * `"elapsed"` at once, with no status row and no capture.
 *
 * @module host/host-countdown
 */

import { GLOBAL_STATUS_BUS, type StatusBus } from "@minimal-agent/core/host/status-bus"
import type {
  CountdownFn,
  CountdownRequest,
  CountdownResult,
} from "@minimal-agent/core/plugin-api/types/plugin"
import { type InputCaptureStack, inputCaptureStack } from "./input/input-capture-stack.ts"

/** The status-bus notification id and input-capture id of a host countdown. */
export const HOST_COUNTDOWN_NOTIFICATION_ID = "host.countdown"

/** The status-bus category of a host countdown. */
export const HOST_COUNTDOWN_CATEGORY = "countdown"

/** The status row text of a countdown with `sec` seconds left. */
export function countdownRowText(label: string, sec: number): string {
  return `${label} · ${sec}s remaining · press Esc to skip`
}

/** The UI parts of a host countdown. Tests give their own. */
export interface HostCountdownDeps {
  /** The live-area status bus of the countdown row. */
  statusBus: StatusBus
  /**
   * The stack that gets the Esc capture. Without it, Esc does not skip the
   * wait: only the time or `signal` ends it.
   */
  inputCaptureStack?: InputCaptureStack
}

/**
 * Make a {@link CountdownFn} that shows its countdown in `deps.statusBus`
 * and skips on Esc through `deps.inputCaptureStack`.
 */
export function createHostCountdown(deps: HostCountdownDeps): CountdownFn {
  return (request) => runHostCountdown(request, deps)
}

/** The CLI host countdown: the global status bus and the global input capture stack. */
export const hostCountdown: CountdownFn = createHostCountdown({
  statusBus: GLOBAL_STATUS_BUS,
  inputCaptureStack,
})

async function runHostCountdown(
  request: CountdownRequest,
  deps: HostCountdownDeps,
): Promise<CountdownResult> {
  const { label, ms, signal } = request
  if (signal?.aborted) return "aborted"
  if (!Number.isFinite(ms) || ms <= 0) return "elapsed"
  const stack = deps.inputCaptureStack
  const totalSec = Math.max(1, Math.ceil(ms / 1000))
  const handle = deps.statusBus.create(countdownRowText(label, totalSec), {
    notificationId: HOST_COUNTDOWN_NOTIFICATION_ID,
    category: HOST_COUNTDOWN_CATEGORY,
  })
  let remaining = totalSec
  const tick = setInterval(() => {
    remaining = Math.max(0, remaining - 1)
    if (remaining > 0) handle.update(countdownRowText(label, remaining))
  }, 1000)
  // The capture stays only for the life of this wait. The `finally` block
  // releases it on each end, so the stack goes back to its prior state.
  let releaseCapture: () => void = () => {}
  let onAbort: () => void = () => {}
  try {
    return await new Promise<CountdownResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const settle = (result: CountdownResult): void => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        resolve(result)
      }
      onAbort = () => settle("aborted")
      timer = setTimeout(() => settle("elapsed"), ms)
      if (signal) signal.addEventListener("abort", onAbort, { once: true })
      if (stack) {
        releaseCapture = stack.push(`${HOST_COUNTDOWN_NOTIFICATION_ID}:${request.id}`, (key) => {
          if (key !== "Escape") return false
          // Esc skips the wait. It does not abort the turn.
          settle("skipped")
          return true
        })
      }
    })
  } finally {
    signal?.removeEventListener("abort", onAbort)
    releaseCapture()
    clearInterval(tick)
    handle.clear()
  }
}
