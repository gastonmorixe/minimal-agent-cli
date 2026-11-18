/** Tests for the target of a resumed session (the newest `target_switch` record). */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CredentialedProvider } from "@minimal-agent/core/host/auth-strategies"
import { SessionStore } from "@minimal-agent/core/host-kit/session-store"

import { parseCliOptions } from "../cli/parse-argv.ts"
import {
  type ResumeTargetDeps,
  readSavedTarget,
  resumeTargetFlags,
  type SavedTarget,
} from "./resume-target.ts"

const SAVED: SavedTarget = { providerId: "beta", credentialName: "second", model: "m2" }

function deps(over: Partial<ResumeTargetDeps> & { notices?: string[] } = {}): ResumeTargetDeps {
  return {
    savedTarget: () => SAVED,
    discover: () =>
      [{ providerId: "beta", credentialName: "second" }] as unknown as CredentialedProvider[],
    effortLevels: (providerId, model) =>
      providerId === "beta" && model === "m2" ? ["low", "high"] : undefined,
    needsStoredCredential: () => true,
    notice: (m) => over.notices?.push(m),
    ...over,
  }
}

describe("resumeTargetFlags", () => {
  it("a resume with no target flag starts on the saved target", () => {
    const notices: string[] = []
    expect(resumeTargetFlags("last", {}, "high", deps({ notices }))).toEqual({
      model: "m2",
      provider: "beta",
      cliCredentialName: "second",
    })
    expect(notices).toEqual([])
  })

  it("a saved target with no credential name gives no credential flag", () => {
    const d = deps({ savedTarget: () => ({ providerId: "beta", model: "m2" }) })
    expect(resumeTargetFlags("last", {}, undefined, d)).toEqual({ model: "m2", provider: "beta" })
  })

  it("with no resume, the record is not read", () => {
    let read = 0
    const d = deps({
      savedTarget: () => {
        read++
        return SAVED
      },
    })
    expect(resumeTargetFlags(undefined, {}, "high", d)).toEqual({})
    expect(read).toBe(0)
  })

  it("each target flag wins over the record: the record is not used at all", () => {
    const notices: string[] = []
    const d = deps({ notices })
    expect(resumeTargetFlags("last", { model: "other" }, "high", d)).toEqual({})
    expect(resumeTargetFlags("last", { provider: "alpha" }, "high", d)).toEqual({})
    expect(resumeTargetFlags("last", { cliCredentialName: "work" }, "high", d)).toEqual({})
    expect(notices).toEqual([])
  })

  it("a session with no switch record changes nothing", () => {
    expect(resumeTargetFlags("last", {}, "high", deps({ savedTarget: () => null }))).toEqual({})
  })

  const bad: [string, Partial<ResumeTargetDeps>, string | undefined, string][] = [
    [
      "a provider that is not installed",
      { effortLevels: () => undefined },
      "high",
      "is not installed",
    ],
    [
      "a credential that is not stored (also a name from an edited file)",
      { discover: () => [] },
      "high",
      'credential "second" is not stored',
    ],
    [
      "a credential of an other provider with the same name",
      {
        discover: () =>
          [{ providerId: "alpha", credentialName: "second" }] as unknown as CredentialedProvider[],
      },
      "high",
      "is not stored",
    ],
    ["a record with no provider", { savedTarget: () => ({ model: "m2" }) }, "high", "no provider"],
    [
      "a record with no credential name, for a provider with no stored credential",
      { savedTarget: () => ({ providerId: "beta", model: "m2" }), discover: () => [] },
      "high",
      'provider "beta" has no stored credential',
    ],
    ["an effort of this run that the model does not have", {}, "max", 'does not have effort "max"'],
  ]
  for (const [name, over, effort, text] of bad) {
    it(`${name}: the usual target, with one notice, and no failure`, () => {
      const notices: string[] = []
      expect(resumeTargetFlags("last", {}, effort, deps({ ...over, notices }))).toEqual({})
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain(text)
      expect(notices[0]).toContain("The session starts on the usual target.")
    })
  }

  it("a record with no credential name is used when the provider has a stored credential", () => {
    const d = deps({ savedTarget: () => ({ providerId: "beta", model: "m2" }) })
    expect(resumeTargetFlags("last", {}, "high", d)).toEqual({ model: "m2", provider: "beta" })
  })

  it("a provider whose auth is not in the store (flags or env) needs no stored credential", () => {
    const d = deps({
      savedTarget: () => ({ providerId: "beta", model: "m2" }),
      discover: () => [],
      needsStoredCredential: () => false,
    })
    expect(resumeTargetFlags("last", {}, "high", d)).toEqual({ model: "m2", provider: "beta" })
  })

  const throwing: [string, Partial<ResumeTargetDeps>][] = [
    [
      "the auth store",
      {
        discover: () => {
          throw new Error("auth store is corrupt")
        },
      },
    ],
    [
      "the model registry",
      {
        effortLevels: () => {
          throw new Error("auth store is corrupt")
        },
      },
    ],
    [
      "the provider registry",
      {
        savedTarget: () => ({ providerId: "beta", model: "m2" }),
        discover: () => [],
        needsStoredCredential: () => {
          throw new Error("auth store is corrupt")
        },
      },
    ],
  ]
  for (const [name, over] of throwing) {
    it(`a throw from ${name} in a check: the usual target, with one notice, and no failure`, () => {
      const notices: string[] = []
      expect(resumeTargetFlags("last", {}, "high", deps({ ...over, notices }))).toEqual({})
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain("it could not be checked: auth store is corrupt")
    })
  }

  it("the resume argument goes to the record reader with no change (a sid, `last`)", () => {
    const seen: string[] = []
    const d = deps({
      savedTarget: (arg) => {
        seen.push(arg)
        return SAVED
      },
    })
    resumeTargetFlags("last", {}, "high", d)
    resumeTargetFlags("3333", {}, "high", d)
    expect(seen).toEqual(["last", "3333"])
  })

  const forms: [string, string[], string][] = [
    ["--resume <sid>", ["--resume", "abc-1"], "abc-1"],
    ["--resume last", ["--resume", "last"], "last"],
    ["--resume-same-sid <sid>", ["--resume-same-sid", "abc-2"], "abc-2"],
    [
      "--resume-same-sid with --resume (the first wins)",
      ["--resume", "abc-1", "--resume-same-sid", "abc-2"],
      "abc-2",
    ],
  ]
  for (const [name, argv, want] of forms) {
    it(`${name}: the parsed resume argument selects the record, and the saved target is used`, () => {
      const seen: string[] = []
      const d = deps({
        savedTarget: (arg) => {
          seen.push(arg)
          return SAVED
        },
      })
      const opts = parseCliOptions(argv, {}, {}, () => [])
      const flags = {
        model: opts.model,
        provider: opts.provider,
        cliCredentialName: opts.cliCredentialName,
      }
      expect(resumeTargetFlags(opts.effectiveResumeArg, flags, "high", d)).toEqual({
        model: "m2",
        provider: "beta",
        cliCredentialName: "second",
      })
      expect(seen).toEqual([want])
    })
  }

  it("a model flag with --resume-same-sid wins over the record", () => {
    const opts = parseCliOptions(["--resume-same-sid", "abc-2", "--model", "x"], {}, {}, () => [])
    const flags = {
      model: opts.model,
      provider: opts.provider,
      cliCredentialName: opts.cliCredentialName,
    }
    expect(resumeTargetFlags(opts.effectiveResumeArg, flags, "high", deps())).toEqual({})
  })

  it("a model with no effort levels accepts the effort of the run", () => {
    const d = deps({ effortLevels: () => [] })
    expect(resumeTargetFlags("last", {}, "high", d)).toMatchObject({ model: "m2" })
  })
})

