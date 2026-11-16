/**
 * Arrow scenarios for the live status row, replayed from the activity patches
 * core really sends (2026-11-15 regression).
 *
 * Since core de0a7c5, every attempt publishes block facts on the request's
 * activity (`phase: "connect"` at attempt start, then `stream` / `thinking` /
 * `writing` / `tool-input`). Before that, an entry with no network tracker had
 * no activity at all and the row showed no arrow. Now it has an activity with
 * a phase but no `direction`, and the row painted the neutral `·`:
 *
 *   ● Sending request · (3s)          (expected ↑)
 *   ● Writing response · 9s (11s)     (expected ↓)
 *
 * The network tracker (`NetworkActivityTracker`) only sets `direction` for a
 * NEW HTTP request. A send that reuses an open wire (Cursor's bidi Run: the
 * tool result is written on the stream opened by the previous send) gets no
 * tracker, so `direction` is never set for its row. The phase is still a
 * fact about which way the data goes, so the host derives the arrow from it
 * when no byte direction is known. A measured direction always wins.
 *
 * Each patch below is copied from core's publishers:
 * - `createBlockStatusPublisher().attemptStarted()` → `{ phase: "connect", phaseStartedAt, toolName: null }`
 * - `onBlockState` → `{ phase, phaseStartedAt, lastContentAt, idleBudgetMs, toolName }`
 * - `NetworkActivityTracker.onRequest/onResponse/onChunk/onEnd`
 */

import { describe, expect, it } from "bun:test"
import { StatusBus } from "@minimal-agent/core/host/status-bus"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { createStatusPort } from "../../startup/host-ports.ts"
import type { Spinner } from "../spinner/index.ts"

import { LiveAreaStatusController } from "./live-area-controller.ts"

const spinner: Spinner = {
  willShow: () => undefined,
  didShow: () => undefined,
  willDisappear: () => undefined,
  didDisappear: () => undefined,
  render: () => ({ glyph: "●" }),
}

function rig() {
  const bus = new StatusBus()
  const rows: Array<string | null> = []
  let now = 1_800_000_000_000
  const ctrl = new LiveAreaStatusController(
    bus,
    { setStatus: (t: string | null) => rows.push(t) },
    { spinner, maxFps: 0, now: () => now },
  )
  ctrl.start()
  const port = createStatusPort(bus)
  // An empty patch on a throwaway bottom entry repaints at the current clock
  // without changing the top row (the animation timer does this live).
  const repaint = bus.create("_", {})
  return {
    port,
    ctrl,
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
    row: (): string => {
      repaint.updateActivity({})
      return stripAnsi(rows.at(-1) ?? "")
    },
  }
}

describe("live status arrow — reused wire (no network tracker for this send)", () => {
  it("Sending request shows ↑ while the attempt waits, not ·", () => {
    const r = rig()
    const live = r.port.open({ phase: "sending" })
    live.updateActivity({ phase: "connect", phaseStartedAt: r.now(), toolName: null })
    r.advance(3_000)
    expect(r.row()).toBe("● Sending request ↑ (3s)")
    r.ctrl.stop()
  })

  it("Writing response shows ↓ while text streams, not ·", () => {
    const r = rig()
    const live = r.port.open({ phase: "sending" })
    live.updateActivity({ phase: "connect", phaseStartedAt: r.now(), toolName: null })
    r.advance(2_000)
    live.update({ phase: "receiving" })
    live.updateActivity({
      phase: "writing",
      phaseStartedAt: r.now(),
      lastContentAt: r.now(),
      idleBudgetMs: 30_000,
      toolName: null,
    })
    r.advance(9_000)
    live.updateActivity({ lastContentAt: r.now(), idleBudgetMs: 30_000, toolName: null })
    expect(r.row()).toBe("● Writing response ↓ 9s (11s)")
    r.ctrl.stop()
  })

  it("Reasoning and tool input show ↓ too", () => {
    const r = rig()
    const live = r.port.open({ phase: "receiving" })
    live.updateActivity({ phase: "thinking", phaseStartedAt: r.now(), lastContentAt: r.now() })
    expect(r.row()).toBe("● Reasoning ↓")
    live.updateActivity({ phase: "tool-input", toolName: "Write", phaseStartedAt: r.now() })
    expect(r.row()).toBe("● Streaming Write input ↓")
    r.ctrl.stop()
  })

  it("a silent text block on a reused wire still reads as stalled", () => {
    // With no derived direction, the stall verdict (down-only) never fired here.
    const r = rig()
    const live = r.port.open({ phase: "receiving" })
    live.updateActivity({
      phase: "writing",
      phaseStartedAt: r.now(),
      lastContentAt: r.now(),
      idleBudgetMs: 30_000,
    })
    r.advance(20_000)
    expect(r.row()).toContain("⋯ stalled")
    expect(r.row()).toContain("last output 20s ago")
    r.ctrl.stop()
  })
})

describe("live status arrow — fresh request (network tracker attached)", () => {
  it("upload: ↑ with sent bytes before the response", () => {
    const r = rig()
    const live = r.port.open({ phase: "sending" })
    live.updateActivity({ phase: "connect", phaseStartedAt: r.now(), toolName: null })
    live.updateActivity({
      direction: "up",
      sentBytes: 156_551,
      target: { host: "agentn.global.api5.cursor.sh" },
    })
    live.updateActivity({ target: { protocol: "h2" } })
    expect(r.row()).toBe("● Sending request ↑ 152.9 KB · agentn.global.api5.cursor.sh:h2")
    r.ctrl.stop()
  })

  it("once bytes come down, the row says Receiving stream ↓ (label and arrow agree)", () => {
    // Core now moves the request to `receiving` on the first body chunk of
    // the claimed stream (see canonical-send.test.ts). Before, it waited for
    // `message_start`, which Cursor holds back until the first content event,
    // so the row read "Sending request ↓ 39.3 KB · 20.9 KB/s" for seconds.
    const r = rig()
    const live = r.port.open({ phase: "sending" })
    live.updateActivity({ phase: "connect", phaseStartedAt: r.now(), toolName: null })
    live.updateActivity({ direction: "up", sentBytes: 156_551, target: { host: "h.test" } })
    r.advance(600)
    live.update({ phase: "receiving" })
    live.updateActivity({ direction: "down", recvBytes: 9, lastChunkAt: r.now() })
    r.advance(1_400)
    live.updateActivity({ direction: "down", recvBytes: 40_243, lastChunkAt: r.now() })
    const row = r.row()
    expect(row.startsWith("● Receiving stream ↓ 39.3 KB")).toBe(true)
    r.ctrl.stop()
  })

  it("a measured direction wins over the phase", () => {
    const r = rig()
    const live = r.port.open({ phase: "receiving" })
    live.updateActivity({ phase: "writing", phaseStartedAt: r.now(), lastContentAt: r.now() })
    live.updateActivity({ direction: "idle", recvBytes: 2_048 })
    expect(r.row()).toBe("● Writing response · 2.0 KB")
    r.ctrl.stop()
  })
})
