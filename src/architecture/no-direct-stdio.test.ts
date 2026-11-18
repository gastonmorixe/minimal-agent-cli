/**
 * Architecture fitness function: the terminal host writes to stdout and stderr
 * only in the few files that render for the user.
 *
 * The rule is the `ma/no-direct-stdio` oxlint rule, shipped by core
 * (`@minimal-agent/core/scripts/lint/no-direct-stdio.mjs`). It sees
 * `process.stdout/stderr` used as a value or called, `console.*`,
 * `fs.writeSync(1|2)`, `/dev/stdout` and a child process that inherits the
 * terminal. Reads such as `process.stdout.columns` are fine.
 *
 * One config edit would switch the rule off, so this test runs core's checker.
 * It fails when
 *
 *  - `.oxlintrc.json` stops registering the plugin or stops setting it to error,
 *  - a canary write is no longer reported with this repo's config,
 *  - a file outside `no-direct-stdio.baseline.json` writes directly,
 *  - a baseline file writes more often than recorded (new debt), or
 *  - a baseline file got clean but stayed in the list (the list only shrinks).
 *
 * Fixing a failure: report a diagnostic through the bus
 * (`getDiagnosticBus()` from `@minimal-agent/core/host/diagnostics`) or write
 * through an injected port. Add a file to the baseline only when it is a final
 * renderer, and give the entry a reason.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const CHECKER = join(
  REPO_ROOT,
  "node_modules",
  "@minimal-agent",
  "core",
  "scripts",
  "lint",
  "verify-no-direct-stdio.mjs",
)

/** Run the checker in a child process and capture its output. */
function runChecker(args: readonly string[]): {
  status: number | null
  stdout: string
  stderr: string
} {
  const run = spawnSync(process.execPath, [CHECKER, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

describe("no direct stdout/stderr writes (oxlint rule + ratchet)", () => {
  test("the installed core ships the checker", () => {
    // A core pin from before the rule landed has no scripts/lint: bump the pin.
    expect(existsSync(CHECKER)).toBe(true)
  })

  test("the repo config enforces the rule and the baseline is exact", () => {
    const run = runChecker(["--repo", REPO_ROOT])
    // The checker prints each problem on stderr; show them if this fails.
    expect(run.stderr).toBe("")
    expect(run.status).toBe(0)
    expect(run.stdout).toContain("no-direct-stdio ok")
  }, 60_000)

  test("the checker really fails on a planted canary (selftest)", () => {
    const run = runChecker(["--selftest"])
    expect(run.stderr).toBe("")
    expect(run.status).toBe(0)
    expect(run.stdout).toContain("selftest ok")
  }, 60_000)
})
