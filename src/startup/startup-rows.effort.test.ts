/**
 * Regression: dual-registered bare model ids (e.g. the same slug under both
 * a first-party provider and a gateway) must validate effort against the
 * SELECTED provider's caps, not unscoped last-write-wins. Lead ModelInfo said
 * low|medium|high (first-party) but child boot fatally rejected low with
 * supported medium|high|max (gateway last-write).
 *
 * Provider / surface ids here are intentionally generic so this test stays
 * outside the provider-token architecture baseline.
 *
 * @module host/startup/startup-rows.effort.test
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { clearModelRegistry, registerModel } from "@minimal-agent/core/host/model-registry"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import { makeCharRatioEstimator } from "@minimal-agent/core/plugin-api/llm/token-estimate"

import { setStartupTreeVisible } from "../ui/startup/tree.ts"
import { modelDefaultEffort } from "./provider-presentation.ts"
import {
  printStartupConfigRows,
  publishResolvedRequestEnv,
  validateStartupEffort,
} from "./startup-rows.ts"

const RATE = {
  inputUSD: 1,
  outputUSD: 2,
  cacheWriteUSD: 1,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
}

const SHARED = "dual-effort-model"

function registerDual(): void {
  registerModel({
    id: SHARED,
    providerId: "firstparty",
    surfaceId: "responses",
    displayName: "Dual Effort (First-party)",
    capabilities: {
      ...defaultCapabilities(),
      effort: { levels: ["low", "medium", "high"], default: "high" },
    },
    pricing: RATE,
    estimateTokens: makeCharRatioEstimator(3.5),
  })
  // Register second so unscoped findModel last-write-wins to the gateway.
  registerModel({
    id: SHARED,
    providerId: "gateway",
    surfaceId: "chat-completions",
    displayName: "Dual Effort (Gateway)",
    capabilities: {
      ...defaultCapabilities(),
      effort: { levels: ["medium", "high", "max"], default: "medium" },
    },
    pricing: RATE,
    estimateTokens: makeCharRatioEstimator(3.5),
  })
}

describe("validateStartupEffort provider scoping", () => {
  beforeEach(() => {
    clearModelRegistry()
    registerDual()
  })
  afterEach(() => {
    clearModelRegistry()
  })

  it("allows effort=low when the selected provider is firstparty (not gateway last-write)", () => {
    expect(() => validateStartupEffort(false, SHARED, "low", "firstparty")).not.toThrow()
  })

  it("rejects effort=low when the selected provider is gateway", () => {
    expect(() => validateStartupEffort(false, SHARED, "low", "gateway")).toThrow(
      /medium, high, max/,
    )
  })

  it("rejects effort=max on firstparty (first-party levels have no max)", () => {
    expect(() => validateStartupEffort(false, SHARED, "max", "firstparty")).toThrow(
      /low, medium, high/,
    )
  })

  it("no-ops when hidesReasoning is true", () => {
    expect(() => validateStartupEffort(true, SHARED, "low", "gateway")).not.toThrow()
  })

  it("allows effort=xhigh when the selected model declares it", () => {
    registerModel({
      id: "xhigh-model",
      providerId: "firstparty",
      surfaceId: "responses",
      displayName: "XHigh",
      capabilities: {
        ...defaultCapabilities(),
        effort: { levels: ["low", "medium", "high", "xhigh"], default: "high" },
      },
      pricing: RATE,
      estimateTokens: makeCharRatioEstimator(3.5),
    })
    expect(() => validateStartupEffort(false, "xhigh-model", "xhigh", "firstparty")).not.toThrow()
  })
})

describe("model default effort display", () => {
  const savedEffort = process.env.MINIMAL_AGENT_EFFORT
  beforeEach(() => {
    clearModelRegistry()
    registerDual()
  })
  afterEach(() => {
    clearModelRegistry()
    setStartupTreeVisible(false)
    if (savedEffort === undefined) delete process.env.MINIMAL_AGENT_EFFORT
    else process.env.MINIMAL_AGENT_EFFORT = savedEffort
  })

  it("reads the default of the selected provider's model", () => {
    expect(modelDefaultEffort(SHARED, "firstparty")).toBe("high")
    expect(modelDefaultEffort(SHARED, "gateway")).toBe("medium")
  })

  it("falls back to medium for an unknown model", () => {
    expect(modelDefaultEffort("no-such-model", "firstparty")).toBe("medium")
  })

  it("the effort row prints the model default, not a fixed medium", () => {
    setStartupTreeVisible(true)
    const rows: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      rows.push(args.map(String).join(" "))
    }
    try {
      printStartupConfigRows("firstparty", {
        selectedModel: SHARED,
        speedFast: false,
        serviceTier: undefined,
        thinkingDisplay: undefined,
        effort: undefined,
        effortSource: undefined,
        cacheTtl: "5m",
        cacheTtlSource: "default",
      })
    } finally {
      console.error = original
    }
    const effortRow = rows.find((r) => r.includes("effort   ")) ?? ""
    expect(effortRow).toContain("high")
    expect(effortRow).toContain("(default)")
    expect(effortRow).not.toContain("medium")
  })

  it("publishes the model default effort into the env", () => {
    publishResolvedRequestEnv(false, undefined, false, SHARED, "firstparty")
    expect(process.env.MINIMAL_AGENT_EFFORT).toBe("high")
    publishResolvedRequestEnv(false, "xhigh", false, SHARED, "firstparty")
    expect(process.env.MINIMAL_AGENT_EFFORT).toBe("xhigh")
    publishResolvedRequestEnv(false, undefined, false)
    expect(process.env.MINIMAL_AGENT_EFFORT).toBe("medium")
  })
})
