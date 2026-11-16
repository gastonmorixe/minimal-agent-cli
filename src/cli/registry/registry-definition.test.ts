/**
 * Definition test of the built-in CLI registry (SPEC-HELP V-14, plan M-8a).
 *
 * Checks the registry data itself. Nothing reads the registry yet, so these
 * tests are the only guard on its shape until M-8b and M-8c wire it in.
 *
 * @module cli/registry/registry-definition.test
 */

import { describe, expect, test } from "bun:test"

import type {
  ArgSpec,
  CommandSpec,
  FlagSpec,
} from "@minimal-agent/core/plugin-api/types/cli-contract"

import { FLAGS_NO_VALUE, FLAGS_WITH_VALUES } from "../extract-prompt.ts"
import { SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS } from "../system-prompt-override-flags.ts"
import { allFlags, builtinRegistry, childrenOf, findCommand, longForms } from "./index.ts"

const reg = builtinRegistry()

/** Every command node with its path. The root has an empty path. */
function allCommands(): { node: CommandSpec; path: string[] }[] {
  const out: { node: CommandSpec; path: string[] }[] = []
  const walk = (node: CommandSpec, path: string[]): void => {
    out.push({ node, path })
    for (const child of childrenOf(node)) walk(child, [...path, child.name])
  }
  walk(reg.root, [])
  return out
}

const commands = allCommands()
const label = (path: readonly string[]): string => (path.length === 0 ? "<root>" : path.join(" "))
const globalSet = new Set<FlagSpec>(reg.globalFlags)

/**
 * Command-local flags that share a long form with a global flag on purpose
 * (`<path> <--flag>`). The command reads its own flag, and the run path
 * never sees that command. `auth-status prune --dry-run` lists credentials
 * to delete. The global `--dry-run` builds a model request and does not
 * send it. Keep this list short.
 */
const SHADOW_OK: ReadonlySet<string> = new Set(["auth-status prune --dry-run"])

/** Values of `list` that occur more than once. */
function duplicates(list: readonly string[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const item of list) {
    if (seen.has(item)) dup.add(item)
    seen.add(item)
  }
  return [...dup].sort()
}

/** Every string in `value`, with a JSON-ish location, for the R-3 scan. */
function collectStrings(value: unknown, at: string, out: { at: string; s: string }[]): void {
  if (typeof value === "string") out.push({ at, s: value })
  else if (Array.isArray(value)) value.forEach((v, i) => collectStrings(v, `${at}[${i}]`, out))
  else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) collectStrings(v, `${at}.${k}`, out)
  }
}

/** Every non-data leaf in `value` (functions, class instances, undefined in arrays). */
function nonData(value: unknown, at: string, out: string[]): void {
  if (typeof value === "function") out.push(at)
  else if (Array.isArray(value)) {
    value.forEach((v, i) => {
      if (v === undefined) out.push(`${at}[${i}]`)
      else nonData(v, `${at}[${i}]`, out)
    })
  } else if (typeof value === "object" && value !== null) {
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) out.push(at)
    for (const [k, v] of Object.entries(value)) nonData(v, `${at}.${k}`, out)
  }
}

describe("registry data", () => {
  test("is JSON data only (R-2)", () => {
    const out: string[] = []
    nonData(reg, "reg", out)
    expect(out).toEqual([])
  })

  test("strings hold no ESC or other C0 control character (R-3)", () => {
    const strings: { at: string; s: string }[] = []
    collectStrings(reg, "reg", strings)
    expect(strings.length).toBeGreaterThan(100)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the test looks for them.
    const bad = strings.filter(({ s }) => /[\u0000-\u001f\u007f]/u.test(s)).map(({ at }) => at)
    expect(bad).toEqual([])
  })
})

