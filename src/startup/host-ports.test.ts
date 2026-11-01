/**
 * Tests for the CLI host ports (spec S23, S28).
 *
 * The end-to-end cases run a real REPL turn: `InteractiveSession` over the
 * real canonical transport, with a fake network client and the core test
 * provider. They prove that the default ports reach the CLI status bus and
 * the plugin loader's event bus with no port in the session deps.
 */

import { afterEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "@minimal-agent/core/host/auth"
import { clearModelRegistry, clearProviderRegistry } from "@minimal-agent/core/host/model-registry"
import {
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "@minimal-agent/core/host/network"
import { clearProviderPlugins } from "@minimal-agent/core/host/provider-plugin"
import { GLOBAL_STATUS_BUS, StatusBus } from "@minimal-agent/core/host/status-bus"
import type { BuildAgentCoreDeps } from "@minimal-agent/core/host-kit/build-agent-core"
import type { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import {
  registerTestProvider,
  sseBodyFromEvents,
} from "@minimal-agent/core/testing/provider-fixture"
import { InteractiveSession } from "../interactive-session.ts"
import {
  createPluginEventsPort,
  createStatusPort,
  type HostStatusFields,
  statusRowFor,
  withHostPorts,
} from "./host-ports.ts"

type CanonicalEvents = Parameters<typeof sseBodyFromEvents>[0]

// A ready provider credential, so the send needs no stored login.
const AUTH: AuthResult = { type: "provider", auth: { kind: "api-key", key: "test-token" } }

/** A complete single-text-block stream: `text`, then a clean `end_turn`. */
function textEvents(text: string): CanonicalEvents {
  return [
    {
      type: "message_start",
      messageId: "msg_host_ports",
      modelId: "test-model-1",
      initialUsage: { inputTokens: 1, outputTokens: 0 },
    },
    { type: "text_start", index: 0 },
    { type: "text_delta", index: 0, text },
    { type: "text_stop", index: 0 },
    { type: "message_delta", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 4 } },
    { type: "message_stop" },
  ]
}

function okResponse(text: string): NetworkResponse {
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    transport: { id: "fake", protocol: "h2" },
    body: sseBodyFromEvents(textEvents(text)),
  })
}

function unavailableResponse(): NetworkResponse {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("service unavailable"))
      controller.close()
    },
  })
  return new NetworkResponse({
    status: 503,
    headers: { "content-type": "text/plain" },
    transport: { id: "fake", protocol: "h2" },
    body,
  })
}

function fakeNetworkClient(handler: (req: NetworkRequest) => NetworkResponse): NetworkClient {
  const transport: NetworkTransport = { id: "fake", request: async (req) => handler(req) }
  return new NetworkClient({ primary: transport })
}

/** A plugin event as a bus listener gets it. */
interface SeenEvent {
  event: string
  payload: unknown
}

/** The smallest loader the session needs, with a plugin event bus. */
function fakeLoader(seen: SeenEvent[]): PluginLoader {
  const bus = {
    emit(event: string, payload?: unknown): void {
      seen.push({ event, payload })
    },
  }
  const loader = {
    getPromptBlockAsync: async () => null,
    getExtraTools: () => [],
    getToolAliases: () => new Map<string, string>(),
    hasTool: () => false,
    bus: () => bus,
  }
  return loader as unknown as PluginLoader
}

function sessionDeps(loader: PluginLoader, networkClient: NetworkClient): BuildAgentCoreDeps {
  return {
    auth: AUTH,
    model: "test-model-1",
    providerId: "test-prov",
    networkClient,
    loader,
    modeManager: null,
    store: null,
    blobStore: null,
    saveEcho: null,
    turnAttachments: [],
    // No real sleep before a retry.
    retry: { clock: { now: () => Date.now(), sleep: async () => {} }, random: () => 0 },
  }
}

async function drain(gen: AsyncGenerator<string, unknown, undefined>): Promise<string> {
  let text = ""
  for (;;) {
    const next = await gen.next()
    if (next.done) return text
    text += next.value
  }
}

/** Record every status label the CLI status bus shows. */
function recordStatusLabels(): { labels: string[]; stop: () => void } {
  const labels: string[] = []
  const stop = GLOBAL_STATUS_BUS.subscribe((label) => {
    if (label !== null) labels.push(label)
  })
  return { labels, stop }
}

afterEach(() => {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
})

