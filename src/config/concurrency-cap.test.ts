import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  CLI_DEFAULT_MAX_CONCURRENT_TOOL_CALLS,
  resolveCliMaxConcurrentToolCalls,
} from "./concurrency-cap.ts"

const ENV = "MINIMAL_AGENT_MAX_CONCURRENT_TOOL_CALLS"

describe("resolveCliMaxConcurrentToolCalls", () => {
  it("env wins over config", () => {
    expect(resolveCliMaxConcurrentToolCalls({ [ENV]: "4" }, 3)).toBe(4)
  })

  it("config wins over the CLI default", () => {
    expect(resolveCliMaxConcurrentToolCalls({}, 3, 10)).toBe(3)
  })

  it("the CLI default applies only when env and config are absent", () => {
    expect(resolveCliMaxConcurrentToolCalls({}, undefined, 10)).toBe(10)
    expect(resolveCliMaxConcurrentToolCalls({}, undefined)).toBe(
      CLI_DEFAULT_MAX_CONCURRENT_TOOL_CALLS,
    )
  })

  it("an invalid layer goes to the next layer", () => {
    expect(resolveCliMaxConcurrentToolCalls({ [ENV]: "zero" }, 3, 10)).toBe(3)
    expect(resolveCliMaxConcurrentToolCalls({ [ENV]: "0" }, 0, 10)).toBe(10)
    expect(resolveCliMaxConcurrentToolCalls({ [ENV]: "" }, "5", 10)).toBe(10)
  })

  it("env 1 wins over the CLI default (the serial loop on request)", () => {
    expect(resolveCliMaxConcurrentToolCalls({ [ENV]: "1" }, undefined, 10)).toBe(1)
  })

  it("the CLI default is 10 (core's SDK default stays 1)", () => {
    expect(CLI_DEFAULT_MAX_CONCURRENT_TOOL_CALLS).toBe(10)
    expect(resolveCliMaxConcurrentToolCalls({}, undefined)).toBe(10)
  })

  it("config 1 wins over the CLI default (the serial loop on request)", () => {
    expect(resolveCliMaxConcurrentToolCalls({}, 1)).toBe(1)
  })
})

/**
 * The CLI resolves the cap once (`prepareEntrypointArgs`) and `main()` gives
 * it to each route. A spawn test of all 3 routes would need a scripted
 * provider per route, so this test reads the 3 call sites in `main.ts`: each
 * deps object must spread `coreFlags`, which carries the value.
 */
describe("main(): each route gets the resolved cap", () => {
  const source = readFileSync(join(import.meta.dir, "..", "main.ts"), "utf8")
  const entry = readFileSync(join(import.meta.dir, "..", "startup", "entry-args.ts"), "utf8")

  /** The deps text of the call that starts at `anchor` (up to 60 lines). */
  const callSite = (anchor: string): string => {
    const start = source.indexOf(anchor)
    expect(start).toBeGreaterThan(-1)
    return source.slice(start).split("\n").slice(0, 60).join("\n")
  }

  it("resolves the cap once, with the env and the config", () => {
    expect(source).not.toContain("resolveCliMaxConcurrentToolCalls(")
    expect(entry.match(/resolveCliMaxConcurrentToolCalls\(/g)?.length).toBe(1)
    expect(entry).toMatch(
      /resolveCliMaxConcurrentToolCalls\(\s*input\.env,\s*userConfig\.maxConcurrentToolCalls,?\s*\)/,
    )
    expect(source).toMatch(
      /const coreFlags = \{ \.\.\.cacheFlags, maxConcurrentToolCalls: entry\.maxConcurrentToolCalls \}/,
    )
  })

  for (const [route, anchor] of [
    ["host mode (ACP)", "await runHostMode({"],
    ["interactive", "await InteractiveSession.create({"],
    ["event stream", "openAgentCoreSession(\n"],
  ] as const) {
    it(`passes it to the ${route} route`, () => {
      expect(callSite(anchor)).toMatch(/^\s+\.\.\.coreFlags,$/m)
    })
  }
})
