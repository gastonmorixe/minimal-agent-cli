/**
 * Startup provider boot: resume credential-pin skip goes through diag, not stderr.
 *
 * Provider ids in fixtures are intentionally neutral (`alpha` / `beta`) —
 * core architecture forbids real provider tokens in `src/` code.
 *
 * @module host/startup/provider-boot.test
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  defaultAuthStore,
  resetDefaultAuthStoreForTests,
} from "@minimal-agent/core/host/auth-store"
import { getDiagnosticBus, type LogEvent, Severity } from "@minimal-agent/core/host/diagnostics"
import { clearModelRegistry, clearProviderRegistry } from "@minimal-agent/core/host/model-registry"
import { clearProviderPlugins } from "@minimal-agent/core/host/provider-plugin"
import { registerTestProvider } from "@minimal-agent/core/testing/provider-fixture"

import { resolveStartupProviderState } from "./provider-boot.ts"

describe("resolveStartupProviderState resume pin skip", () => {
  const prevTestAuth = process.env.MINIMAL_AGENT_TEST_AUTH
  let events: LogEvent[] = []
  let unsubscribe: (() => void) | undefined

  beforeEach(() => {
    // `resetDiagnosticBus()` is not part of the `./host/diagnostics` public
    // surface (see that barrel's doc comment — only its boot-emitting half
    // is exported; the test-reset helper didn't make the cut). Not needed
    // here anyway: each test's own "*" subscription below only appends to
    // its own `events` array, so a listener some other test file left on
    // the process-wide singleton can't pollute these assertions, and
    // `afterEach` already disposes this test's own listener.
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    events = []
    unsubscribe = getDiagnosticBus().on("*", (e) => events.push(e))
    process.env.MINIMAL_AGENT_TEST_AUTH = "1"
    registerTestProvider({
      id: "beta",
      displayName: "Beta",
      models: [{ id: "beta-fast", displayName: "Beta Fast" }],
    })
  })

  afterEach(() => {
    unsubscribe?.()
    unsubscribe = undefined
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    if (prevTestAuth === undefined) delete process.env.MINIMAL_AGENT_TEST_AUTH
    else process.env.MINIMAL_AGENT_TEST_AUTH = prevTestAuth
  })

  it("REGRESSION: provider-mismatched resume pin emits diag.warn, not console.error", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {})
    try {
      const state = await resolveStartupProviderState({
        opts: {
          model: "beta-fast",
          provider: "beta",
        },
        userConfig: {},
        env: {},
        resumeCredentialName: "alpha-oauth-2",
        resumeProviderId: "alpha",
      })

      expect(state.selectedProviderId).toBe("beta")
      expect(state.credentialName).toBeUndefined()

      const pinWarns = events.filter(
        (e) => e.source === "auth.resume-pin" && e.severity === Severity.Warning,
      )
      expect(pinWarns).toHaveLength(1)
      expect(pinWarns[0]?.message).toContain('pin "alpha-oauth-2" skipped')
      expect(pinWarns[0]?.message).toContain("session was alpha")
      expect(pinWarns[0]?.message).toContain("using beta default")
      expect(pinWarns[0]?.structuredData).toEqual({
        pin: "alpha-oauth-2",
        "session-provider": "alpha",
        "selected-provider": "beta",
      })

      const painted = errSpy.mock.calls
        .map((args) => args.map(String).join(" "))
        .filter((line) => line.includes("alpha-oauth-2") || line.includes("auth.resume-pin"))
      expect(painted).toEqual([])
    } finally {
      errSpy.mockRestore()
    }
  })

  it("does not emit auth.resume-pin when session provider matches", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {})
    try {
      const state = await resolveStartupProviderState({
        opts: {
          model: "beta-fast",
          provider: "beta",
          cliCredentialName: "Beta Default Cred",
        },
        userConfig: {},
        env: {},
        resumeCredentialName: "Beta Default Cred",
        resumeProviderId: "beta",
      })

      expect(state.credentialName).toBe("Beta Default Cred")
      expect(events.filter((e) => e.source === "auth.resume-pin")).toEqual([])
    } finally {
      errSpy.mockRestore()
    }
  })

  describe("--credential-name by stable id", () => {
    const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "ma-boot-cred-id-"))
      process.env.MINIMAL_AGENT_AUTH_FILE = join(dir, "auth.jsonc")
      resetDefaultAuthStoreForTests()
      clearProviderPlugins()
      clearModelRegistry()
      clearProviderRegistry()
      registerTestProvider({
        id: "beta",
        displayName: "Beta",
        models: [{ id: "beta-fast", displayName: "Beta Fast" }],
        apiKeyAuth: {
          serviceId: "beta-key",
          displayName: "Beta Key",
          buildCredential: (apiKey) => ({
            serviceId: "beta-key",
            displayName: "Beta Key",
            secrets: { apiKey },
          }),
          readApiKey: (s) => (typeof s.apiKey === "string" ? s.apiKey : null),
        },
      })
      const store = defaultAuthStore()
      store.set("beta-key", "beta-key-1", { apiKey: "k1", email: "me@example.com" })
      store.set("beta-key", "beta-key-2", {
        apiKey: "k2",
        email: "dup@example.com",
        accountId: "acc-2",
      })
      store.set("beta-key", "beta-key-3", { apiKey: "k3", email: "dup@example.com" })
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
      resetDefaultAuthStoreForTests()
      if (prevAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
      else process.env.MINIMAL_AGENT_AUTH_FILE = prevAuthFile
    })

    const boot = (cliCredentialName: string) =>
      resolveStartupProviderState({
        opts: { model: "beta-fast", provider: "beta", cliCredentialName },
        userConfig: {},
        env: {},
      })

    it("resolves an email to the stored name and pins that name", async () => {
      expect((await boot("ME@example.com")).credentialName).toBe("beta-key-1")
    })

    it("resolves an account id", async () => {
      expect((await boot("acc-2")).credentialName).toBe("beta-key-2")
    })

    it("fails on an ambiguous id and lists the matches", async () => {
      await expect(boot("dup@example.com")).rejects.toThrow(
        'credential "dup@example.com" matches 2 credentials for provider "beta": beta-key-2, beta-key-3',
      )
    })
  })

  it("normalizes a former provider id to the canonical id and warns once", async () => {
    clearProviderPlugins()
    clearModelRegistry()
    clearProviderRegistry()
    const handle = registerTestProvider({
      id: "beta",
      displayName: "Beta",
      models: [{ id: "beta-fast", displayName: "Beta Fast" }],
    })
    ;(handle.plugin as { formerIds?: readonly string[] }).formerIds = ["beta-old"]

    const state = await resolveStartupProviderState({
      opts: { model: "beta-fast", provider: "beta-old" },
      userConfig: {},
      env: {},
      resumeCredentialName: "beta-key-2",
      resumeProviderId: "beta-old",
    })

    expect(state.selectedProviderId).toBe("beta")
    expect(state.credentialName).toBe("beta-key-2")
    const renamed = events.filter((e) => e.source === "provider.renamed")
    expect(renamed).toHaveLength(1)
    expect(renamed[0]?.message).toBe('provider "beta-old" is now "beta"')
    expect(renamed[0]?.severity).toBe(Severity.Warning)
  })
})
