/**
 * Tests for `/provider` (alias `/credential-name`), `/model` and `/effort`,
 * on a real `AgentCore` with fixture providers. No auth store is read: the
 * credential list and the auth resolver are injected.
 */

import { afterEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "@minimal-agent/core/host/auth"
import type { CredentialedProvider } from "@minimal-agent/core/host/auth-strategies"
import { clearModelRegistry, clearProviderRegistry } from "@minimal-agent/core/host/model-registry"
import { clearProviderPlugins } from "@minimal-agent/core/host/provider-plugin"
import type { CommandContext, CommandResult } from "@minimal-agent/core/plugin-api/types/plugin"
import { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import { registerTestProvider } from "@minimal-agent/core/testing/provider-fixture"

import {
  createTargetHostCommands,
  registerTargetHostCommands,
  type TargetCommandDeps,
} from "./target-commands.ts"

const AUTH: AuthResult = { type: "api-key", token: "boot-token" }
const EFFORT = { levels: ["low", "high"], default: "low" }

const noopLog = {
  emergency: () => {},
  alert: () => {},
  critical: () => {},
  error: () => {},
  warn: () => {},
  notice: () => {},
  info: () => {},
  debug: () => {},
}

function ctx(name: string, argv: string): CommandContext {
  return {
    name,
    argv,
    rawLine: `/${name} ${argv}`.trim(),
    cwd: process.cwd(),
    env: {},
    abort: new AbortController().signal,
    log: noopLog,
    emit: () => {},
  }
}

/** Provider `alpha` (2 models with effort) and `beta` (1 shared model, 1 with no effort). */
function registerProviders(): void {
  registerTestProvider({
    id: "alpha",
    displayName: "Alpha",
    models: [
      { id: "shared", capabilities: { effort: { ...EFFORT } } },
      { id: "alpha-only", capabilities: { effort: { ...EFFORT } } },
    ],
  })
  registerTestProvider({
    id: "beta",
    displayName: "Beta",
    models: [{ id: "shared", capabilities: { effort: { ...EFFORT } } }, { id: "beta-plain" }],
  })
}

const entry = (providerId: string, credentialName?: string, usable = true): CredentialedProvider =>
  ({
    providerId,
    displayName: providerId,
    authKind: "api-key",
    ...(credentialName !== undefined ? { credentialName } : {}),
    credentialInfo: { usable },
  }) as unknown as CredentialedProvider

interface Harness {
  core: AgentCore
  auths: string[]
  run(name: string, argv?: string): Promise<CommandResult>
}

function harness(
  credentials: CredentialedProvider[],
  overrides: Partial<ConstructorParameters<typeof AgentCore>[0]> = {},
): Harness {
  const core = new AgentCore({
    auth: AUTH,
    model: "shared",
    providerId: "alpha",
    credentialName: "work",
    effort: "high",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "", isError: false }) },
    credentialNames: (providerId) =>
      credentials
        .filter((c) => c.providerId === providerId && c.credentialName !== undefined)
        .map((c) => c.credentialName as string),
    ...overrides,
  })
  const auths: string[] = []
  const deps: TargetCommandDeps = {
    core: () => core,
    discover: () => credentials,
    resolveAuth: async (providerId, modelId, credentialName) => {
      auths.push(`${providerId}/${modelId}/${credentialName ?? ""}`)
      if (credentialName === "expired") throw new Error("no credentials")
      return { type: "api-key", token: `${providerId}-${credentialName ?? "default"}` }
    },
  }
  const commands = new Map(createTargetHostCommands(deps).map((c) => [c.spec.name, c]))
  return {
    core,
    auths,
    run: async (name, argv = "") => {
      const cmd = commands.get(name)
      if (!cmd) throw new Error(`no command ${name}`)
      return cmd.invoke(ctx(name, argv))
    },
  }
}

const CREDS = [
  entry("alpha", "work"),
  entry("alpha", "personal"),
  entry("beta", "work"),
  entry("beta", "dead", false),
  entry("beta", "expired"),
]

const lines = (r: CommandResult): string => (r.kind === "notice" ? (r.lines ?? []).join("\n") : "")
const message = (r: CommandResult): string => (r.kind === "error" ? r.message : "")

afterEach(() => {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
})

