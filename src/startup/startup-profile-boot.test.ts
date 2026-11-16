import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readStartupProfileFile } from "@minimal-agent/core/host/startup-profile"
import type {
  HostPolicySnapshot,
  StartupProfile,
} from "@minimal-agent/core/plugin-api/types/startup-profile"

import { parseCliOptions } from "../cli/parse-argv.ts"
import { resolvePluginPromptsForBoot } from "../cli/plugin-prompts-resolution.ts"
import { resolveSystemPromptOverridesForStartup } from "../cli/system-prompt-override-resolution.ts"
import { prepareEntrypointArgs } from "./entry-args.ts"
import {
  buildStartupProfile,
  hostPolicySnapshot,
  loadStartupProfileArg,
  resolveBootPluginOverrides,
  resolveNoAgentsMd,
  type StartupProfileInput,
  startupProfileArg,
  wireStartupProfile,
  writeLeadStartupProfile,
} from "./startup-profile-boot.ts"

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ma-startup-profile-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const BASE_INPUT: StartupProfileInput = {
  systemPrompt: {},
  noAgentsMd: false,
  pluginPrompts: { all: false, suppress: new Set(), keep: new Set() },
  plugins: { forceDisabled: new Set(), forceEnabled: new Set() },
  bare: false,
  tools: null,
}

const PROFILE: StartupProfile = {
  version: 1,
  systemPrompt: {
    instructions: { kind: "omit" },
    identity: { kind: "replace", text: "LEAD IDENTITY" },
  },
  noAgentsMd: true,
  pluginPrompts: { all: true, suppress: ["web"], keep: ["memory"] },
  plugins: { disable: ["foo"], enable: ["bar"] },
  bare: true,
  tools: { kind: "list", names: ["Grep", "Read"] },
}

function writeProfile(p: unknown = PROFILE): string {
  const path = join(tempDir(), "lead.profile.json")
  writeFileSync(path, typeof p === "string" ? p : JSON.stringify(p))
  return path
}

function loaded(p: StartupProfile = PROFILE) {
  return { path: "/x/lead.profile.json", profile: p }
}

const noFormatter = (raw: string): string[] => [raw]

describe("buildStartupProfile", () => {
  it("defaults give an empty, all-tools profile", () => {
    expect(buildStartupProfile(BASE_INPUT)).toEqual({
      version: 1,
      systemPrompt: {},
      noAgentsMd: false,
      pluginPrompts: { all: false, suppress: [], keep: [] },
      plugins: { disable: [], enable: [] },
      bare: false,
      tools: { kind: "all" },
    })
  })

  it("copies resolved system prompt parts and the unsafe switch", () => {
    const p = buildStartupProfile({
      ...BASE_INPUT,
      systemPrompt: {
        loopSafety: { kind: "omit" },
        providerPreamble: { kind: "replace", text: "file contents" },
        unsafeProviderOverrides: true,
      },
    })
    expect(p.systemPrompt).toEqual({
      loopSafety: { kind: "omit" },
      providerPreamble: { kind: "replace", text: "file contents" },
      unsafeProviderOverrides: true,
    })
  })

  it("stores override FILE CONTENTS, not the path", () => {
    const file = join(tempDir(), "instr.md")
    writeFileSync(file, "INSTRUCTIONS FROM FILE")
    const resolved = resolveSystemPromptOverridesForStartup({
      args: ["--system-instructions-file", file],
      env: {},
      config: {},
    })
    const p = buildStartupProfile({ ...BASE_INPUT, systemPrompt: resolved })
    expect(p.systemPrompt.instructions).toEqual({ kind: "replace", text: "INSTRUCTIONS FROM FILE" })
    expect(JSON.stringify(p)).not.toContain(file)
  })

  it("copies noAgentsMd and bare", () => {
    const p = buildStartupProfile({ ...BASE_INPUT, noAgentsMd: true, bare: true })
    expect(p.noAgentsMd).toBe(true)
    expect(p.bare).toBe(true)
  })

  it("copies plugin prompt suppression, sorted", () => {
    const p = buildStartupProfile({
      ...BASE_INPUT,
      pluginPrompts: { all: true, suppress: new Set(["b", "a"]), keep: new Set(["k"]) },
    })
    expect(p.pluginPrompts).toEqual({ all: true, suppress: ["a", "b"], keep: ["k"] })
  })

  it("copies plugin enable/disable sets, sorted", () => {
    const p = buildStartupProfile({
      ...BASE_INPUT,
      plugins: { forceDisabled: new Set(["z", "agents-md"]), forceEnabled: new Set(["dry-run"]) },
    })
    expect(p.plugins).toEqual({ disable: ["agents-md", "z"], enable: ["dry-run"] })
  })

  it("maps the tool policy", () => {
    expect(buildStartupProfile({ ...BASE_INPUT, tools: { kind: "deny-all" } }).tools).toEqual({
      kind: "none",
    })
    expect(
      buildStartupProfile({ ...BASE_INPUT, tools: { kind: "allow-list", tools: ["Read"] } }).tools,
    ).toEqual({ kind: "list", names: ["Read"] })
  })
})

