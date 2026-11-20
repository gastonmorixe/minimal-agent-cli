/**
 * Tests for {@link createHostCountdown}: the three results, the status row,
 * and the input capture of the terminal host countdown.
 *
 *   | Trigger                | Stack? | Result      |
 *   |------------------------|--------|-------------|
 *   | Time elapsed           | n/a    | "elapsed"   |
 *   | Esc through the stack  | yes    | "skipped"   |
 *   | Signal aborts          | yes    | "aborted"   |
 *   | Signal aborted before  | n/a    | "aborted"   |
 *   | ms is 0 or less        | n/a    | "elapsed"   |
 */
import { describe, expect, it } from "bun:test"

import { StatusBus } from "@minimal-agent/core/host/status-bus"
import {
  countdownNotificationId,
  countdownRowText,
  createHostCountdown,
  HOST_COUNTDOWN_CATEGORY,
  HOST_COUNTDOWN_NOTIFICATION_ID,
} from "./host-countdown.ts"
import { InputCaptureStack } from "./input/input-capture-stack.ts"
import { BlinkingNerdSpinner } from "./ui/spinner/blinking-nerd.ts"
import { ICON_PAUSE } from "./ui/spinner/library/icons.ts"
import { DEFAULT_ICON_BY_CATEGORY } from "./ui/spinner/presets.ts"

const CAPTURE_ID = `${HOST_COUNTDOWN_NOTIFICATION_ID}:test.wait`

