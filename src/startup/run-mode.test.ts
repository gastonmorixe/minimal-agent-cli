/**
 * Unit tests for the run-mode fact (SPEC §3e). Each mode comes from the
 * real argv path (normalizeArgs, extractPromptFromArgs, isReplRun), with
 * explicit TTY booleans and env. A light check proves that main.ts gives
 * the getter to `PluginLoader.load`.
 *
 * @module host/startup/run-mode.test
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { PluginLoaderOptions } from "@minimal-agent/core/host-kit/plugin-loader"

import { normalizeArgs } from "../cli/cli-args.ts"
import { extractPromptFromArgs } from "../cli/extract-prompt.ts"

import { isHostModeRun, isReplRun } from "./resume-mode.ts"
import {
  cliRunMode,
  computeRunModeFact,
  detectRunMode,
  type RunModeInputs,
  runModeGetter,
} from "./run-mode.ts"

type Opts = {
  command?: string
  outputFormat?: string
  tty?: boolean
  env?: Record<string, string | undefined>
  dryRun?: boolean
}

function inputsFor(raw: string[], o: Opts = {}): RunModeInputs {
  const command = o.command ?? "run"
  return {
    replRoute: isReplRun(extractPromptFromArgs(normalizeArgs(raw)), command),
    hostMode: isHostModeRun(command),
    outputFormat: o.outputFormat ?? "text",
    stdinTTY: o.tty ?? true,
    stdoutTTY: o.tty ?? true,
    env: o.env ?? {},
    dryRun: o.dryRun ?? false,
  }
}

const SUB_ENV = {
  MINIMAL_AGENT_SUBAGENT_ID: "A2",
  MINIMAL_AGENT_SUBAGENT_ROLE: "worker",
  MINIMAL_AGENT_SUBAGENT_LEAD: "lead-sid",
}

describe("detectRunMode", () => {
  it("no prompt + TTY: repl, interactive", () => {
    expect(detectRunMode(inputsFor([]))).toEqual({ mode: "repl", interactive: true })
  })

  it("no prompt, no TTY: repl, not interactive", () => {
    expect(detectRunMode(inputsFor([], { tty: false }))).toEqual({
      mode: "repl",
      interactive: false,
    })
  })

  it("repl with only stdout on a TTY: not interactive", () => {
    const f = detectRunMode({ ...inputsFor([]), stdinTTY: false })
    expect(f.interactive).toBe(false)
  })

  it("-p x: one-shot", () => {
    expect(detectRunMode(inputsFor(["-p", "x"]))).toEqual({ mode: "one-shot", interactive: false })
  })

  it("--prompt x --output-format json: one-shot", () => {
    const f = detectRunMode(inputsFor(["--prompt", "x"], { outputFormat: "json" }))
    expect(f.mode).toBe("one-shot")
  })

  it("--prompt x --output-format stream-json: stream-json", () => {
    const f = detectRunMode(inputsFor(["--prompt", "x"], { outputFormat: "stream-json" }))
    expect(f).toEqual({ mode: "stream-json", interactive: false })
  })

  it("no prompt + stream-json: repl (the REPL route wins)", () => {
    expect(detectRunMode(inputsFor([], { outputFormat: "stream-json" })).mode).toBe("repl")
  })

  it("host-mode command: host", () => {
    const f = detectRunMode(inputsFor(["--host-mode", "acp"], { command: "host-mode" }))
    expect(f).toEqual({ mode: "host", interactive: false })
  })

  it("sub-agent env wins over stream-json", () => {
    const f = detectRunMode(
      inputsFor(["--prompt", "x"], { outputFormat: "stream-json", env: SUB_ENV }),
    )
    expect(f).toEqual({
      mode: "subagent",
      interactive: false,
      subagent: { id: "A2", role: "worker", leadSid: "lead-sid" },
    })
  })

  it("sub-agent env wins over repl and host", () => {
    expect(detectRunMode(inputsFor([], { env: SUB_ENV })).mode).toBe("subagent")
    const host = inputsFor([], { command: "host-mode", env: SUB_ENV })
    expect(detectRunMode(host).mode).toBe("subagent")
  })

  it("MINIMAL_AGENT_SUBAGENT_SID alone gives subagent; blank id does not", () => {
    const sid = detectRunMode(inputsFor([], { env: { MINIMAL_AGENT_SUBAGENT_SID: "s1" } }))
    expect(sid.subagent).toEqual({ id: "s1" })
    const blank = detectRunMode(inputsFor([], { env: { MINIMAL_AGENT_SUBAGENT_ID: "  " } }))
    expect(blank.mode).toBe("repl")
  })

  it("dryRun and providerId are set when given", () => {
    const f = detectRunMode({
      ...inputsFor(["-p", "x"], { dryRun: true }),
      providerId: "anthropic",
    })
    expect(f).toEqual({
      mode: "one-shot",
      interactive: false,
      dryRun: true,
      providerId: "anthropic",
    })
  })

  it("computeRunModeFact is the same function", () => {
    expect(computeRunModeFact).toBe(detectRunMode)
  })
})

describe("runModeGetter", () => {
  it("reads the live provider on each call (after a /model rebind)", () => {
    let live: string | undefined = "anthropic"
    const get = runModeGetter(inputsFor([]), () => live)
    expect(get().providerId).toBe("anthropic")
    live = "openai"
    expect(get().providerId).toBe("openai")
    live = undefined
    expect(get()).toEqual({ mode: "repl", interactive: true })
  })

  it("fits PluginLoaderOptions.runMode", () => {
    const opts: Pick<PluginLoaderOptions, "runMode"> = {
      runMode: runModeGetter(inputsFor(["-p", "x"]), () => undefined),
    }
    expect(opts.runMode?.()?.mode).toBe("one-shot")
  })

  it("main.ts gives the getter to PluginLoader.load", () => {
    const src = readFileSync(join(import.meta.dir, "..", "main.ts"), "utf8")
    const start = src.indexOf("PluginLoader.load({")
    const end = src.indexOf("}).then(dryRun.checked)", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(src.slice(start, end)).toMatch(/runMode:\s*cliRunMode\(/)
  })
})

describe("cliRunMode", () => {
  const base = {
    commandPlan: { command: "run" },
    opts: { outputFormat: "text" },
    env: {},
    dryRun: { on: false },
    stdinTTY: true,
    stdoutTTY: true,
  }

  it("REPL argv: replRoute true, repl fact with the live provider", () => {
    let live = "anthropic"
    const r = cliRunMode({ ...base, args: [] }, () => live)
    expect(r.replRoute).toBe(true)
    expect(r.get()).toEqual({ mode: "repl", interactive: true, providerId: "anthropic" })
    live = "openai"
    expect(r.get().providerId).toBe("openai")
  })

  it("stream-json prompt + --dry-run: stream-json, dryRun", () => {
    const r = cliRunMode(
      {
        ...base,
        args: ["--prompt", "x"],
        opts: { outputFormat: "stream-json" },
        dryRun: { on: true },
      },
      () => undefined,
    )
    expect(r.replRoute).toBe(false)
    expect(r.get()).toEqual({ mode: "stream-json", interactive: false, dryRun: true })
  })

  it("host-mode command: host, not the REPL route", () => {
    const r = cliRunMode(
      { ...base, args: ["--host-mode", "acp"], commandPlan: { command: "host-mode" } },
      () => undefined,
    )
    expect(r.replRoute).toBe(false)
    expect(r.get().mode).toBe("host")
  })

  it("sub-agent env: subagent", () => {
    const r = cliRunMode({ ...base, args: ["-p", "x"], env: SUB_ENV }, () => undefined)
    expect(r.get().mode).toBe("subagent")
  })
})
