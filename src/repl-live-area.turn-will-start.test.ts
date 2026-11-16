/**
 * `turn.willStart` on the live-area REPL path: the payload carries the
 * active agent mode, and the hook context reaches `agent.run` as the
 * `additionalContext` run option (the core puts it after the prompt).
 *
 * @module repl-live-area.turn-will-start.test
 */

import { afterEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { EventBus } from "@minimal-agent/core/host/event-bus"
import { queueFilePath } from "@minimal-agent/core/host/queue-store"
import { StatusBus } from "@minimal-agent/core/host/status-bus"
import type { ModeManager } from "@minimal-agent/core/host-kit/modes"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { EditorController } from "./editor-controller.ts"
import { type ReplAgentLike, runRepl } from "./repl.ts"
import { Compositor } from "./ui/compositor.ts"

class FakeTTYInput extends EventEmitter {
  isTTY = true
  setEncoding(_e: BufferEncoding): this {
    return this
  }
  resume(): this {
    return this
  }
  pause(): this {
    return this
  }
  setRawMode(_v: boolean): this {
    return this
  }
  send(chunk: string): void {
    this.emit("data", chunk)
  }
}

class FakeOutput {
  isTTY = true
  columns = 80
  rows = 24
  write(_chunk: string | Uint8Array): boolean {
    return true
  }
}

const sids: string[] = []
afterEach(() => {
  for (const sid of sids) rmSync(queueFilePath(sid), { force: true })
  sids.length = 0
})

/** A plugin-less loader (missing roots) whose `turn.willStart` chain is replaced. */
async function contextLoader(sid: string, seen: unknown[], ctx: string[]): Promise<PluginLoader> {
  const missing = join(process.cwd(), "tmp", `no-plugins-${randomUUID()}`)
  const real = await PluginLoader.load({
    bus: new EventBus(),
    sessionId: sid,
    embeddedDir: missing,
    roots: { project: [join(missing, "plugins")] },
    logger: () => {},
  })
  const hooks = real.hooks()
  const fakeHooks = new Proxy(hooks, {
    get(target, prop, receiver) {
      if (prop === "emitChain") {
        return async (channel: string, payload: unknown) => {
          if (channel !== "turn.willStart") {
            return target.emitChain(channel as never, payload as never)
          }
          seen.push(payload)
          return { payload, halted: false, additionalContext: ctx }
        }
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === "function" ? v.bind(target) : v
    },
  })
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "hooks") return () => fakeHooks
      const v = Reflect.get(target, prop, receiver)
      return typeof v === "function" ? v.bind(target) : v
    },
  })
}

/** A minimal mode manager: only what the live area reads on this path. */
function fakeModes(activeId: string): ModeManager {
  return {
    hasModes: () => false,
    activeId: () => activeId,
    active: () => null,
    statusLabel: (s: string) => s,
    peekPendingAttachment: () => null,
    subscribe: () => () => {},
    onDeliver: () => () => {},
  } as unknown as ModeManager
}

async function runOneTurn(ctx: string[]) {
  const sid = `ma-tws-${randomUUID()}`
  sids.push(sid)
  const seen: unknown[] = []
  const runs: Array<{ text: string; additionalContext: string[] | undefined }> = []
  const loader = await contextLoader(sid, seen, ctx)
  const agent: ReplAgentLike = {
    pluginLoader: () => loader,
    modes: () => fakeModes("plan"),
    async *run(text: string, opts?: { additionalContext?: string[] }) {
      runs.push({ text, additionalContext: opts?.additionalContext })
      yield "ok\n"
      return { blocks: [], text: "ok\n", stopReason: "end_turn" } as never
    },
  }
  const stdin = new FakeTTYInput()
  const output = new FakeOutput()
  const compositor = new Compositor({ output: output as never })
  const editor = new EditorController({
    exitFn: () => {},
    prompt: "> ",
    continuationPrompt: "  ",
    compositor,
    stdin: stdin as never,
    output: output as never,
  })
  const repl = runRepl(agent, {
    output: output as never,
    statusBus: new StatusBus(),
    statusRenderer: null,
    useLiveArea: true,
    compositor,
    editor,
    sessionId: sid,
  })
  await new Promise((r) => setTimeout(r, 20))
  stdin.send("hello")
  stdin.send("\r")
  await new Promise((r) => setTimeout(r, 120))
  stdin.send("\x03")
  stdin.send("\x03")
  await repl
  return { seen, runs }
}

describe("runReplLiveArea turn.willStart", () => {
  it("passes the active mode and forwards the context as the run's additionalContext", async () => {
    const { seen, runs } = await runOneTurn(["TURN-CTX"])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ text: "hello", agentMode: "plan" })
    expect(runs).toEqual([{ text: "hello", additionalContext: ["TURN-CTX"] }])
  })

  it("no context: the run gets no additionalContext", async () => {
    const { runs } = await runOneTurn([])
    expect(runs).toEqual([{ text: "hello", additionalContext: [] }])
  })
})
