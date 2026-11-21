/**
 * `prompt.submitted` on the live-area REPL path carries `source` (SPEC §6.1):
 * typed text is `user`, the registry-less `/continue` fallback is `continue`,
 * the context-recovery retry is `recovery`, and a `prompt.inject` emit is
 * `inject` (also when the plugin gives its own `source`). The old payload
 * fields stay.
 *
 * `editor.submitted` (the history contract) fires once for each non-blank
 * line typed in the editor, with the raw text, before command dispatch; it
 * never fires for `prompt.inject`, recovery or `/continue`.
 *
 * @module repl-live-area.prompt-source.test
 */

import { afterEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { EventBus } from "@minimal-agent/core/host/event-bus"
import { queueFilePath } from "@minimal-agent/core/host/queue-store"
import { StatusBus } from "@minimal-agent/core/host/status-bus"
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

type Submitted = Record<string, unknown>

/** A plugin-less loader whose bus records `prompt.submitted` and `editor.submitted`. */
async function spyLoader(
  sid: string,
  seen: Submitted[],
  typed: Submitted[],
): Promise<PluginLoader> {
  const missing = join(process.cwd(), "tmp", `no-plugins-${randomUUID()}`)
  const bus = new EventBus()
  const emit = bus.emit.bind(bus)
  bus.emit = ((event: string, payload: unknown) => {
    if (event === "prompt.submitted") seen.push(payload as Submitted)
    if (event === "editor.submitted") typed.push(payload as Submitted)
    return emit(event as never, payload as never)
  }) as typeof bus.emit
  return PluginLoader.load({
    bus,
    sessionId: sid,
    embeddedDir: missing,
    roots: { project: [join(missing, "plugins")] },
    logger: () => {},
  })
}

/** Run the REPL, type (or inject) `line`, wait for the turn(s), then quit. */
async function submitOne(
  line: string,
  agentExtra: Partial<ReplAgentLike> = {},
  how: "type" | "inject" = "type",
) {
  const sid = `ma-psrc-${randomUUID()}`
  sids.push(sid)
  const seen: Submitted[] = []
  const typed: Submitted[] = []
  const runs: string[] = []
  const loader = await spyLoader(sid, seen, typed)
  const agent: ReplAgentLike = {
    pluginLoader: () => loader,
    async *run(text: string) {
      runs.push(text)
      yield "ok\n"
      return { blocks: [], text: "ok\n", stopReason: "end_turn" } as never
    },
    ...agentExtra,
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
  if (how === "inject") {
    loader.bus().emit("prompt.inject", { text: line, source: "cron:abc" })
  } else {
    stdin.send(line)
    stdin.send("\r")
  }
  await new Promise((r) => setTimeout(r, 200))
  stdin.send("\x03")
  stdin.send("\x03")
  await repl
  return { seen, typed, runs, sid }
}

describe("runReplLiveArea prompt.submitted source", () => {
  it("typed text: source 'user', and the old fields stay", async () => {
    const { seen, sid } = await submitOne("hello")
    expect(seen).toEqual([
      { text: "hello", cwd: process.cwd(), sid, exit: "submitted", queuePos: 0, source: "user" },
    ])
  })

  it("prompt.inject emit: source 'inject', not the plugin source", async () => {
    const { seen, runs, sid } = await submitOne("scheduled ping", {}, "inject")
    expect(runs).toEqual(["scheduled ping"])
    expect(seen).toEqual([
      {
        text: "scheduled ping",
        cwd: process.cwd(),
        sid,
        exit: "submitted",
        queuePos: 0,
        source: "inject",
      },
    ])
  })

  it("prompt.inject of a blank text: no prompt.submitted", async () => {
    const { seen, runs } = await submitOne("   ", {}, "inject")
    expect(seen).toEqual([])
    expect(runs).toEqual([])
  })

  it("prompt.inject of '/continue' still goes to the command path", async () => {
    let resumed = 0
    const { seen } = await submitOne(
      "/continue",
      {
        noteSessionResumed: () => {
          resumed++
        },
      },
      "inject",
    )
    expect(resumed).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ text: "", source: "continue" })
  })

  it("/continue fallback (no registry command): source 'continue' with empty text", async () => {
    let resumed = 0
    const { seen } = await submitOne("/continue", {
      noteSessionResumed: () => {
        resumed++
      },
    })
    expect(resumed).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ text: "", exit: "submitted", source: "continue" })
  })

  it("context-recovery retry: source 'recovery' after the user submit", async () => {
    const prev = process.env.MINIMAL_AGENT_AUTO_COMPACT
    delete process.env.MINIMAL_AGENT_AUTO_COMPACT
    let calls = 0
    try {
      const { seen } = await submitOne("hello again", {
        async *run(text: string) {
          calls++
          if (calls === 1) throw new Error("context_length_exceeded: too long")
          yield `ok ${text}\n`
          return { blocks: [], text: "ok\n", stopReason: "end_turn" } as never
        },
        history: () => [{ role: "user", content: "hello again" }] as never,
        compact: async () => ({
          reason: "exceeded" as const,
          kind: "local" as const,
          messagesBefore: 4,
          messagesAfter: 1,
        }),
      })
      expect(seen.map((p) => [p.text, p.source])).toEqual([
        ["hello again", "user"],
        ["hello again", "recovery"],
      ])
      expect(calls).toBe(2)
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_AUTO_COMPACT
      else process.env.MINIMAL_AGENT_AUTO_COMPACT = prev
    }
  })
})

