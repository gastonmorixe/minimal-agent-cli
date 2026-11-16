/**
 * Ratchet: a test that spawns the real CLI must give the child a temp agent
 * home.
 *
 * The CLI writes sessions, logs and history under its agent home
 * (`MINIMAL_AGENT_HOME`, else `$HOME/.minimal-agent`). A spawn with
 * `{ ...process.env }` or `cleanSpawnEnv()` carries the real home of the
 * developer into the child, and the test then writes into the real
 * `~/.minimal-agent`.
 *
 * Rule, for every `src/**\/*.test.ts` file that spawns a process AND names a
 * CLI entry:
 * 1. The file uses `isolatedCliEnv(` (test-utils/isolated-cli-env.ts) or sets
 *    `MINIMAL_AGENT_HOME` itself.
 * 2. Each `Bun.spawn(` / `spawn(` call in it passes an `env`. A call with no
 *    `env` inherits the parent env, and so the real home.
 * 3. A call whose inline env spreads `process.env` or `cleanSpawnEnv()` also
 *    sets `MINIMAL_AGENT_HOME` in the same call.
 * Rules 2 and 3 are per call, so one isolated test in a file does not hide a
 * leaking sibling (e2e-smoke.test.ts had exactly that).
 *
 * A CLI entry is one of:
 * - the path `src/index.ts` or `src/main.ts` in a string;
 * - `join(..., "index.ts")` or `join(..., "main.ts")`;
 * - the file name of a fixture or driver under `src/` that imports the CLI
 *   `main.ts` or `index.ts` (for example `fixtures/resume-kill-child.ts`).
 *
 * The scan is textual and coarse on purpose. A file that only names the entry
 * in a comment and spawns something else is a false positive: isolate it
 * anyway (it is cheap) or add it to ALLOW with a reason.
 *
 * @module test-utils/spawn-home-isolation.ratchet.test
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"

const SRC = join(import.meta.dir, "..")
const CLI_ENTRIES = new Set([join(SRC, "index.ts"), join(SRC, "main.ts")])

/** Files exempt from the rule, path relative to `src/`, with the reason. */
const ALLOW: ReadonlyMap<string, string> = new Map<string, string>([])

