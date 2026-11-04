/**
 * Every visible help path works (SPEC-HELP V-6, plan M-9c).
 *
 * In process: for every visible registry path, `<path> --help` through
 * `prepareEntrypointArgs` exits 0, writes `USAGE` to stdout, and writes
 * nothing to stderr. Then two real process runs pin the real exit codes:
 * `sessions --help` (0) and `help bogus` (2).
 *
 * @module startup/help-every-path.test
 */

import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { builtinRegistry } from "../cli/registry/index.ts"
import { visibleCommandPaths } from "../ui/help/model.ts"
import { prepareEntrypointArgs } from "./entry-args.ts"

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

const PATHS = visibleCommandPaths(builtinRegistry())
const REPO_ROOT = join(import.meta.dir, "..", "..")

function runInProcess(rawArgv: string[]): {
  code: number | undefined
  stdout: string
  stderr: string
} {
  const out: string[] = []
  const err: string[] = []
  let code: number | undefined
  try {
    prepareEntrypointArgs({
      rawArgv,
      env: { NO_COLOR: "1", COLUMNS: "80" },
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

describe("every visible path --help (V-6, in process)", () => {
  test("the path list is not empty", () => {
    expect(PATHS.length).toBeGreaterThan(20)
  })

  for (const path of PATHS) {
    const argv = [...path, "--help"]
    test(`${argv.join(" ")}: exit 0, USAGE on stdout, empty stderr`, () => {
      const r = runInProcess(argv)
      expect(r.code).toBe(0)
      expect(r.stdout.split("\n")).toContain("  USAGE")
      expect(r.stderr).toBe("")
    })
  }
})

/** Env of a real run: no debug, plugins on, not CI, no color. */
function spawnEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "DEBUG" && k !== "MINIMAL_AGENT_DISABLE_PLUGINS" && k !== "CI") {
      env[k] = v
    }
  }
  env.NO_COLOR = "1"
  env.COLUMNS = "80"
  return env
}

async function spawnBin(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["bun", "src/index.ts", ...args], {
    cwd: REPO_ROOT,
    env: spawnEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, stdout, stderr }
}

describe("real process exit codes", () => {
  test("bun src/index.ts sessions --help exits 0 with command help", async () => {
    const r = await spawnBin(["sessions", "--help"])
    expect(r.code).toBe(0)
    expect(r.stdout).toStartWith("  minimal-agent sessions\n")
    expect(r.stdout.split("\n")).toContain("  USAGE")
    expect(r.stderr).toBe("")
  }, 30_000)

  test("bun src/index.ts help bogus exits 2 with an error on stderr", async () => {
    const r = await spawnBin(["help", "bogus"])
    expect(r.code).toBe(2)
    expect(r.stdout).toBe("")
    expect(r.stderr).toStartWith("error:")
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(2)
  }, 30_000)
})
