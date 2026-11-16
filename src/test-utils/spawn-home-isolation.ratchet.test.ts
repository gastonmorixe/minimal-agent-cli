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
 *    sets `MINIMAL_AGENT_HOME` in the same call (as a key, not in a comment).
 * 4. The env value is not a bare `process.env` or `cleanSpawnEnv()`.
 * 5. A shorthand `{ env }` or an `env: name` / `env: name(...)` resolves to a
 *    declaration in the same file that spreads an `isolatedCliEnv()` binding,
 *    calls `isolatedCliEnv(`, or sets `MINIMAL_AGENT_HOME:`. `x.env` is only
 *    accepted when `x` is bound to `isolatedCliEnv(...)` in the file.
 * 6. No `HOME:` or `MINIMAL_AGENT_HOME:` key after the isolated spread takes
 *    its value from `process.env.HOME`, `process.env.MINIMAL_AGENT_HOME` or
 *    `homedir()`.
 * Rules 2-6 are per call, so one isolated test in a file does not hide a
 * leaking sibling (e2e-smoke.test.ts had exactly that). Comments are blanked
 * out before every match.
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

/**
 * The source with every comment blanked out (same length, newlines kept).
 * It skips over `'`, `"`, template strings and regex literals, so
 * `"http://x"` stays. `${}` holes are not parsed; the scan is coarse on purpose.
 */
