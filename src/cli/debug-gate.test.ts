import { describe, expect, it } from "bun:test"

import { isDebugRequested, isVerboseEnv } from "./debug-gate.ts"
import { parseCliOptions } from "./parse-argv.ts"

describe("isDebugRequested", () => {
  it("is true only with --debug or DEBUG=1", () => {
    expect(isDebugRequested([], {})).toBe(false)
    expect(isDebugRequested([], { DEBUG: "0" })).toBe(false)
    expect(isDebugRequested([], { DEBUG: "" })).toBe(false)
    expect(isDebugRequested([], { VERBOSE: "1" })).toBe(false)
    expect(isDebugRequested(["--debug"], {})).toBe(true)
    expect(isDebugRequested([], { DEBUG: "1" })).toBe(true)
  })

  it("DEBUG must be 1: other non-empty values do not turn debug on", () => {
    for (const value of ["true", "*", "yes", "2", " 1"]) {
      expect(isDebugRequested([], { DEBUG: value })).toBe(false)
    }
  })
})

describe("isVerboseEnv", () => {
  it("is true for any non-empty VERBOSE", () => {
    expect(isVerboseEnv({})).toBe(false)
    expect(isVerboseEnv({ VERBOSE: "" })).toBe(false)
    expect(isVerboseEnv({ VERBOSE: "1" })).toBe(true)
    expect(isVerboseEnv({ VERBOSE: "0" })).toBe(true)
  })
})

describe("parseCliOptions debug", () => {
  const noCfg = {}
  const noFormatter = (_raw: string): string[] => []
  it("uses the shared gate", () => {
    expect(parseCliOptions([], noCfg, {}, noFormatter).debug).toBe(false)
    expect(parseCliOptions(["--debug"], noCfg, {}, noFormatter).debug).toBe(true)
    expect(parseCliOptions([], noCfg, { DEBUG: "1" }, noFormatter).debug).toBe(true)
    expect(parseCliOptions([], noCfg, { DEBUG: "true" }, noFormatter).debug).toBe(false)
  })
})