describe("runReplLiveArea editor.submitted (typed input only)", () => {
  it("a typed line emits editor.submitted once, with the raw text", async () => {
    const { typed, sid } = await submitOne("hello")
    expect(typed).toHaveLength(1)
    expect(typed[0]).toEqual({
      text: "hello",
      cwd: process.cwd(),
      sid,
      submittedAt: expect.any(String),
    })
    expect(Number.isNaN(Date.parse(typed[0].submittedAt as string))).toBe(false)
  })

  it("a typed '/cmd args' line is recorded as typed", async () => {
    const { typed, seen } = await submitOne("/plan foo bar")
    expect(typed.map((p) => p.text)).toEqual(["/plan foo bar"])
    expect(seen.map((p) => p.source)).toEqual(["user"])
  })

  it("a typed '/continue' emits the raw line before dispatch, not the expansion", async () => {
    const { typed, seen } = await submitOne("/continue", { noteSessionResumed: () => {} })
    expect(typed.map((p) => p.text)).toEqual(["/continue"])
    expect(seen.map((p) => [p.text, p.source])).toEqual([["", "continue"]])
  })

  it("prompt.inject emits no editor.submitted (prompt.submitted source 'inject')", async () => {
    const { typed, seen } = await submitOne("intercom: 1 message(s) from A1", {}, "inject")
    expect(typed).toEqual([])
    expect(seen.map((p) => p.source)).toEqual(["inject"])
  })

  it("a blank typed line emits nothing", async () => {
    const { typed, seen, runs } = await submitOne("   ")
    expect(typed).toEqual([])
    expect(seen).toEqual([])
    expect(runs).toEqual([])
  })

  it("a recovery retry emits no second editor.submitted", async () => {
    const prev = process.env.MINIMAL_AGENT_AUTO_COMPACT
    delete process.env.MINIMAL_AGENT_AUTO_COMPACT
    let calls = 0
    try {
      const { typed, seen } = await submitOne("retry me", {
        async *run(text: string) {
          calls++
          if (calls === 1) throw new Error("context_length_exceeded: too long")
          yield `ok ${text}\n`
          return { blocks: [], text: "ok\n", stopReason: "end_turn" } as never
        },
        history: () => [{ role: "user", content: "retry me" }] as never,
        compact: async () => ({
          reason: "exceeded" as const,
          kind: "local" as const,
          messagesBefore: 4,
          messagesAfter: 1,
        }),
      })
      expect(seen.map((p) => p.source)).toEqual(["user", "recovery"])
      expect(typed.map((p) => p.text)).toEqual(["retry me"])
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_AUTO_COMPACT
      else process.env.MINIMAL_AGENT_AUTO_COMPACT = prev
    }
  })
})
