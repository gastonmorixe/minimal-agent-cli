/**
 * Tests for {@link parseCliOptions} — specifically the `--tools` / `--no-tools`
 * flag parsing.
 *
 * @module cli/parse-argv.test
 */

import { describe, expect, test } from "bun:test"

import { normalizeArgs } from "./cli-args.ts"
import { CliFlagError, type CliToolFilter, parseCliOptions } from "./parse-argv.ts"

const NO_ENV = {} as const
const NO_CFG = {} as const
const NOOP_FORMATTER = (_raw: string): string[] => []

describe("parseCliOptions — cliToolFilter", () => {
  test("no --tools or --no-tools → null filter", () => {
    const opts = parseCliOptions([], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cliToolFilter).toBeNull()
  })

  test("--no-tools → deny-all filter", () => {
    const opts = parseCliOptions(["--no-tools"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cliToolFilter).toEqual<CliToolFilter>({ kind: "deny-all" })
  })

  test("--no-tools with other flags still works", () => {
    const opts = parseCliOptions(
      ["--no-tools", "--model", "test-model", "--prompt", "hi"],
      NO_CFG,
      NO_ENV,
      NOOP_FORMATTER,
    )
    expect(opts.cliToolFilter).toEqual<CliToolFilter>({ kind: "deny-all" })
  })

  test("--tools with single tool → allow-list with one entry", () => {
    const opts = parseCliOptions(["--tools", "Task"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cliToolFilter).toEqual<CliToolFilter>({ kind: "allow-list", tools: ["Task"] })
  })

  test("--tools with multiple comma-separated tools → allow-list", () => {
    const opts = parseCliOptions(["--tools", "Read,Task,Grep"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cliToolFilter).toEqual<CliToolFilter>({
      kind: "allow-list",
      tools: ["Read", "Task", "Grep"],
    })
  })

  test("--tools with spaces after commas → trimmed", () => {
    const opts = parseCliOptions(["--tools", "Read, Task, Grep"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cliToolFilter).toEqual<CliToolFilter>({
      kind: "allow-list",
      tools: ["Read", "Task", "Grep"],
    })
  })

  test("--tools with empty string → null filter (no tools parsed)", () => {
    const opts = parseCliOptions(["--tools", ""], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cliToolFilter).toBeNull()
  })

  test("--tools with only commas → null filter", () => {
    const opts = parseCliOptions(["--tools", ",,,"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cliToolFilter).toBeNull()
  })

  test("--tools=value form works", () => {
    const opts = parseCliOptions(["--tools=Read,Task"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cliToolFilter).toEqual<CliToolFilter>({
      kind: "allow-list",
      tools: ["Read", "Task"],
    })
  })

  test("--no-tools beats --tools if both appear", () => {
    const opts = parseCliOptions(["--no-tools", "--tools", "Read"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    // --no-tools is checked first in the code
    expect(opts.cliToolFilter).toEqual<CliToolFilter>({ kind: "deny-all" })
  })
})

describe("parseCliOptions — generic endpoint flags", () => {
  test("reads endpoint/format/auth flags from CLI", () => {
    const opts = parseCliOptions(
      [
        "--endpoint",
        "http://localhost:1234/v1/chat/completions",
        "--format",
        "chat-surface",
        "--auth-type",
        "bearer",
        "--api-key",
        "sk-local",
        "--auth-header",
        "X-Api-Key",
        "--provider-model",
        "qwen2.5",
      ],
      NO_CFG,
      NO_ENV,
      NOOP_FORMATTER,
    )
    expect(opts.endpoint).toBe("http://localhost:1234/v1/chat/completions")
    expect(opts.format).toBe("chat-surface")
    expect(opts.authType).toBe("bearer")
    expect(opts.apiKey).toBe("sk-local")
    expect(opts.authHeader).toBe("X-Api-Key")
    expect(opts.providerModel).toBe("qwen2.5")
  })

  test("--surface is an alias for --format", () => {
    const opts = parseCliOptions(["--surface", "chat-surface"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.format).toBe("chat-surface")
  })

  test("CLI wins over env over config", () => {
    const env = {
      MINIMAL_AGENT_ENDPOINT: "http://env/v1/chat/completions",
      MINIMAL_AGENT_FORMAT: "env-format",
    }
    const cfg = { endpoint: "http://config/v1", format: "config-format" } as const
    const opts = parseCliOptions(["--endpoint", "http://cli/v1"], cfg, env, NOOP_FORMATTER)
    expect(opts.endpoint).toBe("http://cli/v1")
    // format not on CLI → env wins over config
    expect(opts.format).toBe("env-format")
  })

  test("invalid --auth-type is dropped to undefined", () => {
    const opts = parseCliOptions(["--auth-type", "bogus"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.authType).toBeUndefined()
  })

  test("--effort-levels parses a comma-separated ladder", () => {
    const opts = parseCliOptions(
      ["--effort-levels", "low,medium,high"],
      NO_CFG,
      NO_ENV,
      NOOP_FORMATTER,
    )
    expect(opts.effortLevels).toEqual(["low", "medium", "high"])
  })

  test("--effort-levels trims whitespace and drops empties", () => {
    const opts = parseCliOptions(
      ["--effort-levels", " low , , high "],
      NO_CFG,
      NO_ENV,
      NOOP_FORMATTER,
    )
    expect(opts.effortLevels).toEqual(["low", "high"])
  })

  test("effort-levels: env used when CLI absent, config when both absent", () => {
    const fromEnv = parseCliOptions(
      [],
      NO_CFG,
      { MINIMAL_AGENT_EFFORT_LEVELS: "a,b" },
      NOOP_FORMATTER,
    )
    expect(fromEnv.effortLevels).toEqual(["a", "b"])
    const fromCfg = parseCliOptions([], { effortLevels: ["x"] }, NO_ENV, NOOP_FORMATTER)
    expect(fromCfg.effortLevels).toEqual(["x"])
  })

  test("no --effort-levels → undefined", () => {
    const opts = parseCliOptions([], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.effortLevels).toBeUndefined()
  })
})

describe("selection flag operands", () => {
  const parse = (args: string[]) =>
    parseCliOptions(normalizeArgs(args), NO_CFG, NO_ENV, NOOP_FORMATTER)

  for (const flag of ["--model", "--provider", "--credential-name"]) {
    test(`${flag} requires an operand`, () => {
      for (const args of [[flag], [flag, "--debug"], [`${flag}=`]]) {
        expect(() => parse(args)).toThrow(CliFlagError)
        expect(() => parse(args)).toThrow(`${flag} requires`)
      }
    })
  }

  test("equals syntax works with an explicit resume target", () => {
    expect(
      parse([
        "--resume-same-sid=last",
        "--model=vendor/m",
        "--provider=p",
        "--credential-name=work",
      ]),
    ).toMatchObject({
      effectiveResumeArg: "last",
      model: "vendor/m",
      provider: "p",
      cliCredentialName: "work",
    })
  })

  test("flag-shaped prompt text and host-mode arguments are not selection flags", () => {
    expect(parse(["--prompt=--model"]).model).toBeUndefined()
    expect(parse(["--host-mode", "acp", "--provider"]).hostModeId).toBe("acp")
  })
})

describe("parseCliOptions — --effort vs --fast", () => {
  test("names the actual next flag in the hint", () => {
    expect(() => parseCliOptions(["--effort", "--debug"], NO_CFG, NO_ENV, NOOP_FORMATTER)).toThrow(
      '`--effort <level>` before "--debug"',
    )
  })

  test("--effort high --fast keeps both flags", () => {
    const opts = parseCliOptions(["--effort", "high", "--fast"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.effort).toBe("high")
    expect(opts.effortSource).toBe("cli")
    expect(opts.speedFast).toBe(true)
  })

  test("--effort --fast does not treat --fast as the effort level", () => {
    expect(() => parseCliOptions(["--effort", "--fast"], NO_CFG, NO_ENV, NOOP_FORMATTER)).toThrow(
      /--effort requires a level/,
    )
    expect(() => parseCliOptions(["--effort", "--fast"], NO_CFG, NO_ENV, NOOP_FORMATTER)).toThrow(
      /Got "--fast"/,
    )
  })

  test("bare --effort without a level errors", () => {
    expect(() => parseCliOptions(["--effort"], NO_CFG, NO_ENV, NOOP_FORMATTER)).toThrow(
      /--effort requires a level/,
    )
  })
})

describe("parseCliOptions — --host-mode", () => {
  test("absent → undefined", () => {
    expect(parseCliOptions([], NO_CFG, NO_ENV, NOOP_FORMATTER).hostModeId).toBeUndefined()
  })

  test("--host-mode <id> → the id, with later mode args ignored", () => {
    const opts = parseCliOptions(["--host-mode", "acp", "--x"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.hostModeId).toBe("acp")
  })

  test("--host-mode with no id, or a flag in its place → undefined", () => {
    expect(
      parseCliOptions(["--host-mode"], NO_CFG, NO_ENV, NOOP_FORMATTER).hostModeId,
    ).toBeUndefined()
    expect(
      parseCliOptions(["--host-mode", "--debug"], NO_CFG, NO_ENV, NOOP_FORMATTER).hostModeId,
    ).toBeUndefined()
  })
})

describe("parseCliOptions — SPEC-ONESHOT one-shot flags", () => {
  const parse = (args: string[], env: Record<string, string> = {}) =>
    parseCliOptions(args, NO_CFG, env, NOOP_FORMATTER)

  test("absent → defaults", () => {
    const opts = parse([])
    expect(opts.strict).toBe(false)
    expect(opts.appendSystemPrompt).toBeUndefined()
    expect(opts.appendSystemPromptFile).toBeUndefined()
    expect(opts.temperature).toBeUndefined()
  })

  test("--strict → true", () => {
    expect(parse(["--strict", "-p", "hi"]).strict).toBe(true)
  })

  test("--bare → true, absent → false (R13)", () => {
    expect(parse(["--bare", "-p", "hi"]).bare).toBe(true)
    expect(parse(["-p", "hi"]).bare).toBe(false)
  })

  test("--output-schema takes a path or inline JSON", () => {
    expect(parse(["--output-schema", "s.json"]).outputSchemaPath).toBe("s.json")
    expect(parse(["--output-schema", '{"type":"object"}']).outputSchemaPath).toBe(
      '{"type":"object"}',
    )
  })

  test("--append-system-prompt and -file read their values (space and = forms)", () => {
    const opts = parse([
      "--append-system-prompt",
      "- be short",
      "--append-system-prompt-file=extra.md",
    ])
    expect(opts.appendSystemPrompt).toBe("- be short")
    expect(opts.appendSystemPromptFile).toBe("extra.md")
  })

  test("--temperature parses a finite number (space and = forms)", () => {
    expect(parse(["--temperature", "0.2"]).temperature).toBe(0.2)
    expect(parse(["--temperature=0"]).temperature).toBe(0)
  })

  test("--temperature that is not a finite number → CliFlagError (exit 2)", () => {
    for (const bad of [["--temperature", "hot"], ["--temperature"], ["--temperature=Infinity"]]) {
      expect(() => parse(bad)).toThrow(CliFlagError)
    }
    expect(() => parse(["--temperature", "x"])).toThrow(/--temperature requires a finite number/)
  })

  test("MINIMAL_AGENT_TEMPERATURE is the fallback, the flag wins", () => {
    expect(parse([], { MINIMAL_AGENT_TEMPERATURE: "0.7" }).temperature).toBe(0.7)
    expect(parse(["--temperature", "1"], { MINIMAL_AGENT_TEMPERATURE: "0.7" }).temperature).toBe(1)
    expect(parse([], { MINIMAL_AGENT_TEMPERATURE: "" }).temperature).toBeUndefined()
    expect(() => parse([], { MINIMAL_AGENT_TEMPERATURE: "warm" })).toThrow(
      /MINIMAL_AGENT_TEMPERATURE requires a finite number/,
    )
  })

  test("--schema-retries: absent is 0, 0..5 parse (space and = forms)", () => {
    expect(parse([]).schemaRetries).toBe(0)
    expect(parse(["--schema-retries", "0"]).schemaRetries).toBe(0)
    expect(parse(["--schema-retries", "2"]).schemaRetries).toBe(2)
    expect(parse(["--schema-retries=5"]).schemaRetries).toBe(5)
  })

  test("--schema-retries out of range or not an integer → CliFlagError (exit 2)", () => {
    for (const bad of [
      ["--schema-retries", "6"],
      ["--schema-retries", "-1"],
      ["--schema-retries", "1.5"],
      ["--schema-retries", "x"],
      ["--schema-retries"],
      ["--schema-retries="],
    ]) {
      expect(() => parse(bad)).toThrow(CliFlagError)
    }
    expect(() => parse(["--schema-retries", "9"])).toThrow(
      /--schema-retries requires an integer from 0 to 5/,
    )
  })
})

describe("parseCliOptions — --input-format (R15)", () => {
  const parse = (args: string[]) => parseCliOptions(args, NO_CFG, NO_ENV, NOOP_FORMATTER)

  test("default text, open-responses accepted, bad value exits 2", () => {
    expect(parse([]).inputFormat).toBe("text")
    expect(parse(["--input-format", "open-responses"]).inputFormat).toBe("open-responses")
    expect(() => parse(["--input-format", "xml"])).toThrow(CliFlagError)
  })
})

describe("parseCliOptions — prompt-cache flags (F1/F2)", () => {
  test("defaults: anchor ON, thinking history strip", () => {
    const opts = parseCliOptions([], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cacheAnchor).toBe(true)
    expect(opts.cacheFlags).toEqual({ cacheAnchor: true, thinkingHistory: "strip" })
    expect(opts.thinkingHistory).toBe("strip")
  })

  test("each off switch turns the default anchor off", () => {
    const parse = (args: string[], cfg: typeof NO_CFG, env: typeof NO_ENV) =>
      parseCliOptions(args, cfg, env, NOOP_FORMATTER).cacheAnchor
    expect(parse(["--no-cache-anchor"], NO_CFG, NO_ENV)).toBe(false)
    expect(parse([], NO_CFG, { MINIMAL_AGENT_CACHE_ANCHOR: "0" })).toBe(false)
    expect(parse([], { cacheAnchor: false }, NO_ENV)).toBe(false)
  })

  test("flags win over env and config", () => {
    const opts = parseCliOptions(
      ["--cache-anchor", "--thinking-history", "keep"],
      { cacheAnchor: false, thinkingHistory: "strip" },
      { MINIMAL_AGENT_CACHE_ANCHOR: "0", MINIMAL_AGENT_THINKING_HISTORY: "strip" },
      NOOP_FORMATTER,
    )
    expect(opts.cacheAnchor).toBe(true)
    expect(opts.thinkingHistory).toBe("keep")
  })

  test("--no-cache-anchor turns the anchor off over env and config (L3)", () => {
    const opts = parseCliOptions(
      ["--no-cache-anchor"],
      { cacheAnchor: true },
      { MINIMAL_AGENT_CACHE_ANCHOR: "1" },
      NOOP_FORMATTER,
    )
    expect(opts.cacheAnchor).toBe(false)
    const last = (args: string[]) => parseCliOptions(args, NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(last(["--no-cache-anchor", "--cache-anchor"]).cacheAnchor).toBe(true)
    expect(last(["--cache-anchor", "--no-cache-anchor"]).cacheAnchor).toBe(false)
  })

  test("env wins over config", () => {
    const opts = parseCliOptions(
      [],
      { cacheAnchor: false, thinkingHistory: "strip" },
      { MINIMAL_AGENT_CACHE_ANCHOR: "1", MINIMAL_AGENT_THINKING_HISTORY: "keep" },
      NOOP_FORMATTER,
    )
    expect(opts.cacheAnchor).toBe(true)
    expect(opts.thinkingHistory).toBe("keep")
  })

  test("config applies when no flag and no env", () => {
    const opts = parseCliOptions(
      [],
      { cacheAnchor: false, thinkingHistory: "keep" },
      NO_ENV,
      NOOP_FORMATTER,
    )
    expect(opts.cacheAnchor).toBe(false)
    expect(opts.thinkingHistory).toBe("keep")
  })
})
