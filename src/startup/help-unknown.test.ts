/**
 * Unknown help paths (SPEC-HELP R-17, R-29, R-32, V-8, plan M-9c).
 *
 * In help mode, an unknown path exits 2. stderr has 2 lines: `error: ...`,
 * then one hint line with up to 3 "did you mean" suggestions and a pointer to
 * `minimal-agent help`. stdout stays empty. The color of the error follows
 * the stderr stream, not stdout.
 *
 * @module startup/help-unknown.test
 */

import { describe, expect, test } from "bun:test"

import { prepareEntrypointArgs } from "./entry-args.ts"
import { helpErrorLines, printHelpError } from "./help.ts"

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

interface RunResult {
  readonly code: number | undefined
  readonly stdout: string
  readonly stderr: string
}

function run(
  rawArgv: string[],
  env: Record<string, string> = { NO_COLOR: "1" },
  stderrIsTTY = false,
): RunResult {
  const out: string[] = []
  const err: string[] = []
  let code: number | undefined
  const stderr = {
    write: (s: string) => (err.push(s), true) as unknown as boolean,
    isTTY: stderrIsTTY,
  }
  try {
    prepareEntrypointArgs({
      rawArgv,
      env,
      cwd: "/tmp",
      stdout: { write: (s: string) => out.push(s), isTTY: true },
      stderr,
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

describe("unknown help path (V-8)", () => {
  test("help bogus: exit 2, stderr error plus hint, stdout empty", () => {
    const r = run(["help", "bogus"])
    expect(r.code).toBe(2)
    expect(r.stdout).toBe("")
    expect(r.stderr).toStartWith("error:")
    expect(r.stderr).toBe(
      [
        'error: unknown command "bogus" for "minimal-agent"',
        'hint: run "minimal-agent help" to see the commands.',
        "",
      ].join("\n"),
    )
  })

  test("auth-status bogus -h: exit 2", () => {
    const r = run(["auth-status", "bogus", "-h"])
    expect(r.code).toBe(2)
    expect(r.stdout).toBe("")
    expect(r.stderr).toStartWith('error: unknown command "bogus" for "minimal-agent auth-status"')
    expect(r.stderr).toContain('hint: run "minimal-agent help auth-status"')
  })

  test("auth-status prun -h: suggestions in the one hint line (R-32)", () => {
    const r = run(["auth-status", "prun", "-h"])
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(
      [
        'error: unknown command "prun" for "minimal-agent auth-status"',
        'hint: did you mean "prune" or "plan"? Run "minimal-agent help auth-status" to see the commands.',
        "",
      ].join("\n"),
    )
  })

  test("help sesions: suggests sessions", () => {
    const r = run(["help", "sesions"])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('hint: did you mean "sessions"? Run "minimal-agent help"')
  })

  test("stderr has exactly 2 lines: error, then one hint (R-32)", () => {
    for (const argv of [
      ["help", "bogus"],
      ["help", "sesions"],
      ["auth-status", "prun", "-h"],
      ["auth-status", "bogus", "-h"],
      ["providers", "bogus", "--help"],
    ]) {
      const lines = run(argv).stderr.trimEnd().split("\n")
      expect(lines).toHaveLength(2)
      expect(lines[0]).toStartWith("error:")
      expect(lines[1]).toStartWith("hint:")
    }
  })

  test("providers bogus --help: exit 2 with the help hint", () => {
    const r = run(["providers", "bogus", "--help"])
    expect(r.code).toBe(2)
    expect(r.stderr).toStartWith("error:")
    expect(r.stderr).toContain("minimal-agent help providers")
  })

  test("at most 3 suggestions", () => {
    const lines = helpErrorLines({
      kind: "unknown",
      at: [],
      token: "x",
      suggestions: ["a", "b", "c", "d"],
    })
    expect(lines).toEqual([
      'error: unknown command "x" for "minimal-agent"',
      'hint: did you mean "a", "b", or "c"? Run "minimal-agent help" to see the commands.',
    ])
  })
})

describe("help error color follows stderr (R-29)", () => {
  const SGR = /\u001b\[/u

  test("no SGR on a non-TTY stderr, even when stdout is a TTY", () => {
    expect(run(["help", "bogus"], { TERM: "xterm" }, false).stderr).not.toMatch(SGR)
  })

  test("SGR on a TTY stderr with no NO_COLOR", () => {
    const r = run(["help", "bogus"], { TERM: "xterm" }, true)
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(SGR)
    expect(r.stderr.replaceAll(/\u001b\[[0-9;]*m/gu, "")).toStartWith("error: unknown command")
  })

  test("no SGR on a TTY stderr with NO_COLOR, TERM=dumb, or --no-color", () => {
    expect(run(["help", "bogus"], { NO_COLOR: "1" }, true).stderr).not.toMatch(SGR)
    expect(run(["help", "bogus"], { TERM: "dumb" }, true).stderr).not.toMatch(SGR)
    expect(run(["help", "bogus", "--no-color"], { TERM: "xterm" }, true).stderr).not.toMatch(SGR)
  })

  test("printHelpError writes to the stream it gets", () => {
    const err: string[] = []
    printHelpError(
      { write: (s: string) => err.push(s) },
      { kind: "unknown", at: ["sessions"], token: "x", suggestions: [] },
      { env: {} },
    )
    expect(err.join("")).toStartWith('error: unknown command "x" for "minimal-agent sessions"')
  })
})
