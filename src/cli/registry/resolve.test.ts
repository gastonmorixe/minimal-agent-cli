/**
 * Tests of the help path resolver (SPEC-HELP R-14 to R-17, 8.7, plan M-9a).
 *
 * @module cli/registry/resolve.test
 */

import { describe, expect, test } from "bun:test"

import type { CommandSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { builtinRegistry } from "./index.ts"
import { type HelpRequest, helpPositionals, resolveHelpRequest } from "./resolve.ts"
import type { BuiltinRegistry } from "./types.ts"

const reg = builtinRegistry()

const help = (...path: string[]): HelpRequest => ({ kind: "help", path })

/** argv (raw, before normalizeArgs) to the expected result. */
const TABLE: readonly (readonly [string[], HelpRequest | undefined])[] = [
  // Plan 5 M-9a table.
  [["--help"], help()],
  [["help"], help()],
  [["sessions", "--help"], help("sessions")],
  [["sessions", "-h"], help("sessions")],
  [["help", "sessions"], help("sessions")],
  [["sessions", "dump", "--help"], help("sessions", "dump")],
  [["auth-status", "refresh", "--help"], help("auth-status", "refresh")],
  [["auth-status", "--name", "plan", "--help"], help("auth-status")],
  [["sessions", "foo", "--help"], help("sessions")],
  [["explain", "--help"], help()],
  [["help", "bogus"], { kind: "unknown", at: [], token: "bogus", suggestions: [] }],
  [
    ["auth-status", "bogus", "-h"],
    { kind: "unknown", at: ["auth-status"], token: "bogus", suggestions: [] },
  ],
  [
    ["auth-status", "prun", "-h"],
    { kind: "unknown", at: ["auth-status"], token: "prun", suggestions: ["prune", "plan"] },
  ],
  [["auth-status", "plan", "--all"], undefined],
  // More forms.
  [["-h"], help()],
  [[], undefined],
  [["explain this codebase"], undefined],
  [["help", "sessions", "dump"], help("sessions", "dump")],
  [["help", "auth-status", "prune"], help("auth-status", "prune")],
  [["auth-status", "prune", "--dry-run", "-h"], help("auth-status", "prune")],
  [["--help", "sessions", "dump"], help("sessions", "dump")],
  [["sessions", "dump", "last", "--help"], help("sessions", "dump")],
  // Strict R-16 walk: `acme` is an arg of `provider`, not a child.
  [["provider", "acme", "login", "--help"], help("provider")],
  [["provider", "--help"], help("provider")],
  [["providers", "models", "--help"], help("providers", "models")],
  [
    ["providers", "bogus", "--help"],
    { kind: "unknown", at: ["providers"], token: "bogus", suggestions: [] },
  ],
  [["help", "sesions"], { kind: "unknown", at: [], token: "sesions", suggestions: ["sessions"] }],
  // Hidden commands resolve.
  [["models", "--help"], help("models")],
  [["help", "models-live"], help("models-live")],
  // Value flags skip their values (registry arity).
  [["--model", "sessions", "--help"], help()],
  [["-m", "sessions", "--help"], help()],
  [["--model=x", "sessions", "--help"], help("sessions")],
  [["sessions", "dump", "--dump-format", "xml", "--help"], help("sessions", "dump")],
  [["auth-status", "refresh-all", "--parallel", "8", "-h"], help("auth-status", "refresh-all")],
  // Optional value: taken only when the next token is not a flag.
  [["--sessions", "plan", "--help"], help()],
  [["--sessions", "--debug", "sessions", "--help"], help("sessions")],
  // A value flag can take `--help` as its value. Help is still selected.
  [["--prompt", "--help"], help()],
  // Boolean flags take no value.
  [["--debug", "sessions", "--help"], help("sessions")],
  // A lone `-` is a positional (stdin prompt) at the root.
  [["-", "--help"], help()],
  // Leaf: a trailing token is an argument.
  [["usage", "week", "--help"], help("usage")],
  [["flags", "list", "extra", "--help"], help("flags", "list")],
  [
    ["flags", "lst", "--help"],
    { kind: "unknown", at: ["flags"], token: "lst", suggestions: ["list"] },
  ],
  // `help` only counts as raw[0].
  [["sessions", "help"], undefined],
  [["help", "help"], help("help")],
]

describe("resolveHelpRequest", () => {
  for (const [argv, expected] of TABLE) {
    test(`${JSON.stringify(argv)} -> ${JSON.stringify(expected)}`, () => {
      expect(resolveHelpRequest(argv, reg)).toEqual(expected)
    })
  }

  test("-h, --help, and help <path> give the same request (R-14)", () => {
    const paths = [[], ["sessions"], ["sessions", "dump"], ["auth-status", "plan"], ["provider"]]
    for (const path of paths) {
      const viaHelp = resolveHelpRequest(["help", ...path], reg)
      expect(resolveHelpRequest([...path, "--help"], reg)).toEqual(viaHelp)
      expect(resolveHelpRequest([...path, "-h"], reg)).toEqual(viaHelp)
      expect(viaHelp).toEqual({ kind: "help", path })
    }
  })

  test("the result path uses canonical names when argv uses an alias", () => {
    const leaf: CommandSpec = { name: "list", aliases: ["ls"], summary: "List" }
    const top: CommandSpec = { name: "things", summary: "Things", commands: [leaf] }
    const root: CommandSpec = { name: "prog", summary: "Prog", commands: [top] }
    const custom: BuiltinRegistry = { ...reg, root, commands: [top] }
    expect(resolveHelpRequest(["things", "ls", "--help"], custom)).toEqual(help("things", "list"))
  })

  test("hidden children are not suggested", () => {
    const shown: CommandSpec = { name: "alpha", summary: "A" }
    const hidden: CommandSpec = { name: "alphb", summary: "B", hidden: true }
    const top: CommandSpec = { name: "top", summary: "T", commands: [shown, hidden] }
    const root: CommandSpec = { name: "prog", summary: "Prog", commands: [top] }
    const custom: BuiltinRegistry = { ...reg, root, commands: [top] }
    expect(resolveHelpRequest(["top", "alphc", "-h"], custom)).toEqual({
      kind: "unknown",
      at: ["top"],
      token: "alphc",
      suggestions: ["alpha"],
    })
    expect(resolveHelpRequest(["top", "alphb", "-h"], custom)).toEqual(help("top", "alphb"))
  })

  test("pure: argv is not changed", () => {
    const argv = Object.freeze(["sessions", "dump", "--help"])
    expect(resolveHelpRequest(argv, reg)).toEqual(help("sessions", "dump"))
    expect(argv).toEqual(["sessions", "dump", "--help"])
  })
})

describe("helpPositionals", () => {
  test("skips required values, keeps a lone -", () => {
    expect(helpPositionals(["--name", "plan", "x", "-", "--table"], reg)).toEqual(["x", "-"])
  })

  test("unknown flags take no value", () => {
    expect(helpPositionals(["--no-such-flag", "sessions"], reg)).toEqual(["sessions"])
  })

  test("a required value flag at the end takes nothing", () => {
    expect(helpPositionals(["sessions", "--model"], reg)).toEqual(["sessions"])
  })
})
