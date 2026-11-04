/**
 * The three help forms give the same bytes (SPEC-HELP R-14, V-7, plan M-9c).
 *
 * For every visible registry path, `<path> --help`, `<path> -h`, and
 * `help <path>` go through `prepareEntrypointArgs` with an in-memory stdout
 * and must write byte-equal text. The root forms `--help`, `-h`, and `help`
 * give today's root help. A command argv with no help token (for example
 * `auth-status plan --all`) keeps its normal plan.
 *
 * @module startup/help-forms.test
 */

import { describe, expect, test } from "bun:test"

import { builtinRegistry } from "../cli/registry/index.ts"
import { visibleCommandPaths } from "../ui/help/model.ts"
import { prepareEntrypointArgs } from "./entry-args.ts"
import { printHelp, renderCommandHelp } from "./help.ts"

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

const ENV = { NO_COLOR: "1", COLUMNS: "80" }

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
    printHelp({ write: (s: string) => expected.push(s) }, { env: ENV })
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