describe("writeLeadStartupProfile", () => {
  it("writes <sessionsDir>/<sid>.profile.json that core parses back", () => {
    const dir = tempDir()
    const path = writeLeadStartupProfile(dir, "sid-1", PROFILE)
    expect(path).toBe(join(dir, "sid-1.profile.json"))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const back = readStartupProfileFile(path)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.value).toEqual(PROFILE)
  })
})

describe("wireStartupProfile", () => {
  function fakeLoader() {
    const calls: { profile?: unknown; policy?: () => HostPolicySnapshot | undefined } = {}
    return {
      calls,
      loader: {
        setStartupProfile: (v: unknown) => {
          calls.profile = v
        },
        setHostPolicySource: (src: () => HostPolicySnapshot | undefined) => {
          calls.policy = src
        },
      },
    }
  }
  const values = {
    noAgentsMd: true,
    pluginOverrides: { forceDisabled: new Set(["foo"]), forceEnabled: new Set<string>() },
    pluginPromptSuppression: { all: false, suppress: new Set<string>(), keep: new Set<string>() },
    opts: {
      systemPromptOverrides: {},
      bare: false,
      cliToolFilter: { kind: "deny-all" } as const,
    },
  }

  it("writes the profile and wires both ctx sources", () => {
    const home = tempDir()
    const f = fakeLoader()
    const out = wireStartupProfile(
      f.loader as never,
      null,
      () => {},
      { ...values, env: { MINIMAL_AGENT_HOME: home } },
      "sid-w",
    )
    expect(out?.path).toBe(join(home, "sessions", "sid-w.profile.json"))
    expect(f.calls.profile).toEqual(out)
    expect(JSON.parse(readFileSync(out!.path, "utf8")).plugins.disable).toEqual(["foo"])
    expect(f.calls.policy?.()).toEqual({ activeModeId: null, modes: [], tools: { kind: "none" } })
  })

  it("warns and clears ctx.startupProfile when the write fails", () => {
    const file = join(tempDir(), "not-a-dir")
    writeFileSync(file, "x")
    const f = fakeLoader()
    const warns: string[] = []
    const out = wireStartupProfile(
      f.loader as never,
      null,
      (src, msg) => warns.push(`${src}: ${msg}`),
      { ...values, env: { MINIMAL_AGENT_HOME: file } },
      "sid-w",
    )
    expect(out).toBeUndefined()
    expect(f.calls.profile).toBeUndefined()
    expect(warns.join("")).toContain("startup-profile")
    expect(f.calls.policy).toBeDefined()
  })
})