const SPAWN_RE =
  /\bBun\.spawn(?:Sync)?\s*\(|\bspawn(?:Sync)?\s*\(|\bexec(?:File)?(?:Sync)?\s*\(|\bBun\.\$|\$`/
const ENTRY_PATH_RE = /\bsrc\/(?:index|main)\.ts\b/
const ENTRY_JOIN_RE = /\bjoin\([^)]*["'](?:index|main)\.ts["']\s*\)/
const ISOLATED_RE = /\bisolatedCliEnv\s*\(|\bMINIMAL_AGENT_HOME\s*[:=]/
const IMPORT_RE = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g

function listTs(): string[] {
  return [...new Bun.Glob("**/*.ts").scanSync({ cwd: SRC, absolute: true })].filter(
    (p) => !p.includes("/node_modules/"),
  )
}

/** File names of fixtures and drivers under src/ that import the CLI entry. */
function cliChildNames(files: readonly string[], read: (p: string) => string): Set<string> {
  const names = new Set<string>()
  for (const file of files) {
    if (file.endsWith(".test.ts")) continue
    if (!/fixtures\/|driver/.test(file)) continue
    const text = read(file)
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? ""
      if (!spec.startsWith(".")) continue
      if (CLI_ENTRIES.has(resolve(dirname(file), spec))) {
        names.add(basename(file))
        break
      }
    }
  }
  return names
}

/** True when the test source spawns a process and names a CLI entry. */
function spawnsCli(text: string, childNames: ReadonlySet<string>): boolean {
  if (!SPAWN_RE.test(text)) return false
  if (ENTRY_PATH_RE.test(text) || ENTRY_JOIN_RE.test(text)) return true
  for (const name of childNames) if (text.includes(name)) return true
  return false
}

/** The source text of each `spawn(` call (balanced parentheses, naive). */
function spawnCalls(text: string): string[] {
  const out: string[] = []
  const re = /\b(?:Bun\.)?spawn(?:Sync)?\s*\(/g
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < text.length; i++) {
      const ch = text[i]
      if (ch === "(") depth++
      else if (ch === ")" && --depth === 0) break
    }
    out.push(text.slice(m.index, i + 1))
  }
  return out
}

/** Why one spawn call leaks the parent agent home, or null when it does not. */
function callLeak(call: string): string | null {
  if (!/\benv\s*[:,}]/.test(call)) return "no env: the child inherits the parent home"
  const spreadsParent = /\.\.\.\s*(?:process\.env\b|cleanSpawnEnv\(\))/.test(call)
  if (spreadsParent && !call.includes("MINIMAL_AGENT_HOME")) {
    return "spreads the parent env and sets no MINIMAL_AGENT_HOME"
  }
  return null
}

/** True when the test source gives its child a temp agent home. */
function isolatesHome(text: string): boolean {
  return ISOLATED_RE.test(text)
}

describe("spawn home isolation (detector)", () => {
  const none = new Set<string>()
  test("flags a spawn of src/index.ts with the parent env", () => {
    const src = `Bun.spawn(["bun", "run", "src/index.ts"], { env: { ...process.env } })`
    expect(spawnsCli(src, none)).toBe(true)
    expect(isolatesHome(src)).toBe(false)
  })
  test("flags a join of index.ts and a CLI child fixture", () => {
    expect(spawnsCli(`const e = join(dir, "..", "index.ts"); Bun.spawn(["bun", e])`, none)).toBe(
      true,
    )
    expect(spawnsCli(`Bun.spawn(["bun", "run", CHILD]) // kid.ts`, new Set(["kid.ts"]))).toBe(true)
  })
  test("accepts the helper or an explicit MINIMAL_AGENT_HOME", () => {
    expect(isolatesHome(`const iso = isolatedCliEnv()`)).toBe(true)
    expect(isolatesHome(`env: { MINIMAL_AGENT_HOME: join(h, ".minimal-agent") }`)).toBe(true)
  })
  test("flags a spawn call with no env or with a bare parent env", () => {
    const calls = spawnCalls(
      `Bun.spawn(["bun", "src/index.ts"], { stdout: "pipe" })\n` +
        `Bun.spawn(["bun", "src/index.ts"], { env: { ...cleanSpawnEnv(), A: "1" } })\n` +
        `Bun.spawn(["bun", "src/index.ts"], { env: ISO.env })\n` +
        `Bun.spawn(["bun", "src/index.ts"], { env: { ...process.env, MINIMAL_AGENT_HOME: h } })`,
    )
    expect(calls.map((c) => callLeak(c) !== null)).toEqual([true, true, false, false])
  })
  test("ignores a file that names the entry but spawns nothing", () => {
    expect(spawnsCli(`const cmd = "npx esbuild src/index.ts --bundle"`, none)).toBe(false)
  })
})

describe("spawn home isolation (ratchet)", () => {
  const files = listTs()
  const read = (p: string): string => readFileSync(p, "utf8")
  const childNames = cliChildNames(files, read)
  const self = import.meta.path
  const spawning = files
    .filter((f) => f.endsWith(".test.ts") && f !== self)
    .filter((f) => spawnsCli(read(f), childNames))

  test("the scan still sees the known CLI spawns", () => {
    // Guards the detector against going blind after a refactor.
    expect(childNames.has("resume-kill-child.ts")).toBe(true)
    const rel = spawning.map((f) => relative(SRC, f))
    expect(rel).toContain("e2e/e2e-smoke.test.ts")
    expect(rel).toContain("e2e/output-mode.e2e.test.ts")
    expect(rel).toContain("startup/resume-continue.test.ts")
    expect(spawning.length).toBeGreaterThanOrEqual(10)
  })

  test("every test that spawns the CLI isolates the agent home", () => {
    const leaks = spawning
      .map((f) => relative(SRC, f))
      .filter((rel) => !ALLOW.has(rel))
      .filter((rel) => !isolatesHome(read(join(SRC, rel))))
    // Fix: spread `isolatedCliEnv().env` (test-utils/isolated-cli-env.ts) into the child env.
    expect(leaks).toEqual([])
  })

  test("every spawn call in those files passes an isolated env", () => {
    const leaks: string[] = []
    for (const f of spawning) {
      const rel = relative(SRC, f)
      if (ALLOW.has(rel)) continue
      for (const call of spawnCalls(read(f))) {
        const why = callLeak(call)
        if (why !== null) leaks.push(`${rel}: ${why}: ${call.slice(0, 80)}`)
      }
    }
    // Fix: pass `env: { ...iso.env, ... }` from isolatedCliEnv() to the call.
    expect(leaks).toEqual([])
  })

  test("every ALLOW entry still exists and still spawns the CLI", () => {
    const rel = new Set(spawning.map((f) => relative(SRC, f)))
    for (const path of ALLOW.keys()) expect(rel.has(path)).toBe(true)
  })
})
