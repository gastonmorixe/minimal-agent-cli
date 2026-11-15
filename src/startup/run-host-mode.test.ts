/**
 * Unit tests for {@link runHostMode}: the `HostRuntime` effort getters
 * after a model switch, `turn.willStart` on `HostSession.run`, and the
 * shutdown signals (first signal aborts, a second signal or the grace
 * period ends the process).
 *
 * @module host/startup/run-host-mode.test
 */

import { afterEach, describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import type { SessionEntry } from "@minimal-agent/core"
import type { AuthResult } from "@minimal-agent/core/host/auth"
import {
  clearModelRegistry,
  type ModelEntry,
  registerModel,
} from "@minimal-agent/core/host/model-registry"
import { createLifecyclePort } from "@minimal-agent/core/host-kit/build-agent-core"
import type {
  HostModeContext,
  HostModeHandler,
  HostOpenSessionOptions,
} from "@minimal-agent/core/host-kit/host-mode"
import type { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import type { ModelInfoSnapshot } from "@minimal-agent/core/plugin-api/types/plugin"
import { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import type {
  TestSendParams as SendOptions,
  TestSendResult as StreamedResponse,
} from "../test-utils/transport-types.ts"

import {
  detectHostRuntimeCapabilities,
  type HostRuntimeCapabilities,
  type RunHostModeInput,
  runHostMode,
  withSystemPromptOption,
} from "./run-host-mode.ts"

const SETTERS = ["setNextRunOutputSchema", "setNextRunTemperature"] as const
type SetterName = (typeof SETTERS)[number]

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const PROVIDER = "host-mode-test-prov"

function registerFixtureModel(id: string, levels: readonly string[]): void {
  const entry: ModelEntry = {
    id,
    providerId: PROVIDER,
    surfaceId: "test",
    displayName: id,
    capabilities: {
      ...defaultCapabilities(),
      effort: { levels, default: "low" } as ModelEntry["capabilities"]["effort"],
    },
    pricing: {
      inputUSD: 0,
      outputUSD: 0,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  }
  registerModel(entry)
}

/** The chain result a fake `turn.willStart` listener gives. */
type WillStart = { payload: { text: string }; halted: boolean }

/** A loader stub: one host mode, plus a `turn.willStart` chain. */
function stubLoader(
  handler: HostModeHandler,
  willStart?: (text: string) => WillStart,
): PluginLoader {
  const stub = {
    findHostMode: (id: string) =>
      id === "test"
        ? {
            spec: {
              id: "test",
              description: "test",
              entry: { type: "module", path: "x.ts" },
            },
            pluginId: "p",
            packageDir: "/",
            entryAbsolute: "/x.ts",
            handler,
          }
        : undefined,
    hooks: () => ({
      emitChain: async (channel: string, payload: { text: string }) => {
        if (channel !== "turn.willStart" || !willStart) return { payload, halted: false }
        return willStart(payload.text)
      },
    }),
  }
  return stub as unknown as PluginLoader
}

/** A transport that records the last user text and ends the turn. */
function recordingSend(sent: string[]) {
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    const last = opts.messages.at(-1)
    const content = last?.content
    if (typeof content === "string") sent.push(content)
    else if (Array.isArray(content)) {
      for (const b of content) if (b.type === "text") sent.push(b.text)
    }
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

function makeInput(
  handler: HostModeHandler,
  opts: {
    sent?: string[]
    willStart?: (text: string) => WillStart
    effort?: string
    exitProcess?: (code: number) => void
    signalGraceMs?: number
    signals?: EventEmitter
  } = {},
): RunHostModeInput {
  const stderrLines: string[] = []
  return {
    hostModeId: "test",
    hostModeArgv: [],
    promptSource: { kind: "none" },
    loader: stubLoader(handler, opts.willStart),
    sessionDeps: {
      auth: AUTH,
      model: "model-a",
      providerId: PROVIDER,
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      sendFn: recordingSend(opts.sent ?? []),
      loader: null,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    },
    sessionId: "sid-host-mode",
    hostLifecycle: createLifecyclePort(null),
    stderr: { write: (s: string) => stderrLines.push(s) > 0 },
    ...(opts.exitProcess ? { exitProcess: opts.exitProcess } : {}),
    ...(opts.signalGraceMs !== undefined ? { signalGraceMs: opts.signalGraceMs } : {}),
    // Never the real process: other test files listen for real signals.
    signalSource: (opts.signals ?? new EventEmitter()) as unknown as Pick<
      NodeJS.Process,
      "on" | "removeListener"
    >,
  }
}

async function drain(iter: AsyncIterable<SessionEntry>): Promise<void> {
  for await (const _ of iter) {
    // drain only
  }
}

describe("runHostMode", () => {
  const savedExitCode = process.exitCode
  afterEach(() => {
    clearModelRegistry()
    process.exitCode = savedExitCode
  })

  it("getEffort reads the live core after setModel resets the effort", async () => {
    registerFixtureModel("model-a", ["low", "high"])
    registerFixtureModel("model-b", [])
    const seen: Array<string | undefined> = []
    const handler = async (ctx: HostModeContext): Promise<number> => {
      seen.push(ctx.runtime.getEffort())
      const session = await ctx.runtime.openSession()
      seen.push(ctx.runtime.getEffort())
      ctx.runtime.setModel("model-b")
      seen.push(ctx.runtime.getEffort())
      await session.close()
      return 0
    }
    await runHostMode(makeInput(handler, { effort: "high" }))
    expect(seen).toEqual(["high", "high", undefined])
    expect(process.exitCode).toBe(0)
  })

  it("the ModelInfo tool follows a setModel on the host-mode session", async () => {
    registerFixtureModel("model-a", [])
    registerFixtureModel("model-b", [])
    let source: (() => ModelInfoSnapshot | undefined) | undefined
    const sessionLoader = {
      getPromptBlockAsync: async () => null,
      getExtraTools: () => [],
      getToolAliases: () => new Map<string, string>(),
      hasTool: () => false,
      setModelInfoSource: (provider: () => ModelInfoSnapshot | undefined) => {
        source = provider
      },
    } as unknown as PluginLoader
    const seen: Array<string | undefined> = []
    const handler = async (ctx: HostModeContext): Promise<number> => {
      const session = await ctx.runtime.openSession()
      seen.push(source?.()?.modelId)
      ctx.runtime.setModel("model-b")
      seen.push(source?.()?.modelId)
      await session.close()
      return 0
    }
    const input = makeInput(handler)
    await runHostMode({ ...input, sessionDeps: { ...input.sessionDeps, loader: sessionLoader } })
    expect(seen).toEqual(["model-a", "model-b"])
  })

  it("setEffort validates against the live model and getEffort shows it", async () => {
    registerFixtureModel("model-a", ["low", "high"])
    const seen: Array<string | undefined> = []
    let error = ""
    const handler = async (ctx: HostModeContext): Promise<number> => {
      expect(() => ctx.runtime.setEffort("low")).toThrow(/no session open/)
      const session = await ctx.runtime.openSession()
      ctx.runtime.setEffort("low")
      seen.push(ctx.runtime.getEffort())
      try {
        ctx.runtime.setEffort("ultra")
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
      seen.push(ctx.runtime.getEffort())
      await session.close()
      return 0
    }
    await runHostMode(makeInput(handler))
    expect(seen).toEqual(["low", "low"])
    expect(error.length).toBeGreaterThan(0)
  })

  it("HostSession.run applies a turn.willStart rewrite before the model request", async () => {
    registerFixtureModel("model-a", ["low", "high"])
    const sent: string[] = []
    const handler = async (ctx: HostModeContext): Promise<number> => {
      const session = await ctx.runtime.openSession()
      const run = session.run("hello", { emitDeltas: true, signal: new AbortController().signal })
      await drain(run)
      expect((await run.result).outcome).toBe("completed")
      // A new prompt right after the entries end must not see "in progress".
      await drain(session.run("next", { emitDeltas: true, signal: new AbortController().signal }))
      await session.close()
      expect(() =>
        session.run("late", { emitDeltas: true, signal: new AbortController().signal }),
      ).toThrow(/closed/)
      return 0
    }
    const willStart = (text: string): WillStart => ({
      payload: { text: `${text} (rewritten)` },
      halted: false,
    })
    await runHostMode(makeInput(handler, { sent, willStart }))
    expect(sent.some((t) => t.includes("hello (rewritten)"))).toBe(true)
    expect(sent.some((t) => t.includes("next (rewritten)"))).toBe(true)
  })

  it("HostSession.run stops a halted turn with the turn.blocked error and no model request", async () => {
    registerFixtureModel("model-a", ["low", "high"])
    const sent: string[] = []
    let iterError: unknown
    let resultError: unknown
    let ranAgain = false
    const handler = async (ctx: HostModeContext): Promise<number> => {
      const session = await ctx.runtime.openSession()
      const run = session.run("hello", { emitDeltas: true, signal: new AbortController().signal })
      try {
        await drain(run)
      } catch (e) {
        iterError = e
      }
      try {
        await run.result
      } catch (e) {
        resultError = e
      }
      // The session stays usable after a halted turn.
      const next = session.run("again", { emitDeltas: true, signal: new AbortController().signal })
      await drain(next).catch(() => {})
      ranAgain = true
      await session.close()
      return 0
    }
    const willStart = (text: string): WillStart => ({ payload: { text }, halted: true })
    await runHostMode(makeInput(handler, { sent, willStart }))
    expect(sent).toEqual([])
    expect(iterError).toBeInstanceOf(Error)
    expect((iterError as Error & { code?: string }).code).toBe("turn.blocked")
    expect((iterError as Error).message).toBe(
      "turn.willStart: prompt blocked by lifecycle policy hook.",
    )
    expect(resultError).toBe(iterError)
    expect(ranAgain).toBe(true)
  })

  it("HostSession.run throws at once when a turn is already in progress", async () => {
    registerFixtureModel("model-a", ["low", "high"])
    const handler = async (ctx: HostModeContext): Promise<number> => {
      const session = await ctx.runtime.openSession()
      const signal = new AbortController().signal
      const first = session.run("one", { emitDeltas: true, signal })
      expect(() => session.run("two", { emitDeltas: true, signal })).toThrow(/in progress/)
      await drain(first)
      await session.close()
      return 0
    }
    await runHostMode(makeInput(handler))
    expect(process.exitCode).toBe(0)
  })

  it("withSystemPromptOption: no option gives the same deps", () => {
    const deps = makeInput(async () => 0).sessionDeps
    expect(withSystemPromptOption(deps, undefined)).toBe(deps)
  })

  it("withSystemPromptOption: append sets appendSystemPrompt only", () => {
    const deps = makeInput(async () => 0).sessionDeps
    const out = withSystemPromptOption(deps, { mode: "append", text: "be brief" })
    expect(out.appendSystemPrompt).toBe("be brief")
    expect(out.systemPromptOverrides).toBeUndefined()
    expect(deps.appendSystemPrompt).toBeUndefined()
  })

  it("withSystemPromptOption: override replaces instructions and keeps other overrides", () => {
    const base = makeInput(async () => 0).sessionDeps
    const deps = {
      ...base,
      systemPromptOverrides: {
        identity: { kind: "replace" as const, text: "id" },
        instructions: { kind: "omit" as const },
      },
    }
    const out = withSystemPromptOption(deps, { mode: "override", text: "client rules" })
    expect(out.systemPromptOverrides).toEqual({
      identity: { kind: "replace", text: "id" },
      instructions: { kind: "replace", text: "client rules" },
    })
    expect(out.systemPromptOverrides?.full).toBeUndefined()
    expect(out.appendSystemPrompt).toBeUndefined()
    expect(deps.systemPromptOverrides.instructions).toEqual({ kind: "omit" })
  })

  it("withSystemPromptOption: override with an active full override warns once on stderr", () => {
    const base = makeInput(async () => 0).sessionDeps
    const lines: string[] = []
    const stderr = { write: (s: string) => lines.push(s) > 0 }
    const deps = {
      ...base,
      systemPromptOverrides: { full: { kind: "replace" as const, text: "whole prompt" } },
    }
    const out = withSystemPromptOption(deps, { mode: "override", text: "client rules" }, stderr)
    expect(out.systemPromptOverrides?.instructions).toEqual({
      kind: "replace",
      text: "client rules",
    })
    expect(lines).toEqual([
      "[host-mode] warn: systemPrompt override ignored, a full override is active\n",
    ])
    // No `full` override, or append mode: no warning.
    withSystemPromptOption(base, { mode: "override", text: "x" }, stderr)
    withSystemPromptOption(deps, { mode: "append", text: "x" }, stderr)
    expect(lines).toHaveLength(1)
  })

  it("openSession({systemPrompt}) reaches the model request; no options keeps the old prompt", async () => {
    registerFixtureModel("model-a", [])
    const systems: string[] = []
    const send = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      const sys = (opts as { system?: unknown }).system
      systems.push(typeof sys === "string" ? sys : JSON.stringify(sys ?? ""))
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const runOnce = async (options?: HostOpenSessionOptions): Promise<void> => {
      const handler = async (ctx: HostModeContext): Promise<number> => {
        const session = await ctx.runtime.openSession(options)
        await drain(session.run("hi", { emitDeltas: true, signal: new AbortController().signal }))
        await session.close()
        return 0
      }
      const input = makeInput(handler)
      await runHostMode({ ...input, sessionDeps: { ...input.sessionDeps, sendFn: send } })
    }
    await runOnce()
    await runOnce({ systemPrompt: { mode: "append", text: "APPENDED-MARKER-7" } })
    await runOnce({ systemPrompt: { mode: "override", text: "OVERRIDE-MARKER-9" } })
    expect(systems).toHaveLength(3)
    const [plain, appended, overridden] = systems as [string, string, string]
    expect(plain).not.toContain("APPENDED-MARKER-7")
    expect(appended).toContain("APPENDED-MARKER-7")
    expect(overridden).toContain("OVERRIDE-MARKER-9")
    expect(overridden).not.toBe(plain)
  })

  it("HostSession.run({outputSchema}) reaches the model request for that run only", async () => {
    registerFixtureModel("model-a", [])
    const schema = { type: "object", properties: { answer: { type: "string" } } }
    const formats: unknown[] = []
    const send = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      formats.push((opts as { outputConfig?: { format?: unknown } }).outputConfig?.format)
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const handler = async (ctx: HostModeContext): Promise<number> => {
      const session = await ctx.runtime.openSession()
      const signal = new AbortController().signal
      await drain(session.run("one", { emitDeltas: true, signal, outputSchema: schema }))
      await drain(session.run("two", { emitDeltas: true, signal }))
      await session.close()
      return 0
    }
    const input = makeInput(handler)
    await runHostMode({ ...input, sessionDeps: { ...input.sessionDeps, sendFn: send } })
    expect(formats).toEqual([{ type: "json_schema", schema }, undefined])
  })

  it("HostSession.run({temperature}) reaches the model request for that run only", async () => {
    registerFixtureModel("model-a", [])
    const temps: unknown[] = []
    const send = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      temps.push(opts.temperature)
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const handler = async (ctx: HostModeContext): Promise<number> => {
      const session = await ctx.runtime.openSession()
      const signal = new AbortController().signal
      await drain(session.run("one", { emitDeltas: true, signal, temperature: 0.2 }))
      await drain(session.run("two", { emitDeltas: true, signal }))
      await session.close()
      return 0
    }
    const input = makeInput(handler)
    await runHostMode({ ...input, sessionDeps: { ...input.sessionDeps, sendFn: send } })
    expect(temps).toEqual([0.2, undefined])
  })

  /**
   * Replaces the D1/D4 setters on `AgentCore.prototype` for one test.
   * `undefined` removes a setter, the same as an older pinned core.
   */
  async function withSetters(
    setters: Partial<Record<SetterName, ((v: unknown) => void) | undefined>>,
    body: () => Promise<void>,
  ): Promise<void> {
    const proto = AgentCore.prototype as unknown as Record<string, unknown>
    const saved = new Map<SetterName, PropertyDescriptor | undefined>()
    for (const name of SETTERS) {
      saved.set(name, Object.getOwnPropertyDescriptor(proto, name))
      if (!(name in setters)) continue
      const fn = setters[name]
      if (fn === undefined) delete proto[name]
      else proto[name] = fn
    }
    try {
      await body()
    } finally {
      for (const [name, desc] of saved) {
        if (desc) Object.defineProperty(proto, name, desc)
        else delete proto[name]
      }
    }
  }

  it("detectHostRuntimeCapabilities matches the core in use", () => {
    const caps = detectHostRuntimeCapabilities()
    const proto = AgentCore.prototype as unknown as Record<string, unknown>
    // A local core (tsconfig `paths` override) has the D1/D4 setters and M2
    // append. The pinned core has none of them. Override works on both.
    const localCore = typeof proto.setNextRunTemperature === "function"
    expect(caps).toEqual({
      systemPrompt: { append: localCore, override: true },
      outputSchema: localCore,
      temperature: localCore,
    })
  })

  it("detectHostRuntimeCapabilities is false for a setter the core lacks", async () => {
    await withSetters(
      { setNextRunOutputSchema: undefined, setNextRunTemperature: undefined },
      async () => {
        const caps = detectHostRuntimeCapabilities()
        expect(caps.outputSchema).toBe(false)
        expect(caps.temperature).toBe(false)
      },
    )
    await withSetters(
      { setNextRunOutputSchema: () => {}, setNextRunTemperature: () => {} },
      async () => {
        const caps = detectHostRuntimeCapabilities()
        expect(caps.outputSchema).toBe(true)
        expect(caps.temperature).toBe(true)
      },
    )
  })

  it("ctx.runtime.capabilities is the detected object", async () => {
    let seen: unknown
    const handler = async (ctx: HostModeContext): Promise<number> => {
      seen = (ctx.runtime as { capabilities?: HostRuntimeCapabilities }).capabilities
      return 0
    }
    await runHostMode(makeInput(handler))
    expect(seen).toEqual(detectHostRuntimeCapabilities())
  })

  it("a core without the setters runs normally and warns once per given option", async () => {
    registerFixtureModel("model-a", [])
    const sent: string[] = []
    const stderrLines: string[] = []
    const handler = async (ctx: HostModeContext): Promise<number> => {
      const session = await ctx.runtime.openSession()
      const signal = new AbortController().signal
      await drain(session.run("plain", { emitDeltas: true, signal }))
      expect(stderrLines.join("")).not.toContain("does not support")
      const schema = { type: "object" }
      await drain(session.run("one", { emitDeltas: true, signal, outputSchema: schema }))
      await drain(session.run("two", { emitDeltas: true, signal, outputSchema: schema }))
      await drain(session.run("three", { emitDeltas: true, signal, temperature: 0.3 }))
      await session.close()
      return 0
    }
    await withSetters({ setNextRunOutputSchema: undefined, setNextRunTemperature: undefined }, () =>
      runHostMode({
        ...makeInput(handler, { sent }),
        stderr: { write: (s: string) => stderrLines.push(s) > 0 },
      }),
    )
    expect(sent).toEqual(["plain", "one", "two", "three"])
    const warnings = stderrLines.filter((l) => l.includes("does not support"))
    expect(warnings).toEqual([
      "[host-mode] warn: the core does not support per-run outputSchema; running without it\n",
      "[host-mode] warn: the core does not support per-run temperature; running without it\n",
    ])
  })

  it("a run with no outputSchema and no temperature never calls the setters", async () => {
    registerFixtureModel("model-a", [])
    const calls: string[] = []
    const handler = async (ctx: HostModeContext): Promise<number> => {
      const session = await ctx.runtime.openSession()
      const signal = new AbortController().signal
      await drain(session.run("one", { emitDeltas: true, signal }))
      await drain(session.run("two", { emitDeltas: true, signal }))
      await session.close()
      return 0
    }
    await withSetters(
      {
        setNextRunOutputSchema: () => calls.push("schema"),
        setNextRunTemperature: () => calls.push("temperature"),
      },
      () => runHostMode(makeInput(handler)),
    )
    expect(calls).toEqual([])
  })

  it("the first SIGTERM aborts ctx.abort, and the handler's code is the exit code", async () => {
    const exits: number[] = []
    const signals = new EventEmitter()
    const handler = async (ctx: HostModeContext): Promise<number> => {
      queueMicrotask(() => signals.emit("SIGTERM"))
      await new Promise<void>((resolve) => ctx.abort.addEventListener("abort", () => resolve()))
      return 7
    }
    await runHostMode(makeInput(handler, { exitProcess: (c) => exits.push(c), signals }))
    expect(exits).toEqual([])
    expect(process.exitCode).toBe(7)
    expect(signals.listenerCount("SIGTERM")).toBe(0)
    expect(signals.listenerCount("SIGINT")).toBe(0)
  })

  it("a second signal ends the process when the handler does not react", async () => {
    const exits: number[] = []
    const signals = new EventEmitter()
    let release: () => void = () => {}
    const handler = async (): Promise<number> => {
      signals.emit("SIGINT")
      signals.emit("SIGINT")
      await new Promise<void>((resolve) => {
        release = resolve
        if (exits.length > 0) resolve()
      })
      return 0
    }
    await runHostMode(makeInput(handler, { exitProcess: (c) => exits.push(c), signals }))
    release()
    expect(exits).toEqual([130])
  })

  it("the grace period ends the process when the handler ignores the first signal", async () => {
    const exits: number[] = []
    const signals = new EventEmitter()
    const handler = async (): Promise<number> => {
      signals.emit("SIGTERM")
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (exits.length > 0) {
            clearInterval(poll)
            resolve()
          }
        }, 5)
      })
      return 0
    }
    await runHostMode(
      makeInput(handler, { exitProcess: (c) => exits.push(c), signalGraceMs: 20, signals }),
    )
    expect(exits).toEqual([143])
  })
})

describe("runHostMode provider + credential targets", () => {
  const OTHER = "host-mode-other-prov"
  afterEach(() => {
    clearModelRegistry()
  })

  function registerOn(id: string, providerId: string): void {
    registerModel({
      id,
      providerId,
      surfaceId: "test",
      displayName: id,
      capabilities: defaultCapabilities(),
      pricing: {
        inputUSD: 0,
        outputUSD: 0,
        cacheWriteUSD: 0,
        cacheReadUSD: 0,
        webSearchPerCallUSD: 0,
      },
    })
  }

  const stored = (providerId: string, credentialName: string) => ({
    providerId,
    displayName: `${providerId}-name`,
    authKind: "api-key" as const,
    source: "store" as const,
    credentialName,
  })

  /** A transport that records the auth of each request. */
  function authSend(seen: AuthResult[]) {
    return async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      seen.push((opts as unknown as { auth: AuthResult }).auth)
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
  }

  it("listTargets keeps the live target; setTarget switches provider, auth, and models", async () => {
    registerFixtureModel("model-a", [])
    registerOn("model-x", OTHER)
    const otherAuth: AuthResult = { type: "api-key", token: "other-token" }
    const authCalls: unknown[][] = []
    const seenAuth: AuthResult[] = []
    const out: Record<string, unknown> = {}
    const handler = async (ctx: HostModeContext): Promise<number> => {
      const rt = ctx.runtime
      out.targets = rt.listTargets?.()
      await expect(rt.setTarget?.({ providerId: OTHER, credentialName: "work" })).rejects.toThrow(
        /no session open/,
      )
      const session = await rt.openSession()
      await rt.setTarget?.({ providerId: OTHER, credentialName: "work" })
      out.target = rt.getTarget?.()
      out.model = rt.getModel()
      out.models = rt.listModels().map((m) => m.id)
      out.info = rt.modelInfo("model-x")?.modelId
      await drain(session.run("hi", { emitDeltas: true, signal: new AbortController().signal }))
      await session.close()
      return 0
    }
    const input = makeInput(handler)
    await runHostMode({
      ...input,
      sessionDeps: { ...input.sessionDeps, sendFn: authSend(seenAuth) },
      discoverTargets: () => [stored(OTHER, "work")],
      resolveTargetAuth: async (...args) => {
        authCalls.push(args)
        return otherAuth
      },
    })
    expect(out.targets).toEqual([
      { providerId: PROVIDER, label: PROVIDER },
      { providerId: OTHER, credentialName: "work", label: `${OTHER}-name · work` },
    ])
    expect(out.target).toEqual({ providerId: OTHER, credentialName: "work" })
    expect(out.model).toBe("model-x")
    expect(out.models).toEqual(["model-x"])
    expect(out.info).toBe("model-x")
    expect(authCalls).toEqual([[OTHER, "model-x", "work"]])
    expect(seenAuth.at(-1)).toEqual(otherAuth)
  })

  it("setTarget leaves the target unchanged when auth or the credential check fails", async () => {
    registerFixtureModel("model-a", [])
    registerOn("model-x", OTHER)
    const errors: string[] = []
    const targets: unknown[] = []
    const handler = async (ctx: HostModeContext): Promise<number> => {
      const rt = ctx.runtime
      const session = await rt.openSession()
      for (const t of [
        { providerId: OTHER, credentialName: "nope" },
        { providerId: OTHER, credentialName: "fail" },
      ]) {
        try {
          await rt.setTarget?.(t)
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e))
        }
        targets.push({ target: rt.getTarget?.(), model: rt.getModel() })
      }
      await session.close()
      return 0
    }
    await runHostMode({
      ...makeInput(handler),
      discoverTargets: () => [stored(OTHER, "fail")],
      resolveTargetAuth: async (_p, _m, credentialName) => {
        if (credentialName === "fail") throw new Error("no credentials")
        return AUTH
      },
    })
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatch(/unknown credential "nope"/)
    expect(errors[1]).toMatch(/no credentials/)
    for (const t of targets) {
      expect(t).toEqual({ target: { providerId: PROVIDER }, model: "model-a" })
    }
  })

  it("setTarget keeps the model when the new provider registers the same id", async () => {
    registerFixtureModel("model-a", [])
    registerOn("model-a", OTHER)
    registerOn("model-z", OTHER)
    let model = ""
    const handler = async (ctx: HostModeContext): Promise<number> => {
      const session = await ctx.runtime.openSession()
      await ctx.runtime.setTarget?.({ providerId: OTHER })
      model = ctx.runtime.getModel()
      await session.close()
      return 0
    }
    await runHostMode({
      ...makeInput(handler),
      discoverTargets: () => [],
      resolveTargetAuth: async () => AUTH,
    })
    expect(model).toBe("model-a")
  })
})