describe("summaries", () => {
  test("every command has a summary", () => {
    const missing = commands.filter(({ node }) => node.summary.trim() === "").map((c) => c.path)
    expect(missing).toEqual([])
  })

  test("every flag at every depth has a summary", () => {
    const missing = allFlags(reg)
      .filter(({ spec }) => spec.summary.trim() === "")
      .map(({ spec, path }) => `${label(path)} --${spec.name}`)
    expect(missing).toEqual([])
  })

  test("every arg has a summary", () => {
    const missing: string[] = []
    for (const { node, path } of commands) {
      for (const arg of node.args ?? []) {
        if (arg.summary.trim() === "") missing.push(`${label(path)} <${arg.name}>`)
      }
    }
    expect(missing).toEqual([])
  })

  test("every env entry has a summary", () => {
    expect(reg.env.filter((e) => e.summary.trim() === "").map((e) => e.name)).toEqual([])
  })

  test("every example has a summary", () => {
    const missing: string[] = []
    for (const { node, path } of commands) {
      for (const ex of node.examples ?? []) {
        if (ex.summary.trim() === "") missing.push(`${label(path)}: ${ex.argv}`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe("names", () => {
  test("command names match the contract pattern", () => {
    const bad = commands
      .filter(({ path }) => path.length > 0)
      .flatMap(({ node }) => [node.name].concat(node.aliases ?? []))
      .filter((name) => !/^[a-z0-9][a-z0-9-]*$/u.test(name))
    expect(bad).toEqual([])
  })

  test("child command names and aliases are unique per path", () => {
    const bad: string[] = []
    for (const { node, path } of commands) {
      const names = childrenOf(node).flatMap((c) => [c.name].concat(c.aliases ?? []))
      for (const d of duplicates(names)) bad.push(`${label(path)}: ${d}`)
    }
    expect(bad).toEqual([])
  })

  test("arg names are unique per path, and only the last arg is variadic", () => {
    const bad: string[] = []
    for (const { node, path } of commands) {
      const args: readonly ArgSpec[] = node.args ?? []
      for (const d of duplicates(args.map((a) => a.name))) bad.push(`${label(path)}: <${d}>`)
      args.forEach((a, i) => {
        if (a.variadic === true && i !== args.length - 1) bad.push(`${label(path)}: ...<${a.name}>`)
      })
    }
    expect(bad).toEqual([])
  })

  test("global long forms are unique", () => {
    expect(duplicates(reg.globalFlags.flatMap(longForms))).toEqual([])
  })

  test("long forms are unique across the globals plus any one path", () => {
    const bad: string[] = []
    for (const { node, path } of commands) {
      const own = (node.flags ?? []).filter((f) => !globalSet.has(f))
      const longs = [...reg.globalFlags, ...own].flatMap(longForms)
      for (const d of duplicates(longs)) {
        if (!SHADOW_OK.has(`${label(path)} ${d}`)) bad.push(`${label(path)}: ${d}`)
      }
    }
    expect(bad).toEqual([])
  })

  test("each allowed shadow still exists (stale entries fail)", () => {
    const seen = new Set<string>()
    for (const { node, path } of commands) {
      const own = (node.flags ?? []).filter((f) => !globalSet.has(f))
      for (const d of duplicates([...reg.globalFlags, ...own].flatMap(longForms))) {
        seen.add(`${label(path)} ${d}`)
      }
    }
    expect([...SHADOW_OK].filter((k) => !seen.has(k))).toEqual([])
  })

  test("no short flag clash across the globals plus any one path", () => {
    const bad: string[] = []
    for (const { node, path } of commands) {
      const own = (node.flags ?? []).filter((f) => !globalSet.has(f))
      const shorts = [...reg.globalFlags, ...own].flatMap((f) => (f.short ? [f.short] : []))
      for (const d of duplicates(shorts)) bad.push(`${label(path)}: -${d}`)
    }
    expect(bad).toEqual([])
  })

  test("short flags are one character", () => {
    const bad = allFlags(reg)
      .filter(({ spec }) => spec.short !== undefined && spec.short.length !== 1)
      .map(({ spec }) => spec.name)
    expect(bad).toEqual([])
  })

  test("env names are unique", () => {
    expect(duplicates(reg.env.map((e) => e.name))).toEqual([])
  })
})

describe("global flags", () => {
  test("every global flag has global: true, and no command flag does", () => {
    expect(reg.globalFlags.filter((f) => f.global !== true).map((f) => f.name)).toEqual([])
    const bad = allFlags(reg)
      .filter(({ path }) => path.length > 0)
      .filter(({ spec }) => spec.global === true)
      .map(({ spec, path }) => `${label(path)} --${spec.name}`)
    expect(bad).toEqual([])
  })

  test("a command reuses a global flag name only by reference", () => {
    const globalNames = new Set(reg.globalFlags.flatMap(longForms))
    const bad = allFlags(reg)
      .filter(({ path }) => path.length > 0)
      .filter(({ longs }) => longs.some((l) => globalNames.has(l)))
      .map(({ spec, path }) => `${label(path)} --${spec.name}`)
      .filter((key) => !SHADOW_OK.has(key))
    expect(bad).toEqual([])
  })

  test("every global flag group names a flag group", () => {
    const ids = new Set(reg.flagGroups.map((g) => g.id))
    const bad = reg.globalFlags.filter((f) => f.group === undefined || !ids.has(f.group))
    expect(bad.map((f) => f.name)).toEqual([])
  })

  test("global flags sit in blocks by group, in flag group order (plan 2.3)", () => {
    const order = reg.flagGroups.map((g) => g.id)
    const blocks: string[] = []
    for (const f of reg.globalFlags) {
      if (blocks.at(-1) !== f.group) blocks.push(f.group ?? "")
    }
    expect(blocks).toEqual(order)
  })

  test("visible global flags match the root help rows (43 Options, 8 System prompt, help, version)", () => {
    const visible = reg.globalFlags.filter((f) => f.hidden !== true)
    const sp = visible.filter((f) => f.group === "system-prompt")
    const help = visible.filter((f) => f.group === "help")
    expect(visible.length - sp.length - help.length).toBe(43)
    expect(sp.length).toBe(8)
    expect(help.map((f) => f.name)).toEqual(["help", "version"])
  })

  test("system-prompt flags match the parser's override flag specs", () => {
    const parser = SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS.flatMap((s) => [
      s.valueFlag,
      s.fileFlag,
      s.noFlag,
    ])
    // Not core override keys: the unsafe gate and the SPEC-ONESHOT append flags.
    const notOverrideKeys = new Set([
      "unsafe-system-prompt-overrides",
      "append-system-prompt",
      "append-system-prompt-file",
    ])
    const registry = reg.globalFlags
      .filter((f) => f.group === "system-prompt" && !notOverrideKeys.has(f.name))
      .map((f) => `--${f.name}`)
    expect([...registry].sort()).toEqual([...parser].sort())
  })

  test("system-prompt env names match the core key specs", () => {
    const core = SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS.flatMap((s) => [s.envVar, s.fileEnvVar])
    const registry = reg.env
      .filter((e) => e.hidden === true && e.name.includes("SYSTEM_"))
      .map((e) => e.name)
    expect([...registry].sort()).toEqual([...core].sort())
  })
})

describe("env", () => {
  test("46 visible rows, as in root help", () => {
    expect(reg.env.filter((e) => e.hidden !== true).length).toBe(46)
  })

  test("18 visible rows carry a value hint (NAME=1 or NAME=0)", () => {
    const set = reg.env.filter((e) => e.set !== undefined)
    expect(set.length).toBe(18)
    expect(set.every((e) => e.set === "1" || e.set === "0")).toBe(true)
  })

  test("every env flag pointer names a registry flag", () => {
    const names = new Set(allFlags(reg).map(({ spec }) => spec.name))
    const bad = reg.env.filter((e) => e.flag !== undefined && !names.has(e.flag))
    expect(bad.map((e) => `${e.name} -> ${e.flag}`)).toEqual([])
  })

  test("every global flag env names a known variable or a documented one", () => {
    // Variables a global flag names but root help does not list as an env
    // row today. M-8d decides whether they get their own row.
    const unlisted = new Set([
      "MINIMAL_AGENT_CACHE_TTL",
      "MINIMAL_AGENT_SERVICE_TIER",
      "MINIMAL_AGENT_CREDENTIAL_NAME",
      "MINIMAL_AGENT_PLATFORM",
      "MINIMAL_AGENT_SESSION_ID",
      "VERBOSE",
      // SPEC-ONESHOT, hidden until wired. The env row comes with the wiring.
      "MINIMAL_AGENT_TEMPERATURE",
    ])
    const envNames = new Set(reg.env.map((e) => e.name))
    const bad = allFlags(reg)
      .map(({ spec }) => spec.env)
      .filter((e): e is string => e !== undefined)
      .filter((e) => !envNames.has(e) && !unlisted.has(e) && e !== "MINIMAL_AGENT_PRINT_FORMAT")
    expect(bad).toEqual([])
  })
})

describe("groups", () => {
  test("every root group member path resolves", () => {
    const bad = reg.rootGroups
      .flatMap((g) => g.members)
      .filter((path) => findCommand(reg, path) === undefined)
      .map((path) => path.join(" "))
    expect(bad).toEqual([])
  })

  test("every command group names a root group", () => {
    const ids = new Set(reg.rootGroups.map((g) => g.id))
    const bad = commands
      .filter(({ node }) => node.group !== undefined && !ids.has(node.group))
      .map(({ path }) => label(path))
    expect(bad).toEqual([])
  })

  test("every visible top-level command has a group", () => {
    const bad = reg.commands.filter((c) => c.hidden !== true && c.group === undefined)
    expect(bad.map((c) => c.name)).toEqual([])
  })

  test("root group and flag group ids are unique", () => {
    expect(duplicates(reg.rootGroups.map((g) => g.id))).toEqual([])
    expect(duplicates(reg.flagGroups.map((g) => g.id))).toEqual([])
  })

  test("every seeAlso path resolves", () => {
    const bad = commands
      .flatMap(({ node }) => node.seeAlso ?? [])
      .filter((path) => findCommand(reg, path) === undefined)
      .map((path) => path.join(" "))
    expect(bad).toEqual([])
  })

  test("root.commands is the commands list", () => {
    expect(reg.root.commands).toBe(reg.commands as CommandSpec[])
  })
})

describe("lookups", () => {
  test("findCommand walks names from the root", () => {
    expect(findCommand(reg, [])).toBe(reg.root)
    expect(findCommand(reg, ["sessions", "dump"])?.summary).toBe(
      "Dump a full session history to stdout",
    )
    expect(findCommand(reg, ["auth-status", "plan"])?.name).toBe("plan")
    expect(findCommand(reg, ["bogus"])).toBeUndefined()
  })

  test("allFlags lists a global spec once, also when a command reuses it", () => {
    const provider = allFlags(reg).filter(({ spec }) => spec.name === "provider")
    expect(provider.map(({ path }) => path)).toEqual([[]])
  })

  test("longForms adds aliases and the no- form of a negatable flag", () => {
    const header = reg.globalFlags.find((f) => f.name === "header")
    expect(header === undefined ? [] : longForms(header)).toEqual(["--header", "--no-header"])
    const format = reg.globalFlags.find((f) => f.name === "format")
    expect(format === undefined ? [] : longForms(format)).toEqual(["--format", "--surface"])
  })
})

/**
 * Long flags of the hand-kept arity sets that the registry does not hold,
 * each with a reason. Empty today. The list must only shrink.
 */
const ARITY_SET_ALLOW: Readonly<Record<string, string>> = {}

/**
 * Long flags whose true arity (the registry `value`) differs from the
 * arity sets in src/cli/extract-prompt.ts. Empty since M-12: the sets are
 * derived from the registry (src/cli/registry/arity.ts). The gaps M-12
 * fixed (`--parallel`, 8 booleans, `--usage`) are pinned in arity.test.ts
 * (V-18). An `optional` flag in `FLAGS_NO_VALUE` is the intended handling
 * (spec M-12), not a difference.
 */
const ARITY_DIFFERENCES: Readonly<Record<string, string>> = {}

describe("arity sets of extract-prompt.ts", () => {
  /** Long form to the registry `value` of every spec that has it. */
  const registryArity = new Map<string, Set<string>>()
  for (const { spec, longs } of allFlags(reg)) {
    const value = spec.value ?? (spec.type === "boolean" ? "none" : "required")
    longs.forEach((long, i) => {
      // The `--no-<name>` form of a negatable flag never takes a value.
      const v = spec.negatable === true && i === longs.length - 1 ? "none" : value
      const set = registryArity.get(long) ?? new Set<string>()
      set.add(v)
      registryArity.set(long, set)
    })
  }
  const isLong = (f: string): boolean => /^--[a-z0-9]/u.test(f)

  test("every long flag in FLAGS_WITH_VALUES and FLAGS_NO_VALUE is in the registry", () => {
    const missing = [...FLAGS_WITH_VALUES, ...FLAGS_NO_VALUE]
      .filter(isLong)
      .filter((f) => !registryArity.has(f) && !(f in ARITY_SET_ALLOW))
    expect(missing).toEqual([])
  })

  test("the allowlist has no stale entry", () => {
    const stale = Object.keys(ARITY_SET_ALLOW).filter((f) => registryArity.has(f))
    expect(stale).toEqual([])
  })

  test("one long form has one arity across the registry", () => {
    const bad = [...registryArity].filter(([, v]) => v.size > 1).map(([f]) => f)
    expect(bad).toEqual([])
  })

  test("arity differences from the hand-kept sets are exactly the pinned list", () => {
    // Compare each spec's own name (and its `--no-` form). An alias form
    // counts only when a set lists it: `normalizeArgs` rewrites the
    // LONG_ALIAS forms (`--models`, `--session`, ...) to the name before
    // the prompt scan, so the scan never sees them.
    const own = new Set(
      allFlags(reg).flatMap(({ spec }) =>
        spec.negatable === true ? [`--${spec.name}`, `--no-${spec.name}`] : [`--${spec.name}`],
      ),
    )
    const diffs: Record<string, string> = {}
    for (const [long, values] of registryArity) {
      if (!own.has(long) && !FLAGS_WITH_VALUES.has(long) && !FLAGS_NO_VALUE.has(long)) continue
      const value = [...values][0] ?? ""
      const set = FLAGS_WITH_VALUES.has(long)
        ? "FLAGS_WITH_VALUES"
        : FLAGS_NO_VALUE.has(long)
          ? "FLAGS_NO_VALUE"
          : "neither set"
      const expected = set === "FLAGS_WITH_VALUES" ? ["required"] : ["none", "optional"]
      if (set === "neither set" || !expected.includes(value)) {
        diffs[long] = `${value}: in ${set}`
      }
    }
    // A value flag in neither set leaks its value as a prompt. An optional
    // flag stays in FLAGS_NO_VALUE on purpose (spec M-12).
    expect(diffs).toEqual(ARITY_DIFFERENCES)
  })
})
