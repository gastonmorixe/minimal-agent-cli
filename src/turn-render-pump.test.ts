import { describe, expect, it } from "bun:test"

import { TurnRenderPump } from "./turn-render-pump.ts"

/** Drain the pump the way the REPL does: one chunk at a time, with an await per chunk. */
async function consume(pump: TurnRenderPump, trace: string[]): Promise<void> {
  for await (const chunk of pump.drain()) {
    trace.push(`text:${chunk}`)
    await Promise.resolve()
  }
}

describe("TurnRenderPump", () => {
  it("runs a step at once when nothing waits before it", () => {
    const pump = new TurnRenderPump()
    const trace: string[] = []
    pump.step(() => {
      trace.push("step")
    })
    expect(trace).toEqual(["step"])
  })

  it("keeps a step behind text that the consumer has not taken yet", async () => {
    const pump = new TurnRenderPump()
    const trace: string[] = []
    pump.text("a")
    pump.step(() => {
      trace.push("stop")
    })
    pump.text("b")
    pump.close()
    await consume(pump, trace)
    expect(trace).toEqual(["text:a", "stop", "text:b"])
  })

  it("holds later text and steps until an async step ends", async () => {
    const pump = new TurnRenderPump()
    const trace: string[] = []
    let finish: (() => void) | undefined
    pump.step(async () => {
      trace.push("end-formatter:begin")
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      trace.push("end-formatter:end")
    })
    pump.step(() => {
      trace.push("tool-row")
    })
    pump.text("next block")
    pump.close()
    const done = consume(pump, trace)
    await Promise.resolve()
    expect(trace).toEqual(["end-formatter:begin"])
    finish?.()
    await done
    expect(trace).toEqual([
      "end-formatter:begin",
      "end-formatter:end",
      "tool-row",
      "text:next block",
    ])
  })

  it("throws the first step failure after the queued items", async () => {
    const pump = new TurnRenderPump()
    const trace: string[] = []
    pump.text("a")
    pump.step(() => {
      throw new Error("render failed")
    })
    pump.text("b")
    pump.close()
    await expect(consume(pump, trace)).rejects.toThrow("render failed")
    expect(trace).toEqual(["text:a", "text:b"])
  })

  it("ends with the close error", async () => {
    const pump = new TurnRenderPump()
    pump.text("a")
    pump.close(new Error("run failed"))
    const trace: string[] = []
    await expect(consume(pump, trace)).rejects.toThrow("run failed")
    expect(trace).toEqual(["text:a"])
  })

  it("runs steps at once and drops text after abandon", () => {
    const pump = new TurnRenderPump()
    const trace: string[] = []
    pump.text("a")
    pump.abandon()
    pump.text("b")
    pump.step(() => {
      trace.push("late row")
    })
    expect(trace).toEqual(["late row"])
  })

  it("resolves idle only after the queued items and the async step end", async () => {
    const pump = new TurnRenderPump()
    const trace: string[] = []
    let finish: (() => void) | undefined
    pump.step(async () => {
      trace.push("stop:begin")
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      trace.push("stop:end")
    })
    pump.step(() => {
      trace.push("tool-row")
    })
    const idle = pump.idle().then(() => {
      trace.push("idle")
    })
    const consumed = consume(pump, trace)
    await Promise.resolve()
    expect(trace).toEqual(["stop:begin"])
    finish?.()
    await idle
    expect(trace).toEqual(["stop:begin", "stop:end", "tool-row", "idle"])
    pump.close()
    await consumed
  })

  it("stops waiting for a step that never ends when the signal aborts", async () => {
    const controller = new AbortController()
    const pump = new TurnRenderPump(controller.signal)
    const trace: string[] = []
    pump.step(() => new Promise<void>(() => {}))
    pump.step(() => {
      trace.push("pending row")
    })
    pump.text("late")
    const idle = pump.idle()
    const consumed = consume(pump, trace)
    setTimeout(() => controller.abort(), 5)
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 1000))
    expect(await Promise.race([consumed.then(() => "ended"), timeout])).toBe("ended")
    expect(await Promise.race([idle.then(() => "idle"), timeout])).toBe("idle")
    // The abort drops the steps and text that waited behind the stuck step.
    expect(trace).toEqual([])
    // A step after the abort runs at once.
    pump.step(() => {
      trace.push("abort notice")
    })
    expect(trace).toEqual(["abort notice"])
  })
})
