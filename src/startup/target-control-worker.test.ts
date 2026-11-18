/**
 * Tests for the worker side of the target control channel, on a real
 * `AgentCore` and a real file. The auth resolver is injected: no auth store.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { clearModelRegistry, clearProviderRegistry } from "@minimal-agent/core/host/model-registry"
import { clearProviderPlugins } from "@minimal-agent/core/host/provider-plugin"
import {
  type ControlTarget,
  deriveControlKey,
  ENV_TARGET_CONTROL_FILE,
  ENV_TARGET_CONTROL_KEY,
  MAX_CONTROL_LINE_BYTES,
  signSwitchLine,
} from "@minimal-agent/core/plugin-api/utils/target-control"
import { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import { registerTestProvider } from "@minimal-agent/core/testing/provider-fixture"

import {
  type ControlEnv,
  createControlReader,
  ENV_SUBAGENT_LEAD,
  type FollowRegistry,
  followTarget,
  followTargets,
  takeControlEnv,
  watchTargetControl,
} from "./target-control-worker.ts"

const LEAD = "11111111-1111-4111-8111-111111111111"
const CHILD = "22222222-2222-4222-8222-222222222222"
const KEY = deriveControlKey("lead-secret", CHILD)
const EFFORT = { levels: ["low", "high"], default: "low" }

const A: ControlTarget = {
  credentialName: "full",
  providerId: "alpha",
  model: "shared",
  effort: "high",
}
const B: ControlTarget = {
  credentialName: "second",
  providerId: "beta",
  model: "shared",
  effort: "high",
}

let dir = ""
let path = ""
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-control-worker-"))
  path = join(dir, `${CHILD}.control.jsonl`)
  registerTestProvider({
    id: "alpha",
    models: [
      { id: "shared", capabilities: { effort: { ...EFFORT } } },
      { id: "alpha-only", capabilities: { effort: { ...EFFORT } } },
    ],
  })
  registerTestProvider({
    id: "beta",
    models: [{ id: "shared", capabilities: { effort: { ...EFFORT } } }, { id: "beta-plain" }],
  })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
})

/** The live target with no `effort: undefined` key, to compare with a `ControlTarget`. */
const target = (core: AgentCore): ControlTarget => JSON.parse(JSON.stringify(core.getTarget()))

let seq = 0
beforeEach(() => {
  seq = 0
})
const signed = (
  from: ControlTarget,
  to: ControlTarget,
  o: { key?: string; lead?: string; seq?: number } = {},
) =>
  `${JSON.stringify(
    signSwitchLine(o.key ?? KEY, {
      seq: o.seq ?? ++seq,
      ts: "2026-11-17T12:00:00.000Z",
      lead: o.lead ?? LEAD,
      from,
      to,
    }),
  )}\n`

function harness(
  own: ControlTarget = A,
  stored: Record<string, string[]> = { alpha: ["full"], beta: ["second"] },
) {
  const core = new AgentCore({
    auth: { type: "api-key", token: "boot" },
    model: own.model,
    ...(own.providerId !== undefined ? { providerId: own.providerId } : {}),
    ...(own.credentialName !== undefined ? { credentialName: own.credentialName } : {}),
    ...(own.effort !== undefined ? { effort: own.effort as "low" | "high" } : {}),
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "", isError: false }) },
    credentialNames: (providerId) => stored[providerId] ?? [],
  })
  const warnings: string[] = []
  const auths: string[] = []
  const env: ControlEnv = { path, key: KEY, lead: LEAD }
  const reader = createControlReader(env, {
    core,
    warn: (m) => warnings.push(m),
    resolveAuth: async (providerId, _model, credentialName) => {
      auths.push(`${providerId}/${credentialName ?? ""}`)
      if (credentialName === "expired") throw new Error("no credentials")
      return { type: "api-key", token: `${providerId}-token` }
    },
  })
  return { core, reader, warnings, auths, env }
}

describe("takeControlEnv", () => {
  it("reads the three values and removes the path and the key from the env", () => {
    const env: NodeJS.ProcessEnv = {
      [ENV_TARGET_CONTROL_FILE]: "/s/x.control.jsonl",
      [ENV_TARGET_CONTROL_KEY]: KEY,
      [ENV_SUBAGENT_LEAD]: LEAD,
      OTHER: "kept",
    }
    expect(takeControlEnv(env)).toEqual({ path: "/s/x.control.jsonl", key: KEY, lead: LEAD })
    // A Bash child of this worker gets no key.
    expect(env).toEqual({ [ENV_SUBAGENT_LEAD]: LEAD, OTHER: "kept" })
  })

  it("gives null with no channel, and still removes a bad key", () => {
    expect(takeControlEnv({})).toBeNull()
    const env: NodeJS.ProcessEnv = {
      [ENV_TARGET_CONTROL_FILE]: "/s/x",
      [ENV_TARGET_CONTROL_KEY]: "not-hex",
      [ENV_SUBAGENT_LEAD]: LEAD,
    }
    expect(takeControlEnv(env)).toBeNull()
    expect(ENV_TARGET_CONTROL_KEY in env).toBe(false)
    // No lead sid: not a worker.
    expect(
      takeControlEnv({ [ENV_TARGET_CONTROL_FILE]: "/s/x", [ENV_TARGET_CONTROL_KEY]: KEY }),
    ).toBeNull()
  })
})