describe("hostPolicySnapshot", () => {
  it("uses the ModeManager snapshot when there is one", () => {
    const snap: HostPolicySnapshot = { activeModeId: "ask", modes: [], tools: { kind: "all" } }
    expect(hostPolicySnapshot({ policySnapshot: () => snap }, null)).toBe(snap)
  })
  it("falls back to no mode and the CLI tool filter", () => {
    expect(hostPolicySnapshot(null, { kind: "allow-list", tools: ["Read"] })).toEqual({
      activeModeId: null,
      modes: [],
      tools: { kind: "list", names: ["Read"] },
    })
  })
})

describe("--startup-profile load", () => {
  it("reads the flag in both forms", () => {
    expect(startupProfileArg(["--startup-profile", "/a"])).toBe("/a")
    expect(startupProfileArg(["--startup-profile=/b"])).toBe("/b")
    expect(startupProfileArg(["-p", "x"])).toBeUndefined()
  })

  it("no flag is ok and undefined", () => {
    expect(loadStartupProfileArg([])).toEqual({ ok: true, value: undefined })
  })

  it("a valid file loads", () => {
    const path = writeProfile()
    expect(loadStartupProfileArg(["--startup-profile", path])).toEqual({
      ok: true,
      value: { path, profile: PROFILE },
    })
  })

  it("a missing file is a fatal line", () => {
    const path = join(tempDir(), "nope.json")
    expect(loadStartupProfileArg(["--startup-profile", path])).toEqual({
      ok: false,
      message: `fatal: startup profile ${path}: not-found`,
    })
  })

  it("bad JSON and a bad field are fatal lines", () => {
    const bad = writeProfile("{nope")
    const r1 = loadStartupProfileArg(["--startup-profile", bad])
    expect(r1).toEqual({ ok: false, message: `fatal: startup profile ${bad}: invalid-json` })
    const wrong = writeProfile({ ...PROFILE, bare: "yes" })
    const r2 = loadStartupProfileArg(["--startup-profile", wrong])
    expect(r2).toEqual({
      ok: false,
      message: `fatal: startup profile ${wrong}: invalid-field bare`,
    })
  })

  it("the entry point exits 2 and prints the fatal line", () => {
    const path = join(tempDir(), "missing.profile.json")
    const writes: string[] = []
    let code: number | undefined
    try {
      prepareEntrypointArgs({
        rawArgv: ["--startup-profile", path, "hi"],
        env: {},
        cwd: tempDir(),
        stderr: { write: (s: string) => (writes.push(s), true) as unknown as boolean },
        exit: (c: number): never => {
          code = c
          throw new Error("exit")
        },
      })
    } catch (e) {
      if (code === undefined) throw e
    }
    expect(code).toBe(2)
    expect(writes.join("")).toBe(`fatal: startup profile ${path}: not-found\n`)
  })
})

