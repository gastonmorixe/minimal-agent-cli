/** Tests for the CLI side effects of a live target change. */

import { afterEach, describe, expect, it } from "bun:test"

import { clearModelRegistry, clearProviderRegistry } from "@minimal-agent/core/host/model-registry"
import { clearProviderPlugins } from "@minimal-agent/core/host/provider-plugin"
import { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import { registerTestProvider } from "@minimal-agent/core/testing/provider-fixture"

import {
  followLiveTarget,
  type LiveTargetLoader,
  publishTargetEnv,
  TARGET_DID_SWITCH,
  type TargetDidSwitchPayload,
} from "./live-target.ts"

const EFFORT = { levels: ["low", "high"], default: "low" }

function buildCore(): AgentCore {
  registerTestProvider({
    id: "alpha",
    models: [
      { id: "model-a", capabilities: { effort: { ...EFFORT } } },
      { id: "model-b", capabilities: { effort: { ...EFFORT } } },
    ],
  })
  registerTestProvider({ id: "beta", models: [{ id: "model-x" }] })
  return new AgentCore({
    auth: { type: "api-key", token: "t" },
    model: "model-a",
    providerId: "alpha",
    credentialName: "work",
    effort: "high",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "", isError: false }) },
  })
}

function fakeLoader(): LiveTargetLoader & { events: [string, TargetDidSwitchPayload][] } {
  const events: [string, TargetDidSwitchPayload][] = []
  return { events, bus: () => ({ emit: (event, payload) => events.push([event, payload]) }) }
}

afterEach(() => {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
})

describe("followLiveTarget", () => {
  it("writes the env, sets the target source, and emits one bus event for each change", () => {
    const core = buildCore()
    const loader = fakeLoader()
    const env: NodeJS.ProcessEnv = { MINIMAL_AGENT_CREDENTIAL_NAME: "work", UNRELATED: "kept" }
    followLiveTarget(core, { loader, env, hidesReasoning: (m) => m === "model-x" })

    // The source is live at once, before any change.
    expect(loader.targetSource?.()).toEqual(core.getTarget())
    expect(loader.events).toEqual([])

    core.setModel("model-b")
    expect(env).toMatchObject({
      MINIMAL_AGENT_MODEL: "model-b",
      MINIMAL_AGENT_PROVIDER: "alpha",
      MINIMAL_AGENT_CREDENTIAL_NAME: "work",
      MINIMAL_AGENT_EFFORT: "high",
      UNRELATED: "kept",
    })

    core.setEffort(undefined)
    // The model default shows as the model's own default ("low"), not "medium".
    expect(env.MINIMAL_AGENT_EFFORT).toBe("low")

    // A provider change with no credential name: the old name is removed.
    core.switchTarget({ providerId: "beta", model: "model-x" })
    expect(env.MINIMAL_AGENT_PROVIDER).toBe("beta")
    expect(env.MINIMAL_AGENT_MODEL).toBe("model-x")
    expect("MINIMAL_AGENT_CREDENTIAL_NAME" in env).toBe(false)
    // A model that hides reasoning has no effort var.
    expect("MINIMAL_AGENT_EFFORT" in env).toBe(false)

    expect(loader.events.map(([name]) => name)).toEqual([
      TARGET_DID_SWITCH,
      TARGET_DID_SWITCH,
      TARGET_DID_SWITCH,
    ])
    expect(loader.events[2]?.[1]).toEqual({
      from: { providerId: "alpha", credentialName: "work", model: "model-b", effort: undefined },
      to: { providerId: "beta", model: "model-x", effort: undefined },
    })
    expect(loader.targetSource?.()).toMatchObject({ providerId: "beta", model: "model-x" })
  })

  it("a change to the same target does nothing, and the returned function stops it", () => {
    const core = buildCore()
    const loader = fakeLoader()
    const env: NodeJS.ProcessEnv = {}
    const stop = followLiveTarget(core, { loader, env, hidesReasoning: () => false })
    core.setModel("model-a")
    expect(loader.events).toEqual([])
    expect(env).toEqual({})
    stop()
    core.setModel("model-b")
    expect(loader.events).toEqual([])
  })

  it("works with no loader (plugins disabled)", () => {
    const core = buildCore()
    const env: NodeJS.ProcessEnv = {}
    followLiveTarget(core, { loader: null, env, hidesReasoning: () => false })
    core.setModel("model-b")
    expect(env.MINIMAL_AGENT_MODEL).toBe("model-b")
  })
})

describe("publishTargetEnv", () => {
  it("removes each value that the target does not have", () => {
    const env: NodeJS.ProcessEnv = {
      MINIMAL_AGENT_PROVIDER: "old",
      MINIMAL_AGENT_CREDENTIAL_NAME: "old",
      MINIMAL_AGENT_EFFORT: "high",
    }
    publishTargetEnv(env, { model: "m" }, () => true)
    expect(env).toEqual({ MINIMAL_AGENT_MODEL: "m" })
  })

  it("falls back to medium when the registry does not know the model", () => {
    const env: NodeJS.ProcessEnv = {}
    publishTargetEnv(env, { model: "unknown-model", providerId: "nobody" }, () => false)
    expect(env.MINIMAL_AGENT_EFFORT).toBe("medium")
  })
})
