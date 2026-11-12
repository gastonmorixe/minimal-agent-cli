/**
 * Unit tests for unknown flag detection (plan 2.3).
 *
 * @module cli/unknown-flags.test
 */

import { describe, expect, test } from "bun:test"

import type { FlagSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { builtinRegistry } from "./registry/index.ts"
import { commandFlags, findUnknownFlag, formatUnknownFlag } from "./unknown-flags.ts"

const reg = builtinRegistry()
const find = (argv: string[], extra?: FlagSpec[]): string | undefined =>
  findUnknownFlag(argv, reg, extra)

describe("findUnknownFlag", () => {
  test("an unknown long flag", () => {
    expect(find(["--bogus"])).toBe("--bogus")
    expect(find(["--bogus=1"])).toBe("--bogus")
    expect(find(["--model", "x", "--bogus"])).toBe("--bogus")
  })

  test("an unknown short flag", () => {
    expect(find(["-Z"])).toBe("-Z")
  })

  test("known flags, aliases, short forms, --no- forms, and --version pass", () => {
    expect(find(["--model", "m", "-p", "hi", "--json", "--debug"])).toBeUndefined()
    expect(find(["--models"])).toBeUndefined()
    expect(find(["--model=m"])).toBeUndefined()
    expect(find(["--version"])).toBeUndefined()
    expect(find(["-V"])).toBeUndefined()
    expect(find(["-h"])).toBeUndefined()
  })

  test("a command flag is known anywhere", () => {
    expect(find(["auth-status", "plan", "--all"])).toBeUndefined()
    expect(find(["provider", "anthropic", "login", "--name", "x"])).toBeUndefined()
  })

  test("the value of a required-value flag is never a flag", () => {
    expect(find(["--prompt", "--bogus"])).toBeUndefined()
    expect(find(["-p", "--bogus"])).toBeUndefined()
    expect(find(["--formatter-args", "--table-fit"])).toBeUndefined()
  })

  test("prompt text, stdin, and numbers are not flags", () => {
    expect(find(["- list files"])).toBeUndefined()
    expect(find(["-"])).toBeUndefined()
    expect(find(["--temperature", "-1"])).toBeUndefined()
    expect(find(["explain --this"])).toBeUndefined()
  })

  test("args after --host-mode <id> belong to the host mode", () => {
    expect(find(["--host-mode", "acp", "--approval"])).toBeUndefined()
    expect(find(["--host-mode=acp", "--approval"])).toBeUndefined()
    expect(find(["--bogus", "--host-mode", "acp"])).toBe("--bogus")
  })

  test("args after -- are skipped", () => {
    expect(find(["--", "--bogus"])).toBeUndefined()
  })

  test("plugin command flags are known", () => {
    const spec: FlagSpec = { name: "plugin-thing", type: "string", summary: "x" }
    expect(find(["--plugin-thing", "v"])).toBe("--plugin-thing")
    expect(find(["--plugin-thing", "v"], [spec])).toBeUndefined()
    // Its value is consumed, so `--bogus` as a value is not a flag.
    expect(find(["--plugin-thing", "--bogus"], [spec])).toBeUndefined()
  })
})

describe("commandFlags", () => {
  test("collects flags at every depth", () => {
    const a: FlagSpec = { name: "a", type: "boolean", summary: "a" }
    const b: FlagSpec = { name: "b", type: "boolean", summary: "b" }
    const flags = commandFlags([
      { name: "x", summary: "x", flags: [a], commands: [{ name: "y", summary: "y", flags: [b] }] },
    ])
    expect(flags).toEqual([a, b])
  })
})

test("formatUnknownFlag", () => {
  expect(formatUnknownFlag("--x")).toBe("unknown flag --x (see minimal-agent --help)")
})
