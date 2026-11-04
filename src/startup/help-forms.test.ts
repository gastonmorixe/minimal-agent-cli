/**
 * The three help forms give the same bytes (SPEC-HELP R-14, V-7, plan M-9c).
 *
 * For every visible registry path, `<path> --help`, `<path> -h`, and
 * `help <path>` go through `prepareEntrypointArgs` with an in-memory stdout
 * and must write byte-equal text. The root forms `--help`, `-h`, and `help`
 * give today's root help. A command argv with no help token (for example
 * `auth-status plan --all`) keeps its normal plan. With `--json` or
 * `--output-format json`, every form prints the same help model as JSON
 * (R-30, plan M-11).
 *
 * @module startup/help-forms.test
 */

import { describe, expect, test } from "bun:test"
import {
  CLI_CONTRACT_VERSION,
  type HelpModel,
} from "@minimal-agent/core/plugin-api/types/cli-contract"

import { builtinRegistry } from "../cli/registry/index.ts"
import { visibleCommandPaths } from "../ui/help/model.ts"
import { prepareEntrypointArgs } from "./entry-args.ts"
import { fixtureHelpCatalog } from "./fixtures/help-catalog.ts"
import { printHelp, renderCommandHelp, renderHelpJson } from "./help.ts"

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

const ENV = { NO_COLOR: "1", COLUMNS: "80" }

/** The fixture catalog: help output does not depend on the plugins of the machine. */
const CATALOG = fixtureHelpCatalog()

/** Run startup with `rawArgv` and return the exit code plus both streams. */
function run(rawArgv: string[]): { code: number | undefined; stdout: string; stderr: string } {
  const out: string[] = []
  const err: string[] = []
  let code: number | undefined
  try {
    prepareEntrypointArgs({
      rawArgv,
      env: { ...ENV },
      cwd: "/tmp",
      helpCatalog: () => CATALOG,
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => (err.push(s), true) as unknown as boolean },
      exit: (c: number): never => {
        throw new ExitSignal(c)
      },
    })
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code
    else throw e
  }
  return { code, stdout: out.join(""), stderr: err.join("") }
}

const PATHS = visibleCommandPaths(builtinRegistry())

describe("root help forms", () => {
  test("--help, -h, and help give the same bytes as printHelp", () => {
    const expected: string[] = []
    printHelp({ write: (s: string) => expected.push(s) }, { env: ENV, catalog: CATALOG })
    for (const argv of [["--help"], ["-h"], ["help"]]) {
      const r = run(argv)
      expect(r.code).toBe(0)
      expect(r.stderr).toBe("")
      expect(r.stdout).toBe(expected.join(""))
    }
  })

  test("a free prompt plus --help gives root help (spec 8.7)", () => {
    expect(run(["explain this", "--help"]).stdout).toBe(run(["--help"]).stdout)
  })

  test("--help=x and -h=x give root help, exit 0 (fallback)", () => {
    const root = run(["--help"]).stdout
    for (const argv of [["--help=x"], ["-h=x"], ["sessions", "--help=x"]]) {
      const r = run(argv)
      expect(r.code).toBe(0)
      expect(r.stderr).toBe("")
      expect(r.stdout).toBe(root)
    }
  })

  test("--prompt=--help is a prompt value, not help", () => {
    const out: string[] = []
    const prepared = prepareEntrypointArgs({
      rawArgv: ["--prompt=--help"],
      env: { ...ENV },
      cwd: "/tmp",
      stdout: { write: (s: string) => out.push(s) },
      exit: (c: number): never => {
        throw new ExitSignal(c)
      },
    })
    expect(out).toEqual([])
    expect(prepared.args).toEqual(["--prompt", "--help"])
  })
})

describe("command help forms (V-7)", () => {
  test("the path list is not empty", () => {
    expect(PATHS.length).toBeGreaterThan(20)
  })

  for (const path of PATHS) {
    const name = path.join(" ")
    test(`${name}: --help, -h, and help <path> are byte-equal command help`, () => {
      const viaFlag = run([...path, "--help"])
      const viaShort = run([...path, "-h"])
      const viaHelp = run(["help", ...path])
      for (const r of [viaFlag, viaShort, viaHelp]) {
        expect(r.code).toBe(0)
        expect(r.stderr).toBe("")
      }
      expect(viaShort.stdout).toBe(viaFlag.stdout)
      expect(viaHelp.stdout).toBe(viaFlag.stdout)
      expect(viaFlag.stdout).toBe(`${renderCommandHelp(path, { width: 80 }).join("\n")}\n`)
      expect(viaFlag.stdout).not.toBe(run(["--help"]).stdout)
    })
  }
})