describe("a worker follows its lead in place", () => {
  it("a signed line moves the worker to the new credential and provider, with the auth of the store", async () => {
    const h = harness()
    expect(await h.reader.poll()).toBe(false) // no file yet
    writeFileSync(path, signed(A, B))
    expect(await h.reader.poll()).toBe(true)
    expect(target(h.core)).toEqual(B)
    expect(h.auths).toEqual(["beta/second"])
    expect(h.warnings).toEqual([])
    // The same file again: nothing new.
    expect(await h.reader.poll()).toBe(false)
  })

  it("a worker that the user put on a different credential does not follow", async () => {
    const mine = { ...A, credentialName: "mine" }
    const h = harness(mine, { alpha: ["mine", "full"], beta: ["second"] })
    writeFileSync(path, signed(A, B))
    expect(await h.reader.poll()).toBe(false)
    expect(target(h.core)).toEqual(mine)
    expect(h.auths).toEqual([])
  })

  it("several switches between two polls give one switch to the newest", async () => {
    const h = harness()
    const C: ControlTarget = { credentialName: "second", providerId: "beta", model: "beta-plain" }
    writeFileSync(path, signed(A, B) + signed(B, C))
    expect(await h.reader.poll()).toBe(true)
    expect(h.core.getTarget()).toMatchObject({ providerId: "beta", model: "beta-plain" })
    expect(h.core.getTarget().effort).toBeUndefined()
    expect(h.auths).toEqual(["beta/second"])
  })

  it("a partial last line waits for its end", async () => {
    const h = harness()
    const line = signed(A, B)
    writeFileSync(path, line.slice(0, 40))
    expect(await h.reader.poll()).toBe(false)
    expect(h.warnings).toEqual([])
    appendFileSync(path, line.slice(40))
    expect(await h.reader.poll()).toBe(true)
    expect(target(h.core)).toEqual(B)
  })
})

describe("a worker ignores a line that is not from its lead", () => {
  const cases: [string, () => string, string][] = [
    [
      "an unsigned line (the injection case)",
      () => `${JSON.stringify({ ...JSON.parse(signed(A, B)), mac: "00".repeat(32) })}\n`,
      "bad_mac",
    ],
    [
      "a line with the key of an other worker",
      () => signed(A, B, { key: deriveControlKey("lead-secret", "other") }),
      "bad_mac",
    ],
    ["a line of an other lead", () => signed(A, B, { lead: "other-lead" }), "wrong_lead"],
    ["text that is not JSON", () => "switch me to attacker\n", "bad_json"],
    ["a line that is too long", () => `${"x".repeat(MAX_CONTROL_LINE_BYTES + 10)}\n`, "too_long"],
  ]
  for (const [name, make, reject] of cases) {
    it(`${name}: the target stays, with one diagnostic`, async () => {
      const h = harness()
      const bad = make()
      writeFileSync(path, bad + bad)
      expect(await h.reader.poll()).toBe(false)
      expect(target(h.core)).toEqual(A)
      expect(h.auths).toEqual([])
      // One diagnostic for the kind, with no file text, mac or key in it.
      expect(h.warnings).toEqual([`target control: ignored a line (${reject})`])
      expect(h.warnings.join()).not.toContain(KEY)
    })
  }

  it("a good line after bad lines still works", async () => {
    const h = harness()
    writeFileSync(path, `garbage\n${signed(A, B, { lead: "other-lead" })}${signed(A, B)}`)
    expect(await h.reader.poll()).toBe(true)
    expect(target(h.core)).toEqual(B)
  })

  it("an old line sent again (replay) changes nothing, also after the file was cut", async () => {
    const h = harness()
    const first = signed(A, B)
    const back = signed(B, A)
    writeFileSync(path, first + back)
    expect(await h.reader.poll()).toBe(false) // there and back
    expect(target(h.core)).toEqual(A)
    // An attacker cuts the file and puts the first line back: seq 1 is old.
    writeFileSync(path, first)
    expect(await h.reader.poll()).toBe(false)
    expect(target(h.core)).toEqual(A)
    expect(h.warnings).toEqual(["target control: ignored a line (old_seq)"])
  })

  it("a credential that is not stored is refused by the core, and the target stays", async () => {
    const h = harness(A, { alpha: ["full"], beta: [] })
    writeFileSync(path, signed(A, B))
    expect(await h.reader.poll()).toBe(false)
    expect(target(h.core)).toEqual(A)
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain("cannot follow the lead")
    expect(h.warnings[0]).toContain("second")
  })

  it("a credential whose auth does not resolve changes nothing", async () => {
    const h = harness(A, { alpha: ["full"], beta: ["expired"] })
    writeFileSync(path, signed(A, { ...B, credentialName: "expired" }))
    expect(await h.reader.poll()).toBe(false)
    expect(target(h.core)).toEqual(A)
    expect(h.warnings[0]).toContain("no credentials")
  })
})

