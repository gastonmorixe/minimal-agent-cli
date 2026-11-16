/**
 * `session.willStart` and `turn.willStart` context on the host-mode path:
 * the context lines reach the first model request of the session / turn.
 *
 * @module host/startup/run-host-mode.hooks.test
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
import type { createLifecyclePort } from "@minimal-agent/core/host-kit/build-agent-core"
import type { HostModeContext, HostModeHandler } from "@minimal-agent/core/host-kit/host-mode"
import type { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import type { HookContextEntry } from "@minimal-agent/core/sdk/lifecycle"
import type {
  TestSendParams as SendOptions,
  TestSendResult as StreamedResponse,
} from "../test-utils/transport-types.ts"

import { type RunHostModeInput, runHostMode } from "./run-host-mode.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const PROVIDER = "host-mode-hooks-prov"

function registerFixtureModel(id: string): void {
  const entry: ModelEntry = {
    id,
    providerId: PROVIDER,
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
  }
  registerModel(entry)
}

type Lifecycle = ReturnType<typeof createLifecyclePort>

/** A loader stub: one host mode, plus a `turn.willStart` chain that records payloads. */
function stubLoader(handler: HostModeHandler, willStartSeen: unknown[], ctx: HookContextEntry[]) {
  return {
    findHostMode: (id: string) =>
      id === "test"
        ? {
            spec: { id: "test", description: "t", entry: { type: "module", path: "x.ts" } },
            pluginId: "p",
            packageDir: "/",
            entryAbsolute: "/x.ts",
            handler,
          }
        : undefined,
    hooks: () => ({
      emitChain: async (channel: string, payload: unknown) => {
        if (channel === "turn.willStart") willStartSeen.push(payload)
        return { payload, halted: false, additionalContext: ctx }
      },
    }),
  } as unknown as PluginLoader
}

/** Every text block of every request, joined per request. */
function recordingSend(requests: string[]) {
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    const parts: string[] = []
    for (const m of opts.messages) {
      if (typeof m.content === "string") parts.push(m.content)
      else if (Array.isArray(m.content)) {
        for (const b of m.content) if (b.type === "text") parts.push(b.text)
      }
    }
    requests.push(parts.join("\n"))
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
  lifecycle: Partial<Lifecycle>,
  requests: string[],
  willStartSeen: unknown[],
  turnCtx: HookContextEntry[],
  stderrLines: string[] = [],
): RunHostModeInput {
  return {
    hostModeId: "test",
    hostModeArgv: [],
    promptSource: { kind: "none" },
    loader: stubLoader(handler, willStartSeen, turnCtx),
    sessionDeps: {
      auth: AUTH,
      model: "model-a",
      providerId: PROVIDER,
      sendFn: recordingSend(requests),
      loader: null,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    },
    sessionId: "sid-hooks",
    hostLifecycle: lifecycle as Lifecycle,
    stderr: { write: (s: string) => stderrLines.push(s) > 0 },
    signalSource: new EventEmitter() as unknown as Pick<NodeJS.Process, "on" | "removeListener">,
  }
}

async function drain(iter: AsyncIterable<SessionEntry>): Promise<void> {
  for await (const _ of iter) {
    // drain only
  }
}

const oneTurn = async (ctx: HostModeContext): Promise<number> => {
  const session = await ctx.runtime.openSession()
  await drain(session.run("hello", { emitDeltas: true, signal: new AbortController().signal }))
  await session.close()
  return 0
}

describe("runHostMode hooks context", () => {
  afterEach(() => clearModelRegistry())

  it("session.willStart: source startup, context reaches the first request", async () => {
    registerFixtureModel("model-a")
    const seen: unknown[] = []
    const requests: string[] = []
    const lifecycle: Partial<Lifecycle> = {
      sessionWillStart: async (p) => {
        seen.push(p)
        return { additionalContext: ["SESSION-CTX-LINE"] }
      },
    }
    await runHostMode(makeInput(oneTurn, lifecycle, requests, [], []))
    expect(seen).toEqual([
      { source: "startup", sid: "sid-hooks", cwd: process.cwd(), model: "model-a" },
    ])
    expect(requests[0]).toContain("SESSION-CTX-LINE")
    expect(requests[0]).toContain("hello")
  })

  it("a failing session.willStart does not stop the session", async () => {
    registerFixtureModel("model-a")
    const requests: string[] = []
    const stderrLines: string[] = []
    const lifecycle: Partial<Lifecycle> = {
      sessionWillStart: async () => {
        throw new Error("hook down")
      },
    }
    await runHostMode(makeInput(oneTurn, lifecycle, requests, [], [], stderrLines))
    expect(requests.length).toBe(1)
    expect(stderrLines.join("")).toContain("session.willStart failed: hook down")
    expect(process.exitCode).toBe(0)
  })

  it("turn.willStart: payload has sid, context reaches the turn request", async () => {
    registerFixtureModel("model-a")
    const requests: string[] = []
    const willStartSeen: unknown[] = []
    await runHostMode(makeInput(oneTurn, {}, requests, willStartSeen, ["TURN-CTX-LINE"]))
    expect(willStartSeen).toEqual([{ text: "hello", sid: "sid-hooks" }])
    expect(requests[0]).toContain("TURN-CTX-LINE")
    // Turn context is a run option: it goes after the prompt, not before it.
    const req = requests[0] ?? ""
    expect(req.indexOf("hello")).toBeGreaterThanOrEqual(0)
    expect(req.indexOf("hello")).toBeLessThan(req.indexOf("TURN-CTX-LINE"))
  })

  it("turn.willStart: a before entry keeps its position, the after string follows the prompt", async () => {
    registerFixtureModel("model-a")
    const requests: string[] = []
    const ctx: HookContextEntry[] = [{ text: "BEFORE-CTX", position: "before" }, "AFTER-CTX"]
    await runHostMode(makeInput(oneTurn, {}, requests, [], ctx))
    // Not flattened to a string: a flattened entry would land after the prompt.
    const req = requests[0] ?? ""
    expect(req.indexOf("BEFORE-CTX")).toBeGreaterThanOrEqual(0)
    expect(req.indexOf("BEFORE-CTX")).toBeLessThan(req.indexOf("hello"))
    expect(req.indexOf("hello")).toBeLessThan(req.indexOf("AFTER-CTX"))
  })
})