describe("the help command (R-14)", () => {
  test("the help path is a visible path", () => {
    expect(PATHS.map((p) => p.join(" "))).toContain("help")
  })

  test("help --help, help -h, and help help are byte-equal command help for help", () => {
    const expected = `${renderCommandHelp(["help"], { width: 80 }).join("\n")}\n`
    for (const argv of [
      ["help", "--help"],
      ["help", "-h"],
      ["help", "help"],
    ]) {
      const r = run(argv)
      expect(r.code).toBe(0)
      expect(r.stderr).toBe("")
      expect(r.stdout).toBe(expected)
    }
  })
})

/** Every string value (and key) in a parsed JSON value, depth first. */
function jsonStrings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(jsonStrings)
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [k, ...jsonStrings(v)])
  }
  return []
}

/** ESC or any other C0 control char. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the test looks for control chars
const CONTROL = /[\u0000-\u001f\u007f]/u

/** The JSON help forms for `path` (R-30, plan M-11). Root: the first three. */
function jsonForms(path: readonly string[]): string[][] {
  if (path.length === 0) {
    return [
      ["--help", "--json"],
      ["-h", "--json"],
      ["help", "--json"],
    ]
  }
  return [
    [...path, "--help", "--json"],
    [...path, "-h", "--json"],
    ["help", ...path, "--json"],
    [...path, "--help", "--output-format", "json"],
    ["help", ...path, "--output-format=json"],
  ]
}

describe("JSON help (R-30, Q-4, plan M-11)", () => {
  test("root: every form prints the root model, kind root, contract version", () => {
    const expected = renderHelpJson([], { catalog: CATALOG })
    for (const argv of [...jsonForms([]), ["--help", "--output-format", "json"]]) {
      const r = run(argv)
      expect(r.code).toBe(0)
      expect(r.stderr).toBe("")
      expect(r.stdout).toBe(expected)
    }
    const parsed = JSON.parse(expected) as HelpModel
    expect(parsed.kind).toBe("root")
    expect(parsed.path).toEqual([])
    expect(parsed.contractVersion).toBe(CLI_CONTRACT_VERSION)
    for (const s of jsonStrings(parsed)) expect(s).not.toMatch(CONTROL)
  })

  test("--json and --output-format json give equal bytes", () => {
    expect(run(["--help", "--json"]).stdout).toBe(run(["--help", "--output-format", "json"]).stdout)
    expect(run(["sessions", "--help", "--json"]).stdout).toBe(
      run(["sessions", "--help", "--output-format", "json"]).stdout,
    )
  })

  test("--format json and --output-format text give text help, not JSON", () => {
    const text = run(["--help"]).stdout
    expect(run(["--help", "--format", "json"]).stdout).toBe(text)
    expect(run(["--help", "--output-format", "text"]).stdout).toBe(text)
    expect(() => JSON.parse(run(["--help", "--format", "json"]).stdout)).toThrow()
    expect(run(["sessions", "--help", "--format", "json"]).stdout).toBe(
      run(["sessions", "--help"]).stdout,
    )
  })

  test("an unknown help path with --json: text error on stderr, exit 2", () => {
    const text = run(["help", "bogus"])
    const json = run(["help", "bogus", "--json"])
    expect(json.code).toBe(2)
    expect(json.stdout).toBe("")
    expect(json.stderr).toBe(text.stderr)
    expect(json.stderr.startsWith("error:")).toBe(true)
  })

  for (const path of PATHS) {
    const name = path.join(" ")
    test(`${name}: every JSON form prints the command model`, () => {
      const expected = renderHelpJson(path)
      for (const argv of jsonForms(path)) {
        const r = run(argv)
        expect(r.code).toBe(0)
        expect(r.stderr).toBe("")
        expect(r.stdout).toBe(expected)
      }
      const parsed = JSON.parse(expected) as HelpModel
      expect(parsed.kind).toBe("command")
      expect(parsed.path).toEqual(path)
      expect(parsed.contractVersion).toBe(CLI_CONTRACT_VERSION)
      for (const s of jsonStrings(parsed)) expect(s).not.toMatch(CONTROL)
    })
  }
})

describe("not a help request", () => {
  test("auth-status plan --all keeps its plan and prints no help", () => {
    const out: string[] = []
    const prepared = prepareEntrypointArgs({
      rawArgv: ["auth-status", "plan", "--all"],
      env: { ...ENV },
      cwd: "/tmp",
      stdout: { write: (s: string) => out.push(s) },
      exit: (c: number): never => {
        throw new ExitSignal(c)
      },
    })
    expect(out).toEqual([])
    expect(prepared.commandPlan.command).toBe("auth-status")
    expect(prepared.args).toEqual(["--auth-status", "plan", "--all"])
  })
})
