/**
 * The target control worker reports on the diagnostic bus, not on
 * `process.stderr`: a Warning for a refused or failed line, an Info line when
 * the worker followed its lead (`target-control.worker`).
 *
 * `main()` attaches the sinks before a worker session opens, so the bus is the
 * right channel there. The reader and the file are real, as in
 * `target-control-worker.test.ts`.
 *
 * @module startup/target-control-worker.diagnostics.test
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getDiagnosticBus, type LogEvent, Severity } from "@minimal-agent/core/host/diagnostics"
import { clearModelRegistry, clearProviderRegistry } from "@minimal-agent/core/host/model-registry"
import { clearProviderPlugins } from "@minimal-agent/core/host/provider-plugin"
import {
  type ControlTarget,
  deriveControlKey,
  signSwitchLine,
} from "@minimal-agent/core/plugin-api/utils/target-control"
import { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import { registerTestProvider } from "@minimal-agent/core/testing/provider-fixture"

import {
  busControlLoggers,
  type ControlEnv,
  createControlReader,
  workerSessionWrapper,
} from "./target-control-worker.ts"

const SOURCE = "target-control.worker"
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
let events: LogEvent[] = []
let unsubscribe: (() => void) | undefined
let stderrWrite: ReturnType<typeof spyOn<typeof process.stderr, "write">>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-control-diag-"))
  path = join(dir, `${CHILD}.control.jsonl`)
  registerTestProvider({
    id: "alpha",
    models: [{ id: "shared", capabilities: { effort: { ...EFFORT } } }],
  })
  registerTestProvider({
    id: "beta",
    models: [{ id: "shared", capabilities: { effort: { ...EFFORT } } }],
  })
  events = []
  unsubscribe = getDiagnosticBus().on("*", (e) => events.push(e))
  stderrWrite = spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(() => {
  stderrWrite.mockRestore()
  unsubscribe?.()
  unsubscribe = undefined
  rmSync(dir, { recursive: true, force: true })
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
})

const ours = (): LogEvent[] => events.filter((e) => e.source === SOURCE)

const makeCore = (): AgentCore =>
  new AgentCore({
    auth: { type: "api-key", token: "boot" },
    model: A.model,
    providerId: A.providerId as string,
    credentialName: A.credentialName as string,
    effort: A.effort as "low" | "high",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "", isError: false }) },
    credentialNames: (providerId) => ({ alpha: ["full"], beta: ["second"] })[providerId] ?? [],
  })

const control = (): ControlEnv => ({ path, key: KEY, lead: LEAD })

const signed = (from: ControlTarget, to: ControlTarget): string =>
  `${JSON.stringify(signSwitchLine(KEY, { seq: 1, ts: "2026-11-17T12:00:00.000Z", lead: LEAD, from, to }))}\n`

describe("busControlLoggers", () => {
  it("warn is a Warning and info is an Info, both target-control.worker, nothing on stderr", () => {
    busControlLoggers.warn("target control: something refused")
    busControlLoggers.info?.("target control: followed the lead")

    const got = ours()
    expect(got.map((e) => [e.severity, e.message])).toEqual([
      [Severity.Warning, "target control: something refused"],
      [Severity.Info, "target control: followed the lead"],
    ])
    expect(stderrWrite).not.toHaveBeenCalled()
  })
})

describe("the real control reader reports through the bus loggers", () => {
  it("a line that is not from the lead gives one Warning, no mac or key in it", async () => {
    const core = makeCore()
    const reader = createControlReader(control(), {
      core,
      resolveAuth: async () => ({ type: "api-key", token: "t" }),
      ...busControlLoggers,
    })
    writeFileSync(path, "switch me to attacker\n")
    expect(await reader.poll()).toBe(false)

    const got = ours()
    expect(got).toHaveLength(1)
    expect(got[0]?.severity).toBe(Severity.Warning)
    expect(got[0]?.message).toBe("target control: ignored a line (bad_json)")
    expect(JSON.stringify(got[0])).not.toContain(KEY)
    expect(stderrWrite).not.toHaveBeenCalled()
  })

  it("a followed switch gives an Info line", async () => {
    const core = makeCore()
    const reader = createControlReader(control(), {
      core,
      resolveAuth: async () => ({ type: "api-key", token: "beta-token" }),
      ...busControlLoggers,
    })
    writeFileSync(path, signed(A, B))
    expect(await reader.poll()).toBe(true)

    const got = ours()
    expect(got).toHaveLength(1)
    expect(got[0]?.severity).toBe(Severity.Info)
    expect(got[0]?.message).toContain("target control: followed the lead to")
    expect(stderrWrite).not.toHaveBeenCalled()
  })
})

describe("workerSessionWrapper default loggers", () => {
  it("a refused line reaches the bus, not stderr (default deps, real timer)", async () => {
    const core = makeCore()
    let onClose: (() => void) | undefined
    const session = {
      agentCore: () => core,
      onClose: (callback: () => void) => {
        onClose = callback
      },
    }
    // Default deps (the third argument is left out), a 5 ms poll for the test.
    const open = workerSessionWrapper(control(), null, undefined, 5)
    await open([], Promise.resolve(session))
    try {
      writeFileSync(path, "garbage that is not json\n")
      const deadline = Date.now() + 3000
      while (ours().length === 0 && Date.now() < deadline) await Bun.sleep(10)
    } finally {
      onClose?.() // stops the timer and removes the control file
    }

    const got = ours()
    expect(got.length).toBeGreaterThanOrEqual(1)
    expect(got[0]?.severity).toBe(Severity.Warning)
    expect(got[0]?.message).toBe("target control: ignored a line (bad_json)")
    expect(stderrWrite).not.toHaveBeenCalled()
  })
})
