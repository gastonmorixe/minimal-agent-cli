/**
 * Snapshot pins of the current root help (SPEC-HELP M-2, V-1).
 *
 * These tests record the help bytes as they are today. They do not assert
 * that the help is good. Today root help reads no width and no `NO_COLOR`,
 * so the 80 and 120 column snapshots are equal and both carry SGR escapes.
 * A later step (M-7) changes that on purpose and updates these snapshots.
 *
 * Choice: keep ANSI in the snapshot. The output is the exact bytes that
 * `printHelp` writes, so a change to color, to the escape codes, or to the
 * `NO_COLOR` policy shows as a snapshot diff. Stripping ANSI would hide that
 * drift. To keep the `.snap` file readable in review, each ESC byte is
 * written as the visible text `<ESC>`. That swap is one to one, so it hides
 * nothing.
 *
 * One value is masked: the version on the title line. It comes from the
 * installed core `package.json` and changes on every release, which is not
 * help drift. A separate test checks that the title line has the real
 * version, so the mask cannot hide a lost version.
 *
 * The source is `printHelp` with a collector. The CLI path (`--help` in
 * src/startup/entry-args.ts) calls the same function, and a spawn of
 * `src/index.ts --help` gives the same bytes (measured for M-2).
 *
 * @module startup/help.snapshot.test
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { AGENT_VERSION } from "@minimal-agent/core/host/build-info"

import { printHelp } from "./help.ts"

const ENV_KEYS = ["COLUMNS", "NO_COLOR"] as const
const VERSION_MASK = "v<AGENT_VERSION>"

/** The exact bytes `printHelp` writes. */
function helpBytes(): string {
  let out = ""
  printHelp({
    write(s: string): boolean {
      out += s
      return true
    },
  })
  return out
}

/** Make ESC visible and mask the release version. Nothing else changes. */
function forSnapshot(bytes: string): string {
  return bytes.replaceAll("\u001b", "<ESC>").replace(`v${AGENT_VERSION}`, VERSION_MASK)
}

describe("root help snapshot", () => {
  const saved = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key])
    process.env.NO_COLOR = "1"
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    saved.clear()
  })

  test("COLUMNS=80, NO_COLOR=1 set (ignored before M-7)", () => {
    process.env.COLUMNS = "80"
    expect(forSnapshot(helpBytes())).toMatchSnapshot()
  })

  test("COLUMNS=120, NO_COLOR=1 set (ignored before M-7)", () => {
    process.env.COLUMNS = "120"
    expect(forSnapshot(helpBytes())).toMatchSnapshot()
  })

  test("the version mask covers the real version once", () => {
    process.env.COLUMNS = "80"
    const bytes = helpBytes()
    expect(bytes.split(`v${AGENT_VERSION}`).length).toBe(2)
    expect(bytes).not.toContain("<ESC>")
    expect(bytes).not.toContain(VERSION_MASK)
  })
})