describe("child tier precedence", () => {
  it("system prompt: profile beats env, CLI beats profile", () => {
    const env = {
      MINIMAL_AGENT_SYSTEM_INSTRUCTIONS: "ENV INSTR",
      MINIMAL_AGENT_SYSTEM_IDENTITY: "ENV ID",
    }
    const fromProfile = resolveSystemPromptOverridesForStartup({
      args: [],
      env,
      config: {},
      profile: PROFILE.systemPrompt,
    })
    expect(fromProfile).toEqual({
      instructions: { kind: "omit" },
      identity: { kind: "replace", text: "LEAD IDENTITY" },
    })
    const withCli = resolveSystemPromptOverridesForStartup({
      args: ["--system-instructions", "CLI INSTR"],
      env,
      config: {},
      profile: PROFILE.systemPrompt,
    })
    expect(withCli.instructions).toEqual({ kind: "replace", text: "CLI INSTR" })
    expect(withCli.identity).toEqual({ kind: "replace", text: "LEAD IDENTITY" })
  })

  it("noAgentsMd: profile false beats env 1, CLI flag beats profile", () => {
    const off = loaded({ ...PROFILE, noAgentsMd: false })
    expect(resolveNoAgentsMd([], { MINIMAL_AGENT_NO_AGENTS_MD: "1" }, off)).toBe(false)
    expect(resolveNoAgentsMd(["--no-agents"], {}, off)).toBe(true)
    expect(resolveNoAgentsMd([], { MINIMAL_AGENT_NO_AGENTS_MD: "1" }, undefined)).toBe(true)
  })

  it("plugin prompts: profile replaces env, CLI tier still wins", () => {
    const env = { MINIMAL_AGENT_PLUGIN_PROMPTS: "0" }
    const s = resolvePluginPromptsForBoot([], env, () => {}, PROFILE.pluginPrompts)
    expect(s.all).toBe(true)
    expect([...s.suppress]).toEqual(["web"])
    expect([...s.keep]).toEqual(["memory"])
    const cli = resolvePluginPromptsForBoot(
      ["--plugin-prompts", "--plugin-prompts-for", "web"],
      env,
      () => {},
      PROFILE.pluginPrompts,
    )
    expect(cli.all).toBe(false)
    expect(cli.keep.has("web")).toBe(true)
    expect(cli.suppress.has("web")).toBe(false)
  })

  it("plugins: profile replaces env and config, CLI tier still wins", () => {
    const env = { MINIMAL_AGENT_DISABLE_PLUGINS: "envoff", MINIMAL_AGENT_ENABLE_PLUGINS: "foo" }
    const config = () => ({ forceDisabled: new Set(["cfgoff"]), forceEnabled: new Set<string>() })
    const r = resolveBootPluginOverrides(loaded(), env, { disable: [], enable: [] }, config)
    expect([...r.forceDisabled]).toEqual(["foo"])
    expect([...r.forceEnabled]).toEqual(["bar"])
    const cli = resolveBootPluginOverrides(
      loaded(),
      env,
      { disable: ["intercom", "bar"], enable: ["foo"] },
      config,
    )
    expect(cli.forceDisabled.has("intercom")).toBe(true)
    expect(cli.forceDisabled.has("bar")).toBe(true)
    expect(cli.forceEnabled.has("foo")).toBe(true)
    expect(cli.forceDisabled.has("foo")).toBe(false)
    const noProfile = resolveBootPluginOverrides(
      undefined,
      env,
      { disable: [], enable: [] },
      config,
    )
    expect(noProfile.forceDisabled.has("envoff")).toBe(true)
    expect(noProfile.forceDisabled.has("cfgoff")).toBe(true)
  })

  it("bare and tools: profile applies, CLI tool flags win", () => {
    const opts = parseCliOptions([], {}, {}, noFormatter, {}, loaded())
    expect(opts.bare).toBe(true)
    expect(opts.cliToolFilter).toEqual({ kind: "allow-list", tools: ["Grep", "Read"] })
    expect(opts.startupProfile).toEqual(loaded())
    const cli = parseCliOptions(["--tools", "Bash"], {}, {}, noFormatter, {}, loaded())
    expect(cli.cliToolFilter).toEqual({ kind: "allow-list", tools: ["Bash"] })
    const none = parseCliOptions(["--no-tools"], {}, {}, noFormatter, {}, loaded())
    expect(none.cliToolFilter).toEqual({ kind: "deny-all" })
    const all = parseCliOptions([], {}, {}, noFormatter, {}, undefined)
    expect(all.cliToolFilter).toBeNull()
    expect(all.bare).toBe(false)
  })

  it("the entry point threads a valid profile into opts", () => {
    const path = writeProfile()
    const prepared = prepareEntrypointArgs({
      rawArgv: ["--startup-profile", path, "hi"],
      env: {},
      cwd: tempDir(),
      stderr: { write: () => true },
      exit: (c: number): never => {
        throw new Error(`exit ${c}`)
      },
    })
    expect(prepared.opts.startupProfile).toEqual({ path, profile: PROFILE })
    expect(prepared.opts.systemPromptOverrides.instructions).toEqual({ kind: "omit" })
    expect(prepared.opts.bare).toBe(true)
  })
})
