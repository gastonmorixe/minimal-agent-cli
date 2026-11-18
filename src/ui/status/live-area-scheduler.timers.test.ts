/**
 * Timer tests for `LiveAreaScheduler`: each slot keeps exactly one periodic
 * timer, also when `refreshOn` events fire it off-cycle.
 *
 * Regression: `scheduleNext` armed a new timer and did not clear the pending
 * one. Each `refreshOn` event (and each event dropped while a tick was in
 * flight) left one more self-re-arming chain. After 50 events a slot had 51
 * chains and ran its handler 51 times a second until exit. `ma-tps-plugin`
 * (`llm.outputDelta`) and `ma-quota-status-plugin` (`terminal.resize`)
 * trigger it in normal use.
 */

import { describe, expect, it } from "bun:test"

import { EventBus } from "@minimal-agent/core/host/event-bus"

import { FakeClock, makeSink, makeSlot } from "./live-area-scheduler.fixtures.ts"
import { LiveAreaScheduler } from "./live-area-scheduler.ts"

/** One slot on a 1 s period that also re-fires on `x.event`. */
function rig(invoke: () => Promise<string | null>) {
  const clock = new FakeClock()
  const bus = new EventBus(() => {})
  const slot = makeSlot({ id: "probe", refreshMs: 1000, invoke })
  slot.definition.refreshOn = ["x.event"]
  const sched = new LiveAreaScheduler([slot], makeSink(), {
    bus,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    logger: () => {},
  })
  return { clock, bus, sched }
}

describe("LiveAreaScheduler: one pending timer per slot", () => {
  it("keeps exactly one pending timer after refreshOn events", async () => {
    const { clock, bus, sched } = rig(async () => "row")
    sched.start()
    await clock.tick(10)
    expect(clock.pendingCount()).toBe(1)

    for (let i = 0; i < 50; i++) {
      bus.emit("x.event", {})
      await clock.tick(100)
    }
    expect(clock.pendingCount()).toBe(1)
    sched.stop()
  })

  it("runs the handler once per period when idle, whatever the events before", async () => {
    let runs = 0
    const { clock, bus, sched } = rig(async () => {
      runs++
      return "row"
    })
    sched.start()
    await clock.tick(10)
    for (let i = 0; i < 50; i++) {
      bus.emit("x.event", {})
      await clock.tick(100)
    }
    const before = runs
    await clock.tick(10_000)
    // About 10 periodic runs, not 51 chains x 10.
    expect(runs - before).toBeLessThanOrEqual(11)
    sched.stop()
  })

  it("keeps one pending timer when events arrive while a tick is in flight", async () => {
    let release!: () => void
    let calls = 0
    const { clock, bus, sched } = rig(
      () =>
        new Promise<string | null>((resolve) => {
          calls++
          // The first call stays in flight until released; later calls settle.
          if (calls === 1) release = () => resolve("row")
          else resolve("row")
        }),
    )
    sched.start()
    await clock.tick(0)
    for (let i = 0; i < 20; i++) {
      bus.emit("x.event", {})
      await clock.tick(10)
    }
    release()
    await clock.tick(0)
    expect(clock.pendingCount()).toBe(1)
    sched.stop()
  })

  it("counts the period from the last fire: a steady event stream has no extra periodic run", async () => {
    let runs = 0
    const { clock, bus, sched } = rig(async () => {
      runs++
      return "row"
    })
    sched.start()
    await clock.tick(10)
    expect(runs).toBe(1)

    // 12 events, 400 ms apart: 4.8 s, closer together than the 1 s period.
    for (let i = 0; i < 12; i++) {
      bus.emit("x.event", {})
      await clock.tick(400)
    }
    // One run for each event, and no periodic run between them.
    expect(runs).toBe(13)

    // The periodic run comes back one period after the last fire.
    await clock.tick(1000)
    expect(runs).toBe(14)
    expect(clock.pendingCount()).toBe(1)
    sched.stop()
  })

  it("leaves no pending timer after stop()", async () => {
    const { clock, bus, sched } = rig(async () => "row")
    sched.start()
    await clock.tick(10)
    for (let i = 0; i < 20; i++) {
      bus.emit("x.event", {})
      await clock.tick(100)
    }
    sched.stop()
    expect(clock.pendingCount()).toBe(0)
  })
})