describe("/provider", () => {
  it("with no argument lists the usable credentials and marks the live one", async () => {
    registerProviders()
    const h = harness(CREDS)
    const out = lines(await h.run("provider"))
    expect(out).toContain("● alpha:work")
    expect(out).toContain("○ alpha:personal")
    expect(out).toContain("○ beta:work")
    // An unusable credential is not offered.
    expect(out).not.toContain("beta:dead")
    expect(h.core.getTarget().credentialName).toBe("work")
  })

  it("a credential of the same provider keeps the model and the effort", async () => {
    registerProviders()
    const h = harness(CREDS)
    const result = await h.run("provider", "alpha:personal")
    expect(result.kind).toBe("notice")
    expect(h.core.getTarget()).toEqual({
      providerId: "alpha",
      credentialName: "personal",
      model: "shared",
      effort: "high",
    })
    // The auth was resolved for the new credential before the switch.
    expect(h.auths).toEqual(["alpha/shared/personal"])
  })

  it("the credential gives the provider: a model that the new provider has stays", async () => {
    registerProviders()
    const h = harness(CREDS)
    await h.run("provider", "beta:work")
    expect(h.core.getTarget()).toMatchObject({
      providerId: "beta",
      credentialName: "work",
      model: "shared",
    })
  })

  it("a model that the new provider does not have must be chosen, and nothing changes", async () => {
    registerProviders()
    const h = harness(CREDS, { model: "alpha-only" })
    const before = h.core.getTarget()
    const result = await h.run("provider", "beta:work")
    expect(message(result)).toContain('"alpha-only" is not a model of Beta')
    expect(message(result)).toContain("shared, beta-plain")
    expect(h.core.getTarget()).toEqual(before)
    expect(h.auths).toEqual([])
  })

  it("a named model is used, and an effort that it does not have resets", async () => {
    registerProviders()
    const h = harness(CREDS)
    const out = lines(await h.run("provider", "beta:work beta-plain"))
    expect(h.core.getTarget()).toEqual({
      providerId: "beta",
      credentialName: "work",
      model: "beta-plain",
      effort: undefined,
    })
    expect(out).toContain('effort reset from "high"')
  })

  it("a model of a different provider is refused, and nothing changes", async () => {
    registerProviders()
    const h = harness(CREDS)
    const before = h.core.getTarget()
    expect(message(await h.run("provider", "beta:work alpha-only"))).toContain("cannot switch")
    expect(h.core.getTarget()).toEqual(before)
  })

  it("a bare name that two providers have is refused with the choices", async () => {
    registerProviders()
    const h = harness(CREDS)
    const result = await h.run("provider", "work")
    expect(message(result)).toContain("more than one credential")
    expect(message(result)).toContain("alpha:work, beta:work")
  })

  it("a bare name that only one row has is accepted", async () => {
    registerProviders()
    const h = harness(CREDS)
    await h.run("provider", "personal")
    expect(h.core.getTarget().credentialName).toBe("personal")
  })

  it("an unknown credential is refused with the list", async () => {
    registerProviders()
    const h = harness(CREDS)
    expect(message(await h.run("provider", "ghost"))).toContain('unknown credential "ghost"')
  })

  it("a credential whose auth does not resolve changes nothing", async () => {
    registerProviders()
    const h = harness(CREDS)
    const before = h.core.getTarget()
    expect(message(await h.run("provider", "beta:expired"))).toContain("no credentials")
    expect(h.core.getTarget()).toEqual(before)
  })

  it("/credential-name is the same command", async () => {
    registerProviders()
    const h = harness(CREDS)
    await h.run("credential-name", "alpha:personal")
    expect(h.core.getTarget().credentialName).toBe("personal")
  })
})

describe("/model", () => {
  it("with no argument lists only the models of the live provider", async () => {
    registerProviders()
    const h = harness(CREDS)
    const out = lines(await h.run("model"))
    expect(out).toContain("● shared")
    expect(out).toContain("○ alpha-only")
    expect(out).not.toContain("beta-plain")
  })

  it("sets a model of the live provider", async () => {
    registerProviders()
    const h = harness(CREDS)
    await h.run("model", "alpha-only")
    expect(h.core.getTarget()).toMatchObject({ providerId: "alpha", model: "alpha-only" })
  })

  it("refuses a model of a different provider, and nothing changes", async () => {
    registerProviders()
    const h = harness(CREDS)
    const result = await h.run("model", "beta-plain")
    expect(message(result)).toContain('cannot set model "beta-plain"')
    expect(h.core.getTarget().model).toBe("shared")
  })
})

describe("/effort", () => {
  it("with no argument lists the levels of the live model", async () => {
    registerProviders()
    const h = harness(CREDS)
    const out = lines(await h.run("effort"))
    expect(out).toContain("○ low")
    expect(out).toContain("● high")
    expect(out).toContain("○ default")
  })

  it("sets a level, and `default` clears it", async () => {
    registerProviders()
    const h = harness(CREDS)
    await h.run("effort", "low")
    expect(h.core.getTarget().effort).toBe("low")
    await h.run("effort", "default")
    expect(h.core.getTarget().effort).toBeUndefined()
  })

  it("refuses a level that the model does not have", async () => {
    registerProviders()
    const h = harness(CREDS)
    const result = await h.run("effort", "max")
    expect(message(result)).toContain('cannot set effort "max"')
    expect(message(result)).toContain("low, high, default")
    expect(h.core.getTarget().effort).toBe("high")
  })

  it("says so when the model has no effort levels", async () => {
    registerProviders()
    const h = harness(CREDS, { providerId: "beta", model: "beta-plain", effort: undefined })
    expect(lines(await h.run("effort"))).toContain("has no effort levels")
  })
})

describe("registerTargetHostCommands", () => {
  it("registers the four commands, and does nothing with no loader", () => {
    registerProviders()
    const names: string[] = []
    const deps = {} as TargetCommandDeps
    const loader = {
      registerHostCommand: (cmd: { spec: { name: string } }) => {
        names.push(cmd.spec.name)
        return true
      },
    }
    expect(registerTargetHostCommands(loader, deps)).toBe(4)
    expect(names).toEqual(["provider", "credential-name", "model", "effort"])
    expect(registerTargetHostCommands(null, deps)).toBe(0)
  })
})