function stripComments(text: string): string {
  let out = ""
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (quote !== null) {
      out += ch
      if (ch === "\\" && i + 1 < text.length) out += text[++i]
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " "
        i++
      }
      if (i < text.length) out += "\n"
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      const stop = end === -1 ? text.length : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, " ")
      i = stop - 1
      continue
    }
    if (ch === "/" && /^$|[(,=:[!&|?{};]$/.test(out.trimEnd().slice(-1))) {
      // A regex literal: copy it whole, so a quote in it opens no string.
      let j = i + 1
      let inClass = false
      for (; j < text.length && text[j] !== "\n"; j++) {
        const c = text[j]
        if (c === "\\") j++
        else if (c === "[") inClass = true
        else if (c === "]") inClass = false
        else if (c === "/" && !inClass) break
      }
      out += text.slice(i, j + 1)
      i = j
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch
    out += ch
  }
  return out
}

/** The text from `start` up to the first `,`, `;` or closer at depth 0. */
function exprFrom(text: string, start: number): string {
  let depth = 0
  let i = start
  for (; i < text.length; i++) {
    const ch = text[i] as string
    if ("([{".includes(ch)) depth++
    else if (")]}".includes(ch)) {
      if (depth === 0) break
      depth--
    } else if ((ch === "," || ch === ";") && depth === 0) break
  }
  return text.slice(start, i).trim()
}

/** Names bound to `isolatedCliEnv(...)` in the file (`const ISO = isolatedCliEnv(`). */
function isoBindings(file: string): Set<string> {
  const names = new Set<string>()
  for (const m of file.matchAll(
    /\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*isolatedCliEnv\s*\(/g,
  )) {
    names.add(m[1] as string)
  }
  return names
}

/** True when `<name>.env` is the env of an isolatedCliEnv binding of the file. */
function isIsoName(name: string, isoNames: ReadonlySet<string>): boolean {
  return isoNames.has(name)
}

/** The declaration text of a const/let/var or a function `name`, or null. */
function declOf(file: string, name: string): string | null {
  const esc = name.replace(/\$/g, "\\$")
  const fn = new RegExp(`\\bfunction\\s+${esc}\\s*\\(`).exec(file)
  if (fn) {
    const open = file.indexOf("{", fn.index + fn[0].length)
    if (open === -1) return null
    let depth = 0
    let i = open
    for (; i < file.length; i++) {
      if (file[i] === "{") depth++
      else if (file[i] === "}" && --depth === 0) break
    }
    return file.slice(fn.index, i + 1)
  }
  const v = new RegExp(
    `\\b(?:const|let|var)\\s+(?:${esc}|\\{[^}]*\\b${esc}\\b[^}]*\\})\\s*(?::[^=]+)?=`,
  ).exec(file)
  if (v) return v[0] + exprFrom(file, v.index + v[0].length)
  return null
}

const REAL_HOME_VALUE_RE =
  /process\.env(?:\.|\[\s*["'])(?:HOME|MINIMAL_AGENT_HOME)\b|\bhomedir\s*\(\s*\)/
const PARENT_SPREAD_RE = /\.\.\.\s*(?:process\.env\b|cleanSpawnEnv\s*\()/
const HOME_KEY_RE = /(?<![\w$.])MINIMAL_AGENT_HOME\s*:/

/** Why an env text (object literal or declaration) leaks, or null. */
function envTextLeak(env: string, isoNames: ReadonlySet<string>): string | null {
  const isoSpreads = [...env.matchAll(/\.\.\.\s*([\w$]+)\.env\b/g)].filter((m) =>
    isIsoName(m[1] as string, isoNames),
  )
  const lastIso = isoSpreads.length > 0 ? (isoSpreads.at(-1)?.index ?? -1) : -1
  for (const m of env.matchAll(/(?<![\w$.])(HOME|MINIMAL_AGENT_HOME)\s*:/g)) {
    // A key before the isolated spread is overridden by it, so it is harmless.
    if ((m.index ?? 0) < lastIso) continue
    const value = exprFrom(env, (m.index ?? 0) + m[0].length)
    if (REAL_HOME_VALUE_RE.test(value)) {
      return `sets ${m[1]} back to the real value (${value})`
    }
  }
  if (PARENT_SPREAD_RE.test(env) && isoSpreads.length === 0 && !HOME_KEY_RE.test(env)) {
    return "spreads the parent env and sets no MINIMAL_AGENT_HOME"
  }
  return null
}

/** True when a declaration builds an isolated env. */
function declIsolates(decl: string, isoNames: ReadonlySet<string>): boolean {
  if (/\bisolatedCliEnv\s*\(/.test(decl) || HOME_KEY_RE.test(decl)) return true
  return [...decl.matchAll(/\b([\w$]+)\.env\b/g)].some((m) => isIsoName(m[1] as string, isoNames))
}

/**
 * Why one spawn call leaks the parent agent home, or null when it does not.
 * `file` is the whole source, used to resolve an `env` identifier. Both are
 * read with comments blanked out.
 */
function callLeak(rawCall: string, rawFile = ""): string | null {
  const call = stripComments(rawCall)
  const file = stripComments(rawFile)
  const isoNames = isoBindings(file)
  const key = /(?<![\w$.])env\s*(?::|(?=[,}]))/.exec(call)
  if (!key) return "no env: the child inherits the parent home"
  const value = key[0].endsWith(":") ? exprFrom(call, key.index + key[0].length) : "env"
  if (/^(?:process\.env|cleanSpawnEnv\s*\([^)]*\))$/.test(value)) {
    return `env is the bare parent env (${value})`
  }
  if (value.startsWith("{")) return envTextLeak(value, isoNames)
  const member = /^([\w$]+)\.env$/.exec(value)
  if (member) {
    if (isIsoName(member[1] as string, isoNames)) return null
    return `env is ${value}, not the env of an isolatedCliEnv() binding`
  }
  const ref = /^([\w$]+)\s*(?:\(|$)/.exec(value)
  if (ref) {
    const decl = declOf(file, ref[1] as string)
    if (decl === null) return `env ${value} is not declared in the file, so it is not isolated`
    const why = envTextLeak(decl, isoNames)
    if (why !== null) return `env ${value}: ${why}`
    if (!declIsolates(decl, isoNames)) return `env ${value} has no temp agent home`
    return null
  }
  return `env ${value.slice(0, 40)} is a form the ratchet cannot check`
}

/** True when the test source gives its child a temp agent home. */
function isolatesHome(text: string): boolean {
  return ISOLATED_RE.test(stripComments(text))
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
    const file =
      `const ISO = isolatedCliEnv()\n` +
      `Bun.spawn(["bun", "src/index.ts"], { stdout: "pipe" })\n` +
      `Bun.spawn(["bun", "src/index.ts"], { env: { ...cleanSpawnEnv(), A: "1" } })\n` +
      `Bun.spawn(["bun", "src/index.ts"], { env: ISO.env })\n` +
      `Bun.spawn(["bun", "src/index.ts"], { env: { ...process.env, MINIMAL_AGENT_HOME: h } })`
    const calls = spawnCalls(file)
    expect(calls.map((c) => callLeak(c, file) !== null)).toEqual([true, true, false, false])
  })

  // Each probe is a whole test file in memory: an isolated binding, then one
  // spawn call. The ratchet must flag every leaking form (review D, W1).
  const ISO_DECL = `const ISO = isolatedCliEnv()\n`
  const leakOf = (body: string): string | null => {
    const file = ISO_DECL + body
    const calls = spawnCalls(stripComments(file))
    expect(calls).toHaveLength(1)
    return callLeak(calls[0] as string, file)
  }
  const SPAWN = `Bun.spawn(["bun", "src/index.ts"], `

  test("flags a bare process.env or cleanSpawnEnv() as the env value", () => {
    expect(leakOf(`${SPAWN}{ env: process.env })`)).toContain("bare parent env")
    expect(leakOf(`${SPAWN}{ env: process.env, stdout: "pipe" })`)).toContain("bare parent env")
    expect(leakOf(`${SPAWN}{ env: cleanSpawnEnv() })`)).toContain("bare parent env")
  })

  test("flags shorthand { env } or env: <name> that is not isolated", () => {
    expect(leakOf(`const env = { ...process.env }\n${SPAWN}{ env })`)).not.toBeNull()
    expect(leakOf(`const env = cleanSpawnEnv()\n${SPAWN}{ stdout: "pipe", env })`)).not.toBeNull()
    expect(leakOf(`const e2 = { ...process.env, A: "1" }\n${SPAWN}{ env: e2 })`)).not.toBeNull()
    // Not declared in the file (a parameter, an import): it cannot be checked.
    expect(leakOf(`${SPAWN}{ env })`)).not.toBeNull()
    // `.env` of something that is not an isolatedCliEnv() binding.
    expect(leakOf(`${SPAWN}{ env: other.env })`)).not.toBeNull()
  })

  test("accepts shorthand { env } or env: <name> built from the isolated env", () => {
    expect(leakOf(`const env = { ...ISO.env, A: "1" }\n${SPAWN}{ env })`)).toBeNull()
    expect(leakOf(`const env = ISO.env\n${SPAWN}{ env })`)).toBeNull()
    const fn = `function spawnEnv(h) {\n  return { ...process.env, MINIMAL_AGENT_HOME: h }\n}\n`
    expect(leakOf(`${fn}${SPAWN}{ env: spawnEnv(home) })`)).toBeNull()
  })

  test("ignores a MINIMAL_AGENT_HOME that only sits in a comment", () => {
    expect(leakOf(`${SPAWN}{ env: { ...process.env /* MINIMAL_AGENT_HOME: x */ } })`)).toContain(
      "sets no MINIMAL_AGENT_HOME",
    )
    expect(
      leakOf(`${SPAWN}{\n  // MINIMAL_AGENT_HOME: x\n  env: { ...process.env },\n})`),
    ).toContain("sets no MINIMAL_AGENT_HOME")
    // An `env:` in a comment is not an env either.
    expect(leakOf(`${SPAWN}{ stdout: "pipe" /* env: ISO.env */ })`)).toContain("no env")
  })

  test("flags HOME or MINIMAL_AGENT_HOME set back to the real value after the spread", () => {
    expect(leakOf(`${SPAWN}{ env: { ...ISO.env, HOME: process.env.HOME } })`)).toContain(
      "sets HOME back",
    )
    expect(
      leakOf(
        `${SPAWN}{ env: { ...ISO.env, A: "1", MINIMAL_AGENT_HOME: process.env.MINIMAL_AGENT_HOME } })`,
      ),
    ).toContain("sets MINIMAL_AGENT_HOME back")
    expect(leakOf(`${SPAWN}{ env: { ...ISO.env, HOME: homedir() } })`)).toContain("sets HOME back")
    expect(
      leakOf(`const env = { ...ISO.env, HOME: process.env["HOME"] }\n${SPAWN}{ env })`),
    ).toContain("sets HOME back")
    // Before the spread the key is overridden by ISO.env, so it is harmless.
    expect(leakOf(`${SPAWN}{ env: { HOME: process.env.HOME, ...ISO.env } })`)).toBeNull()
    // A temp value after the spread is fine.
    expect(leakOf(`${SPAWN}{ env: { ...ISO.env, HOME: ISO.home } })`)).toBeNull()
  })

  test("stripComments keeps strings and regex literals", () => {
    const src = `const u = "http://x" // c\nconst r = /"/; /* b */ const s = '//'`
    const out = stripComments(src)
    expect(out).toHaveLength(src.length)
    expect(out).toContain(`"http://x"`)
    expect(out).toContain(`/"/;`)
    expect(out).toContain(`'//'`)
    expect(out).not.toContain("// c")
    expect(out).not.toContain("/* b */")
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
      for (const call of spawnCalls(stripComments(read(f)))) {
        const why = callLeak(call, read(f))
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