function setup(withStack = true) {
  const statusBus = new StatusBus()
  const stack = new InputCaptureStack()
  const countdown = createHostCountdown(
    withStack ? { statusBus, inputCaptureStack: stack } : { statusBus },
  )
  return { statusBus, stack, countdown }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("host countdown: results", () => {
  it("ms == 0: elapsed at once, no status row, no capture", async () => {
    const { statusBus, stack, countdown } = setup()
    const start = Date.now()
    expect(await countdown({ id: "test.wait", label: "Wait", ms: 0 })).toBe("elapsed")
    expect(Date.now() - start).toBeLessThan(20)
    expect(statusBus.current()).toBe(null)
    expect(stack.depth()).toBe(0)
  })

  it("signal aborted before the call: aborted, no status row, no capture", async () => {
    const { statusBus, stack, countdown } = setup()
    const ctrl = new AbortController()
    ctrl.abort()
    const result = await countdown({
      id: "test.wait",
      label: "Wait",
      ms: 1000,
      signal: ctrl.signal,
    })
    expect(result).toBe("aborted")
    expect(statusBus.current()).toBe(null)
    expect(stack.depth()).toBe(0)
  })

  it("time elapses: elapsed, the row shows during the wait, then all is released", async () => {
    const { statusBus, stack, countdown } = setup()
    const start = Date.now()
    const wait = countdown({ id: "test.wait", label: "Pause at step 7", ms: 30 })
    await tick(5)
    expect(stack.depth()).toBe(1)
    expect(stack.topId()).toBe(CAPTURE_ID)
    expect(statusBus.current()).toContain(countdownRowText("Pause at step 7", 1))
    expect(await wait).toBe("elapsed")
    expect(Date.now() - start).toBeGreaterThanOrEqual(25)
    expect(stack.depth()).toBe(0)
    expect(statusBus.current()).toBe(null)
  })

  it("Esc through the stack: skipped at once, signal not aborted, capture released", async () => {
    const { statusBus, stack, countdown } = setup()
    const ctrl = new AbortController()
    const start = Date.now()
    const wait = countdown({ id: "test.wait", label: "Wait", ms: 10_000, signal: ctrl.signal })
    await tick(5)
    expect(stack.dispatch("Escape")).toBe(true)
    expect(await wait).toBe("skipped")
    expect(Date.now() - start).toBeLessThan(500)
    expect(ctrl.signal.aborted).toBe(false)
    expect(stack.depth()).toBe(0)
    expect(statusBus.current()).toBe(null)
  })

  it("signal aborts during the wait: aborted, capture released", async () => {
    const { statusBus, stack, countdown } = setup()
    const ctrl = new AbortController()
    const wait = countdown({ id: "test.wait", label: "Wait", ms: 10_000, signal: ctrl.signal })
    await tick(5)
    expect(stack.depth()).toBe(1)
    ctrl.abort()
    expect(await wait).toBe("aborted")
    expect(stack.depth()).toBe(0)
    expect(statusBus.current()).toBe(null)
  })

  it("other keys do not end the wait", async () => {
    const { stack, countdown } = setup()
    const ctrl = new AbortController()
    const wait = countdown({ id: "test.wait", label: "Wait", ms: 10_000, signal: ctrl.signal })
    await tick(5)
    expect(stack.dispatch("Enter")).toBe(false)
    expect(stack.dispatch("Tab")).toBe(false)
    expect(stack.depth()).toBe(1)
    ctrl.abort()
    expect(await wait).toBe("aborted")
    expect(stack.depth()).toBe(0)
  })

  it("no input capture stack: only the time ends the wait", async () => {
    const { statusBus, countdown } = setup(false)
    const wait = countdown({ id: "test.wait", label: "Wait", ms: 20 })
    await tick(5)
    expect(statusBus.current()).toContain("press Esc to skip")
    expect(await wait).toBe("elapsed")
    expect(statusBus.current()).toBe(null)
  })

  it("a later capture goes on top of the countdown capture (LIFO)", async () => {
    const { stack, countdown } = setup()
    const wait = countdown({ id: "test.wait", label: "Wait", ms: 10_000 })
    await tick(5)
    let overlayClaimed = 0
    const overlayOff = stack.push("simulated-overlay", (key) => {
      if (key !== "Escape") return false
      overlayClaimed++
      overlayOff()
      return true
    })
    expect(stack.dispatch("Escape")).toBe(true)
    expect(overlayClaimed).toBe(1)
    expect(stack.topId()).toBe(CAPTURE_ID)
    expect(stack.dispatch("Escape")).toBe(true)
    expect(await wait).toBe("skipped")
    expect(stack.depth()).toBe(0)
  })
})

describe("host countdown: one row for each request", () => {
  it("the notification id has the request id", () => {
    expect(countdownNotificationId("a.b")).toBe("host.countdown:a.b")
  })

  it("the row has the request id and the countdown category", async () => {
    const { statusBus, countdown } = setup()
    const wait = countdown({ id: "test.wait", label: "Wait", ms: 20 })
    await tick(5)
    expect(statusBus.currentStatus()).toMatchObject({
      notificationId: CAPTURE_ID,
      category: HOST_COUNTDOWN_CATEGORY,
    })
    expect(await wait).toBe("elapsed")
  })

  it("two countdowns at the same time: the end of one keeps the row of the other", async () => {
    const { statusBus, stack, countdown } = setup()
    const ctrlA = new AbortController()
    const a = countdown({ id: "a", label: "First", ms: 10_000, signal: ctrlA.signal })
    const ctrlB = new AbortController()
    const b = countdown({ id: "b", label: "Second", ms: 10_000, signal: ctrlB.signal })
    await tick(5)
    expect(stack.depth()).toBe(2)
    expect(statusBus.currentStatus()?.notificationId).toBe("host.countdown:b")
    ctrlB.abort()
    expect(await b).toBe("aborted")
    expect(statusBus.currentStatus()?.notificationId).toBe("host.countdown:a")
    expect(statusBus.current()).toContain("First")
    expect(stack.topId()).toBe("host.countdown:a")
    ctrlA.abort()
    expect(await a).toBe("aborted")
    expect(statusBus.current()).toBe(null)
    expect(stack.depth()).toBe(0)
  })

  it("the spinner still finds the pause glyph by the category", () => {
    expect(DEFAULT_ICON_BY_CATEGORY[HOST_COUNTDOWN_CATEGORY]).toBe(ICON_PAUSE)
    const spinner = new BlinkingNerdSpinner()
    const resolve = (n: { notificationId?: string; category?: string }) =>
      (spinner as unknown as { resolveIcon(c: unknown): unknown }).resolveIcon({
        notification: n,
        theme: {},
      })
    expect(
      resolve({ notificationId: countdownNotificationId("x"), category: HOST_COUNTDOWN_CATEGORY }),
    ).toBe(ICON_PAUSE)
  })
})