describe("statusRowFor", () => {
  it("gives a label for each engine phase", () => {
    const cases: Array<[HostStatusFields, string]> = [
      [{ phase: "sending" }, "Sending request"],
      [{ phase: "receiving" }, "Receiving stream"],
      [{ phase: "running_tool", toolName: "Bash" }, "Running Bash"],
      [
        { phase: "retrying", cause: "overloaded", attempt: 2, nextDelayMs: 1500 },
        "Retrying after overloaded (attempt 2) — sleeping 1.5s…",
      ],
      [
        { phase: "waiting_for_quota", cause: "quota", attempt: 3, nextDelayMs: 60_000 },
        "Waiting for quota reset after quota (attempt 3) — sleeping 60.0s…",
      ],
      [
        { phase: "waiting_for_host", cause: "auth" },
        "Paused after auth — waiting for the next prompt",
      ],
    ]
    for (const [fields, label] of cases) expect(statusRowFor(fields).label).toBe(label)
  })
})

describe("createStatusPort", () => {
  it("opens, updates, and clears one status row", () => {
    const bus = new StatusBus()
    const port = createStatusPort(bus)
    const live = port.open({ phase: "sending" })
    expect(bus.current()).toBe("Sending request")
    expect(bus.currentStatus()?.notificationId).toBe("network.request")
    live.update({ phase: "receiving" })
    expect(bus.current()).toBe("Receiving stream")
    live.clear()
    expect(bus.current()).toBeNull()
  })
})

describe("createPluginEventsPort", () => {
  it("forwards to the loader bus, and sends nothing with no loader", () => {
    const seen: SeenEvent[] = []
    createPluginEventsPort({
      bus: () => ({ emit: (event, payload) => seen.push({ event, payload }) }),
    }).emit("llm.outputEnd", { reason: "stream_end" })
    expect(seen).toEqual([{ event: "llm.outputEnd", payload: { reason: "stream_end" } }])
    expect(() => createPluginEventsPort(null).emit("x")).not.toThrow()
  })
})

describe("withHostPorts", () => {
  it("keeps the ports a caller sets", () => {
    const statusPort = createStatusPort(new StatusBus())
    const pluginEvents = { emit: () => {} }
    const deps = withHostPorts({ loader: null, statusPort, pluginEvents })
    expect(deps.statusPort).toBe(statusPort)
    expect(deps.pluginEvents).toBe(pluginEvents)
  })

  it("fills both ports when the caller sets none", () => {
    const deps = withHostPorts({ loader: null })
    expect(deps.statusPort).toBeDefined()
    expect(deps.pluginEvents).toBeDefined()
  })
})

describe("REPL turn with the default host ports", () => {
  it("sends llm.outputDelta and llm.outputEnd to a plugin bus listener", async () => {
    registerTestProvider()
    const seen: SeenEvent[] = []
    const status = recordStatusLabels()
    try {
      const session = await InteractiveSession.create(
        sessionDeps(
          fakeLoader(seen),
          fakeNetworkClient(() => okResponse("hello from the stream")),
        ),
      )
      const text = await drain(session.run("hi"))
      expect(text).toContain("hello from the stream")
    } finally {
      status.stop()
    }

    // The ma-tps-plugin listens on these two channels.
    const deltas = seen.filter((e) => e.event === "llm.outputDelta")
    const ends = seen.filter((e) => e.event === "llm.outputEnd")
    expect(deltas.length).toBeGreaterThanOrEqual(1)
    expect(deltas[0]?.payload).toMatchObject({ deltaTokens: expect.any(Number) })
    expect(ends).toEqual([{ event: "llm.outputEnd", payload: { reason: "stream_end" } }])
    // The CLI status rows show the request.
    expect(status.labels).toContain("Sending request")
    expect(status.labels).toContain("Receiving stream")
  }, 15_000)

  it("shows a retrying status row on a transient failure", async () => {
    registerTestProvider()
    let calls = 0
    const status = recordStatusLabels()
    try {
      const session = await InteractiveSession.create(
        sessionDeps(
          fakeLoader([]),
          fakeNetworkClient(() => {
            calls += 1
            return calls === 1 ? unavailableResponse() : okResponse("after retry")
          }),
        ),
      )
      const text = await drain(session.run("hi"))
      expect(text).toContain("after retry")
    } finally {
      status.stop()
    }

    expect(calls).toBe(2)
    expect(status.labels.some((label) => label.startsWith("Retrying after "))).toBe(true)
    expect(status.labels.some((label) => label.includes("(attempt 2)"))).toBe(true)
  }, 15_000)
})