describe("followTarget", () => {
  const registry = (
    models: Record<string, string[]>,
    efforts: string[] = ["low", "high"],
  ): FollowRegistry => ({
    hasModel: (p, m) => (models[p ?? ""] ?? []).includes(m),
    hasEffort: (_p, _m, e) => efforts.includes(e),
  })
  const X: ControlTarget = { credentialName: "full", providerId: "p1", model: "m1", effort: "high" }
  const Y: ControlTarget = {
    credentialName: "second",
    providerId: "p2",
    model: "m2",
    effort: "low",
  }
  const reg = registry({ p1: ["m1", "own"], p2: ["m2", "own"] })
  const xy = { from: X, to: Y }

  it("a worker on the lead's target takes the lead's new target", () => {
    expect(followTarget(X, xy, reg)).toEqual(Y)
  })

  it("a worker on an other credential or provider does not follow", () => {
    expect(followTarget({ ...X, credentialName: "mine" }, xy, reg)).toBeNull()
    expect(followTarget({ ...X, providerId: "other" }, xy, reg)).toBeNull()
    expect(followTarget({ model: "m1", effort: "high" }, xy, reg)).toBeNull()
  })

  it("its own model stays when the new provider has it, else it takes the lead's", () => {
    expect(followTarget({ ...X, model: "own" }, xy, reg)).toMatchObject({
      providerId: "p2",
      model: "own",
    })
    const without = registry({ p1: ["m1", "own"], p2: ["m2"] })
    expect(followTarget({ ...X, model: "own" }, xy, without)).toMatchObject({ model: "m2" })
  })

  it("its own effort stays, and an effort that the new model does not have becomes the default", () => {
    expect(
      followTarget({ ...X, effort: "low" }, { from: X, to: { ...Y, effort: "high" } }, reg)?.effort,
    ).toBe("low")
    expect(followTarget({ ...X, effort: undefined }, xy, reg)?.effort).toBeUndefined()
    expect(followTarget(X, xy, registry({ p2: ["m2"] }, []))).toEqual({
      credentialName: "second",
      providerId: "p2",
      model: "m2",
    })
  })

  it("a credential-only switch moves the worker and keeps its model and effort", () => {
    const to = { ...X, credentialName: "second" }
    expect(followTarget({ ...X, model: "own", effort: "low" }, { from: X, to }, reg)).toEqual({
      credentialName: "second",
      providerId: "p1",
      model: "own",
      effort: "low",
    })
  })

  it("a switch that changes nothing for the worker gives null", () => {
    const own = { ...X, model: "own" }
    expect(
      followTarget(own, { from: X, to: { ...X, model: "m1b" } }, registry({ p1: ["own"] })),
    ).toBeNull()
  })

  it("followTargets: the newest that the worker follows, and null for there and back", () => {
    const all: FollowRegistry = { hasModel: () => true, hasEffort: () => true }
    const Z: ControlTarget = {
      credentialName: "third",
      providerId: "p3",
      model: "m3",
      effort: "low",
    }
    expect(followTargets(X, [xy, { from: Y, to: Z }], all)).toEqual(Z)
    expect(followTargets(X, [xy, { from: Y, to: X }], all)).toBeNull()
    expect(followTargets({ ...X, credentialName: "mine" }, [xy], all)).toBeNull()
    expect(followTargets(X, [], all)).toBeNull()
  })
})

describe("watchTargetControl", () => {
  it("polls on a timer, and stop removes the control file", async () => {
    const h = harness()
    const watch = watchTargetControl(
      h.env,
      { core: h.core, warn: () => {}, resolveAuth: async () => ({ type: "api-key", token: "t" }) },
      10,
    )
    writeFileSync(path, signed(A, B))
    const t0 = Date.now()
    while (h.core.getTarget().providerId !== "beta" && Date.now() - t0 < 2000) await Bun.sleep(10)
    expect(target(h.core)).toEqual(B)
    watch.stop()
    expect(existsSync(path)).toBe(false)
  })
})