describe("readSavedTarget (real session files)", () => {
  let dir = ""
  const prev = process.env.MINIMAL_AGENT_HOME
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-resume-target-"))
    process.env.MINIMAL_AGENT_HOME = dir
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.MINIMAL_AGENT_HOME
    else process.env.MINIMAL_AGENT_HOME = prev
    rmSync(dir, { recursive: true, force: true })
  })

  it("gives the newest switch record of the session, and null for a session with none", () => {
    const sid = "f730cc8c-3333-4333-8333-333333333333"
    const store = SessionStore.open({
      sid,
      model: "m1",
      cwd: dir,
      systemHash: "s",
      toolsHash: "t",
      agentVersion: "0.0.0",
      provider: "alpha",
      dir: join(dir, "sessions"),
    })
    store.appendUser("hello")
    expect(readSavedTarget(sid, dir)).toBeNull()
    store.appendTargetSwitch({ providerId: "alpha", model: "m1b", discardedThinking: true })
    store.appendTargetSwitch({
      providerId: "beta",
      credentialName: "second",
      model: "m2",
      effort: "low",
      discardedThinking: true,
    })
    expect(readSavedTarget(sid, dir)).toEqual(SAVED)
  })

  it("`last` gives the record of the newest session of the cwd", () => {
    const open = (sid: string): SessionStore =>
      SessionStore.open({
        sid,
        model: "m1",
        cwd: dir,
        systemHash: "s",
        toolsHash: "t",
        agentVersion: "0.0.0",
        provider: "alpha",
        dir: join(dir, "sessions"),
      })
    const older = open("c7c11b04-5555-4555-8555-555555555555")
    older.appendUser("hello")
    older.appendTargetSwitch({ providerId: "alpha", model: "old", discardedThinking: true })
    const newer = open("66666666-6666-4666-8666-666666666666")
    newer.appendUser("hello")
    newer.appendTargetSwitch({
      providerId: "beta",
      credentialName: "second",
      model: "m2",
      discardedThinking: true,
    })
    expect(readSavedTarget("last", dir)).toEqual(SAVED)
  })

  it("gives null for a session that does not exist", () => {
    expect(readSavedTarget("44444444-4444-4444-8444-444444444444", dir)).toBeNull()
  })
})
