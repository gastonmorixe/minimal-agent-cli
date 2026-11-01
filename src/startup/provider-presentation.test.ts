import { beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

import { clearModelRegistry, clearProviderRegistry } from "@minimal-agent/core/host/model-registry"
import {
  clearProviderPlugins,
  type ProviderPlugin,
  registerProviderPlugin,
} from "@minimal-agent/core/host/provider-plugin"
import { registerTestProvider } from "@minimal-agent/core/testing/provider-fixture"

import {
  modelHidesReasoning,
  providerWantsQuotaProbe,
  signInStepLabel,
} from "./provider-presentation.ts"

/** Provider-token screen, copied from core `architecture/provider-scan.ts`. */
const PROVIDER_TOKEN_RE =
  /\b(anthropic|claude|opus|sonnet|haiku|fable|mythos|openai|openrouter|chatgpt|gpt-\d|gpt-4o|bedrock|x-stainless|claude-cli|claude-code|gemini|mistral|google-vertex|vertexai|groq|xai|grok)\b/i

/** Remove line and block comments (the file has no comment markers in strings). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
}

/**
 * C-2 (Wave C, PLAN.md): the startup banner / welcome-card decisions that
 * USED to hardcode provider tokens (`"Anthropic (Claude)"`, `includes("haiku")`,
 * `providerId !== "anthropic"`) now read provider-supplied data + capability
 * flags. This module owns those three pure decisions so index.ts names no
 * provider.
 */
describe("C-2: provider-presentation seams", () => {
  beforeEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
  })

  describe("signInStepLabel", () => {
    it("falls back to a neutral, provider-free label with no credentials", () => {
      const label = signInStepLabel()
      expect(label.toLowerCase()).toContain("sign in")
      expect(PROVIDER_TOKEN_RE.test(label)).toBe(false)
    })
  })

  describe("modelHidesReasoning", () => {
    it("is true for a model that supports neither thinking nor effort", () => {
      registerTestProvider({
        models: [{ id: "test-cheap-1", capabilities: { effort: { levels: [] } } }],
      })
      expect(modelHidesReasoning("test-cheap-1")).toBe(true)
    })

    it("is false for a model that supports adaptive thinking", () => {
      registerTestProvider({
        models: [{ id: "test-think-1", capabilities: { thinking: { adaptive: true } } }],
      })
      expect(modelHidesReasoning("test-think-1")).toBe(false)
    })

    it("is false for a model that supports effort levels", () => {
      registerTestProvider({
        models: [{ id: "test-effort-1", capabilities: { effort: { levels: ["low", "medium"] } } }],
      })
      expect(modelHidesReasoning("test-effort-1")).toBe(false)
    })

    it("is false (show the rows) for an unknown model id", () => {
      expect(modelHidesReasoning("totally-unregistered")).toBe(false)
    })
  })

  describe("providerWantsQuotaProbe", () => {
    it("is true when the provider declares a startup quota-probe seam", () => {
      const plugin: ProviderPlugin = {
        id: "with-probe",
        displayName: "With Probe",
        shortCode: "wp",
        register() {},
        async primeSessionInfo() {},
      }
      registerProviderPlugin(plugin)
      expect(providerWantsQuotaProbe("with-probe")).toBe(true)
    })

    it("is false when the provider declares no quota-probe seam", () => {
      registerTestProvider({ id: "no-probe", models: [{ id: "test-model-1" }] })
      expect(providerWantsQuotaProbe("no-probe")).toBe(false)
    })

    it("is false for an undefined / unknown provider id", () => {
      expect(providerWantsQuotaProbe(undefined)).toBe(false)
      expect(providerWantsQuotaProbe("nope")).toBe(false)
    })
  })

  it("src/startup/provider-presentation.ts contains no provider-token literal in CODE", () => {
    const code = stripComments(
      readFileSync(new URL("./provider-presentation.ts", import.meta.url), "utf8"),
    )
    expect(PROVIDER_TOKEN_RE.test(code)).toBe(false)
  })
})
