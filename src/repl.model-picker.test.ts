/**
 * The model-error recovery picker in `runRepl`: a live-catalog id the
 * static registry does not know must be registered with its provider
 * before the validated `setModel` switch, and a switch that still fails
 * must say so instead of blaming the model listing.
 */

import { afterEach, describe, expect, it } from "bun:test"

import {
  clearModelRegistry,
  type ModelEntry,
  registerModel,
  resolveModelForProvider,
} from "@minimal-agent/core/host/model-registry"
import {
  clearProviderPlugins,
  registerProviderPlugin,
} from "@minimal-agent/core/host/provider-plugin"
import { StatusBus } from "@minimal-agent/core/host/status-bus"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"

import { type ReplAgentLike, runRepl } from "./repl.ts"

const PROVIDER = "picker-test-prov"
const ANSI_RE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")
const NOT_FOUND =
  'API 404: {"type":"error","error":{"type":"not_found_error","message":"model: old-model"}}'

function entry(id: string): ModelEntry {
  return {
    id,
    providerId: PROVIDER,
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

class FakeInput {
  private readonly values: Array<string | null>
  constructor(values: Array<string | null>) {
    this.values = [...values]
  }
  async read(): Promise<string | null> {
    return this.values.shift() ?? null
  }
}

class FakeOutput {
  isTTY = false
  readonly chunks: string[] = []
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  }
  text(): string {
    return this.chunks.join("").replace(ANSI_RE, "")
  }
}

/** Agent whose run fails with a model-not-found error and whose setModel validates like AgentCore's. */
function failingAgent(): ReplAgentLike & { model: string } {
  const agent = {
    model: "old-model",
    pluginLoader: () => null,
    // biome-ignore lint/correctness/useYield: the turn fails before any chunk
    async *run(): AsyncGenerator<string, never, undefined> {
      throw new Error(NOT_FOUND)
    },
    getModel: () => agent.model,
    setModel(model: string) {
      resolveModelForProvider(model, PROVIDER)
      agent.model = model
    },
  }
  return agent
}

async function runPicker(agent: ReplAgentLike, picked: string): Promise<string> {
  const errOutput = new FakeOutput()
  await runRepl(agent, {
    input: new FakeInput(["hi", null]),
    output: new FakeOutput(),
    errOutput,
    statusBus: new StatusBus(),
    auth: { type: "api-key", token: "t" },
    providerId: PROVIDER,
    listModels: async () => [{ id: "live-only", type: "model" }],
    pickModel: async () => picked,
  })
  return errOutput.text()
}

describe("runRepl model-error picker", () => {
  afterEach(() => {
    clearModelRegistry()
    clearProviderPlugins()
  })

  it("registers a live-only picked id with its provider before switching", async () => {
    registerModel(entry("old-model"))
    registerProviderPlugin({
      id: PROVIDER,
      displayName: "Picker Test",
      shortCode: "pt",
      register() {},
      registerAdHocModel(id: string) {
        registerModel(entry(id))
      },
    })
    const agent = failingAgent()

    const err = await runPicker(agent, "live-only")

    expect(agent.model).toBe("live-only")
    expect(err).toContain("model set to live-only")
    expect(err).not.toContain("could not list models")
  })

  it("reports a failed switch as a switch error, not a listing error", async () => {
    registerModel(entry("old-model"))
    registerProviderPlugin({
      id: PROVIDER,
      displayName: "Picker Test",
      shortCode: "pt",
      register() {},
    })
    const agent = failingAgent()

    const err = await runPicker(agent, "live-only")

    expect(agent.model).toBe("old-model")
    expect(err).toContain("could not switch to live-only")
    expect(err).toContain('unknown model "live-only"')
    expect(err).not.toContain("could not list models")
  })
})
