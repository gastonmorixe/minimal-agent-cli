/**
 * Contract tests for the Tier-2 interactive host facade.
 *
 * These tests intentionally exercise the real `buildAgentCore` wiring rather
 * than replacing the underlying AgentCore. The session owns interactive-only
 * behavior, while the engine stays usable by headless hosts.
 *
 * Interactive-only behavior is injected through deterministic host seams, so
 * routing and reflection policy can be characterized without timers or TUI
 * singletons.
 */

import { afterEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "@minimal-agent/core/host/auth"
import {
  clearModelRegistry,
  type ModelEntry,
  registerModel,
} from "@minimal-agent/core/host/model-registry"
import type { BuildAgentCoreDeps } from "@minimal-agent/core/host-kit/build-agent-core"
import type { ModeManager } from "@minimal-agent/core/host-kit/modes"
import type { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import type { Message } from "@minimal-agent/core/sdk/messages"
import {
  InteractiveSession,
  type ReflectionCheckpointContext,
  TranscriptRouter,
} from "./interactive-session.ts"
import { turnNoticePlainText } from "./startup/turn-notice-text.ts"
import type {
  TestSendParams as SendOptions,
  TestSendResult as StreamedResponse,
} from "./test-utils/transport-types.ts"

function fakeModel(id: string): ModelEntry {
  return {
    id,
    providerId: "interactive-session-test-prov",
    surfaceId: "custom",
    displayName: id,
    capabilities: defaultCapabilities(),
    pricing: {
      inputUSD: 0,
      outputUSD: 0,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  }
}

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

type RunOptions = NonNullable<Parameters<InteractiveSession["run"]>[1]>

function response(
  text: string,
  stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn",
): StreamedResponse {
  return {
    blocks: text.length > 0 ? [{ type: "text", text }] : [],
    text,
    stopReason,
  } as StreamedResponse
}

async function drain(gen: AsyncGenerator<string, StreamedResponse, undefined>): Promise<string> {
  let text = ""
  for (;;) {
    const next = await gen.next()
    if (next.done) return text
    text += next.value
  }
}

function baseDeps(sendFn: BuildAgentCoreDeps["sendFn"]): BuildAgentCoreDeps {
  return {
    auth: AUTH,
    model: "test-model",
    sendFn,
    loader: null,
    modeManager: null,
    store: null,
    blobStore: null,
    saveEcho: null,
    turnAttachments: [],
  }
}

async function createSession(sendFn: BuildAgentCoreDeps["sendFn"]): Promise<InteractiveSession> {
  return InteractiveSession.create(baseDeps(sendFn))
}

describe("InteractiveSession", () => {
  afterEach(() => {
    clearModelRegistry()
  })

  it("creates through real host wiring and exposes public facade behavior", async () => {
    registerModel(fakeModel("other-model"))
    const loader = {
      getPromptBlockAsync: async () => null,
      getExtraTools: () => [],
      getToolAliases: () => new Map<string, string>(),
      hasTool: () => false,
    } as unknown as PluginLoader
    const activeMode = { id: "focus" }
    const modes = {
      active: () => activeMode,
      activeId: () => activeMode.id,
      consumePendingAttachment: () => null,
    } as unknown as ModeManager
    const requestMessages: Message[][] = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      requestMessages.push(structuredClone(opts.messages) as Message[])
      yield "ok"
      return response("ok")
    }
    const session = await InteractiveSession.create({
      ...baseDeps(sendFn),
      loader,
      modeManager: modes,
    })

    expect(session.agentCore()).toBeDefined()
    expect(session.pluginLoader()).toBe(loader)
    expect(session.modes()).toBe(modes)
    expect(session.getActiveMode()).toBe(activeMode)
    expect(session.getModel()).toBe("test-model")
    session.setModel("other-model")
    expect(session.getModel()).toBe("other-model")

    session.notePreviousTurnAborted()
    await drain(session.run("after abort"))
    session.noteSessionResumed()
    await drain(session.run(""))

    expect(session.history()).toHaveLength(4)
    expect(JSON.stringify(requestMessages[0])).toContain("turn-aborted")
    expect(JSON.stringify(requestMessages[1])).toContain("session-resumed")
    expect(session.rollbackPendingTurn()).toBe(false)
  })

  it("renders thinking, block edges, and notices from session events, in log order", async () => {
    let round = 0
    const transportOptions: SendOptions[] = []
    const trace: string[] = []
    const controller = new AbortController()
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      transportOptions.push(opts)
      round++
      await opts.onBlockEdge?.({ block: "thinking", edge: "start" })
      await opts.onThinkingDelta?.(`thought-${round}`)
      await opts.onBlockEdge?.({ block: "thinking", edge: "stop" })
      if (round === 1) {
        await opts.onBlockEdge?.({ block: "text", edge: "stop" })
        return {
          blocks: [{ type: "tool_use", id: "unknown", name: "NoSuchTool", input: {} }],
          text: "",
          stopReason: "max_tokens",
        } as StreamedResponse
      }
      yield "done"
      await opts.onBlockEdge?.({ block: "text", edge: "stop" })
      return response("done")
    }
    const session = await createSession(sendFn)
    const opts: RunOptions = {
      onEvent: (event) => {
        switch (event.type) {
          case "thinking_delta":
            trace.push(event.text)
            return
          case "block_started":
          case "block_stopped":
            trace.push(`${event.type}:${event.itemType}`)
            return
          case "notice":
            trace.push(`notice:${event.notice.kind}`)
            return
          default:
            return
        }
      },
      signal: controller.signal,
    }

    const gen = session.run("go", opts)
    for (;;) {
      const next = await gen.next()
      if (next.done) break
      trace.push(`text:${next.value}`)
    }

    expect(trace).toEqual([
      "block_started:thinking",
      "thought-1",
      "block_stopped:thinking",
      "block_stopped:text",
      "notice:max_tokens_salvaged",
      "block_started:thinking",
      "thought-2",
      "block_stopped:thinking",
      "text:done",
      "block_stopped:text",
    ])
    expect(transportOptions).toHaveLength(2)
    // `Session.run()` wraps the caller's `signal` in its own AbortController
    // (so `session.abort()` can also stop the run) and forwards THAT wrapper
    // to the transport, not the caller's raw signal object. Every round of
    // one run shares the one wrapper, and aborting the caller's controller
    // still aborts it.
    const forwardedSignal = transportOptions[0]?.signal
    expect(forwardedSignal).toBeInstanceOf(AbortSignal)
    for (const invocation of transportOptions) {
      expect(invocation.signal).toBe(forwardedSignal)
    }
    expect(forwardedSignal?.aborted).toBe(false)
    controller.abort()
    expect(forwardedSignal?.aborted).toBe(true)
  })

  it("feeds queued user text through the inputQueue port of the run", async () => {
    let round = 0
    const sent: Message[][] = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      sent.push(structuredClone(opts.messages) as Message[])
      round++
      if (round === 1) {
        return {
          blocks: [{ type: "tool_use", id: "unknown", name: "NoSuchTool", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "done"
      return response("done")
    }
    const session = await createSession(sendFn)
    const queued: string[] = []
    const injected: string[] = []
    let pending: string | null = "queued prompt"

    await drain(
      session.run("go", {
        inputQueue: {
          take: () => {
            const text = pending
            pending = null
            return text
          },
          injected: (text) => injected.push(text),
        },
        onEvent: (event) => {
          if (event.type === "user_message" && event.queued) queued.push(event.text)
        },
      }),
    )
    // A later run without a queue takes nothing.
    pending = "not taken"
    await drain(session.run("again"))

    expect(injected).toEqual(["queued prompt"])
    expect(queued).toEqual(["queued prompt"])
    expect(JSON.stringify(sent[1])).toContain("queued prompt")
    expect(JSON.stringify(sent.at(-1))).not.toContain("not taken")
  })

  it("writes a plain notice line to the transcript when the run has no onEvent", async () => {
    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) return response("", "max_tokens")
      yield "done"
      return response("done")
    }
    const session = await createSession(sendFn)
    const transcript: string[] = []
    await drain(session.run("go", { onTranscriptLine: (line) => transcript.push(line) }))
    expect(transcript).toHaveLength(1)
    const [line] = transcript
    expect(line?.startsWith("\n  [max_tokens]")).toBe(true)
    expect(line).toContain("auto-continuing (1/")
    // The same plain text core gives every text host.
    expect(line?.slice(3)).toBe(
      turnNoticePlainText({
        kind: "max_tokens_continuing",
        severity: "warn",
        attempt: 1,
        cap: Number(line?.match(/\(1\/(\d+)\)/)?.[1]),
      }),
    )
  })

  it("keeps a tool row behind an async block-stop step", async () => {
    let round = 0
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        yield "before tool"
        await opts.onBlockEdge?.({ block: "text", edge: "stop" })
        return {
          blocks: [
            { type: "text", text: "before tool" },
            { type: "tool_use", id: "unknown", name: "NoSuchTool", input: {} },
          ],
          text: "before tool",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "after"
      return response("after")
    }
    const session = await createSession(sendFn)
    const trace: string[] = []
    const gen = session.run("go", {
      onTranscriptLine: (line) => {
        if (line.includes("NoSuchTool")) trace.push("tool-row")
      },
      onEvent: async (event) => {
        if (event.type !== "block_stopped") return
        trace.push("stop:begin")
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        trace.push("stop:end")
      },
    })
    for (;;) {
      const next = await gen.next()
      if (next.done) break
      trace.push(`text:${next.value}`)
    }
    const firstRow = trace.indexOf("tool-row")
    expect(trace.slice(0, 3)).toEqual(["text:before tool", "stop:begin", "stop:end"])
    expect(firstRow).toBeGreaterThan(2)
    expect(trace.at(-1)).toBe("text:after")
  })

  it("shows a queue echo after the tool rows and text that come before it", async () => {
    let round = 0
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        yield "before tool"
        await opts.onBlockEdge?.({ block: "text", edge: "stop" })
        return {
          blocks: [
            { type: "text", text: "before tool" },
            { type: "tool_use", id: "unknown", name: "NoSuchTool", input: {} },
          ],
          text: "before tool",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "after"
      return response("after")
    }
    const session = await createSession(sendFn)
    const trace: string[] = []
    let pending: string | null = "queued prompt"
    const gen = session.run("go", {
      onTranscriptLine: (line) => {
        if (line.includes("NoSuchTool")) trace.push("tool-row")
      },
      onEvent: async (event) => {
        if (event.type !== "block_stopped") return
        trace.push("stop:begin")
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        trace.push("stop:end")
      },
      inputQueue: {
        // The REPL takes the queue like this: it writes the echo through
        // the session, so the echo keeps its place in the turn.
        take: () => {
          const text = pending
          pending = null
          if (text !== null) session.renderInOrder(() => trace.push("queue-echo"))
          return text
        },
      },
    })
    for (;;) {
      const next = await gen.next()
      if (next.done) break
      trace.push(`text:${next.value}`)
    }
    const echo = trace.indexOf("queue-echo")
    expect(trace.slice(0, 3)).toEqual(["text:before tool", "stop:begin", "stop:end"])
    expect(echo).toBeGreaterThan(trace.lastIndexOf("tool-row"))
    expect(trace.at(-1)).toBe("text:after")
    // With no run in progress, a step runs at once.
    session.renderInOrder(() => trace.push("idle-step"))
    expect(trace.at(-1)).toBe("idle-step")
  })

  it("waits for the render steps before the reflection cooldown starts", async () => {
    let invocation = 0
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      invocation++
      if (invocation <= 50) {
        if (invocation === 50) {
          yield "text 50"
          await opts.onBlockEdge?.({ block: "text", edge: "stop" })
        }
        return {
          blocks: [{ type: "tool_use", id: `tool-${invocation}`, name: "NoSuchTool", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      return response("done")
    }
    const trace: string[] = []
    const session = await InteractiveSession.create({
      ...baseDeps(sendFn),
      reflectionCheckpoint: {
        async wait() {
          trace.push("checkpoint")
        },
      },
    })
    await drain(
      session.run("go", {
        onTranscriptLine: (line) => {
          if (line.includes("NoSuchTool")) trace.push("tool-row")
        },
        onEvent: async (event) => {
          if (event.type !== "block_stopped") return
          trace.push("stop:begin")
          await new Promise<void>((resolve) => setTimeout(resolve, 5))
          trace.push("stop:end")
        },
      }),
    )
    const checkpoint = trace.indexOf("checkpoint")
    expect(checkpoint).toBeGreaterThan(trace.indexOf("stop:end"))
    expect(checkpoint).toBeGreaterThan(trace.lastIndexOf("tool-row"))
  })

  it("ends the turn on abort while a render step never ends", async () => {
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      yield "before"
      await opts.onBlockEdge?.({ block: "text", edge: "stop" })
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
      yield "after"
      return response("before after")
    }
    const session = await createSession(sendFn)
    const controller = new AbortController()
    const running = drain(
      session.run("go", {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type !== "block_stopped") return Promise.resolve()
          // The step is stuck, and later text waits behind it, when the
          // user aborts.
          setTimeout(() => controller.abort(), 40)
          return new Promise<void>(() => {})
        },
      }),
    ).then(
      () => "ended",
      () => "ended",
    )
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 2000))
    expect(await Promise.race([running, timeout])).toBe("ended")
  })

  it("restores transcript routing across sequential leases, throws, aborts, and early close", () => {
    const fallback: string[] = []
    const first: string[] = []
    const second: string[] = []
    const router = new TranscriptRouter((line) => fallback.push(line))

    const runWithLease = (writer: (line: string) => void, outcome: "return" | "throw"): void => {
      const release = router.acquire(writer)
      try {
        router.write(outcome)
        if (outcome === "throw") throw new Error("failed")
      } finally {
        release()
      }
    }

    runWithLease((line) => first.push(line), "return")
    router.write("after return")
    expect(() => runWithLease(() => {}, "throw")).toThrow("failed")
    router.write("after throw")

    const abort = new AbortController()
    const releaseAbort = router.acquire((line) => second.push(line))
    try {
      abort.abort()
      router.write(abort.signal.aborted ? "aborted" : "live")
    } finally {
      releaseAbort()
    }
    router.write("after abort")

    const releaseEarly = router.acquire((line) => second.push(line))
    releaseEarly()
    router.write("after early close")

    expect(first).toEqual(["return"])
    expect(second).toEqual(["aborted"])
    expect(fallback).toEqual(["after return", "after throw", "after abort", "after early close"])
  })

  it("rejects overlapping transcript leases without disturbing the active route", () => {
    const routed: string[] = []
    const router = new TranscriptRouter()
    const release = router.acquire((line) => routed.push(line))
    expect(() => router.acquire()).toThrow("already has an active run")
    router.write("still active")
    release()
    expect(routed).toEqual(["still active"])
  })

  it("releases run routing when the consumer closes the generator early", async () => {
    let invocation = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      invocation++
      yield `chunk-${invocation}`
      return response(`chunk-${invocation}`)
    }
    const fallback: string[] = []
    const session = await InteractiveSession.create({
      ...baseDeps(sendFn),
      writeTranscript: (line) => fallback.push(line),
    })

    const first = session.run("first", { onTranscriptLine: () => {} })
    expect(await first.next()).toEqual({ done: false, value: "chunk-1" })
    await first.return({ ...response("closed"), outcome: "aborted" })

    expect(await drain(session.run("second"))).toBe("chunk-2")
    expect(invocation).toBe(2)
  })

  it("forwards reflection context and waits for host completion", async () => {
    const contexts: ReflectionCheckpointContext[] = []
    const ordering: string[] = []
    let complete: (() => void) | undefined
    const checkpointDone = new Promise<void>((resolve) => {
      complete = resolve
    })
    let invocation = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      invocation++
      ordering.push(`send-${invocation}`)
      if (invocation <= 50) {
        return {
          blocks: [{ type: "tool_use", id: `tool-${invocation}`, name: "NoSuchTool", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      return response("done")
    }
    const controller = new AbortController()
    const session = await InteractiveSession.create({
      ...baseDeps(sendFn),
      reflectionCheckpoint: {
        async wait(context) {
          contexts.push(context)
          ordering.push("checkpoint")
          await checkpointDone
          ordering.push("completed")
        },
      },
    })

    const running = drain(session.run("go", { signal: controller.signal }))
    while (contexts.length === 0) await Promise.resolve()
    expect(invocation).toBe(50)
    expect(contexts).toEqual([{ round: 50, cooldownMs: 60_000, signal: controller.signal }])
    complete?.()
    expect(await running).toBe("")
    expect(ordering.slice(-3)).toEqual(["checkpoint", "completed", "send-51"])
  })

  it("delegates reflection skip and abort semantics to the injected behavior", async () => {
    const outcomes: string[] = []
    const controller = new AbortController()
    let invocation = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      invocation++
      if (invocation <= 100) {
        return {
          blocks: [{ type: "tool_use", id: `tool-${invocation}`, name: "NoSuchTool", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      return response("done")
    }
    const session = await InteractiveSession.create({
      ...baseDeps(sendFn),
      reflectionCheckpoint: {
        async wait({ round, signal }) {
          outcomes.push(round === 50 ? "skipped" : "aborted")
          if (round === 100) controller.abort()
          expect(signal).toBe(controller.signal)
        },
      },
    })

    await expect(drain(session.run("go", { signal: controller.signal }))).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(outcomes).toEqual(["skipped", "aborted"])
    expect(invocation).toBe(100)
  })

  it("routes transcript output to the run callback and preserves thrown and aborted outcomes", async () => {
    let invocation = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      invocation++
      if (invocation === 1) {
        return {
          blocks: [{ type: "tool_use", id: "unknown", name: "NoSuchTool", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      if (invocation === 3) throw new Error("transport failed")
      yield "ok"
      return response("ok")
    }
    const session = await createSession(sendFn)
    const transcript: string[] = []

    await drain(session.run("success", { onTranscriptLine: (line) => transcript.push(line) }))
    await expect(drain(session.run("failure", { onTranscriptLine: () => {} }))).rejects.toThrow(
      "transport failed",
    )

    const abort = new AbortController()
    abort.abort()
    await expect(drain(session.run("abort", { signal: abort.signal }))).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(transcript.join("\n")).toContain("NoSuchTool")
  })
})
