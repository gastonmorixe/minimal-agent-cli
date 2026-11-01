import { describe, expect, it } from "bun:test"

import type { AgentEvent } from "@minimal-agent/core/sdk/events"
import { turnEventRenderer } from "./turn-event-render.ts"

describe("turnEventRenderer", () => {
  it("maps each shown event to its handler and ignores the rest", async () => {
    const calls: string[] = []
    const render = turnEventRenderer({
      thinkingStart: () => {
        calls.push("thinking-start")
      },
      thinkingChunk: (chunk) => {
        calls.push(`thinking:${chunk}`)
      },
      thinkingStop: () => {
        calls.push("thinking-stop")
      },
      textStop: () => {
        calls.push("text-stop")
      },
      notice: (notice) => {
        calls.push(`notice:${notice.kind}`)
      },
    })
    const events: AgentEvent[] = [
      { type: "turn_started", turn: 1 },
      { type: "block_started", itemType: "thinking", id: "1:thinking" },
      { type: "thinking_delta", id: "1:thinking", text: "hm" },
      { type: "block_stopped", itemType: "thinking", id: "1:thinking" },
      { type: "block_started", itemType: "text", id: "1:text" },
      { type: "block_stopped", itemType: "text", id: "1:text" },
      { type: "notice", notice: { kind: "max_tokens_salvaged", severity: "warn" } },
      { type: "user_message", text: "queued", queued: true },
      { type: "status", phase: "sending" },
    ]
    for (const event of events) await render(event)
    expect(calls).toEqual([
      "thinking-start",
      "thinking:hm",
      "thinking-stop",
      "text-stop",
      "notice:max_tokens_salvaged",
    ])
  })

  it("returns the handler promise so the pump can wait for it", async () => {
    let done = false
    const render = turnEventRenderer({
      thinkingStart: () => {},
      thinkingChunk: () => {},
      thinkingStop: () => {},
      textStop: async () => {
        await Promise.resolve()
        done = true
      },
      notice: () => {},
    })
    const result = render({ type: "block_stopped", itemType: "text", id: "1:text" })
    expect(result).toBeInstanceOf(Promise)
    await result
    expect(done).toBe(true)
  })

  it("passes the pump's live check to textStop, so a stale end skips its writes", async () => {
    const seen: Array<boolean | undefined> = []
    const render = turnEventRenderer({
      thinkingStart: () => {},
      thinkingChunk: () => {},
      thinkingStop: () => {},
      textStop: (live) => {
        seen.push(live?.())
      },
      notice: () => {},
    })
    await render({ type: "block_stopped", itemType: "text", id: "1:text" }, () => false)
    expect(seen).toEqual([false])
  })
})
