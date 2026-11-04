/**
 * V-18 (SPEC-HELP M-12): the arity tables derived from the registry equal
 * the old hand-written tables, except the pinned gaps below.
 *
 * The old tables are frozen here as data. They were the hand lists in
 * src/cli/extract-prompt.ts (`FLAGS_WITH_VALUES`, `FLAGS_NO_VALUE`) and
 * src/cli/cli-args.ts (`SHORT_TO_LONG`, `LONG_ALIAS`) at cli 01613ed.
 *
 * @module cli/registry/arity.test
 */

import { describe, expect, test } from "bun:test"

import type { FlagSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { normalizeArgs } from "../cli-args.ts"
import { extractPromptFromArgs, FLAGS_NO_VALUE, FLAGS_WITH_VALUES } from "../extract-prompt.ts"
import {
  SYSTEM_PROMPT_OVERRIDE_NO_VALUE_FLAGS,
  SYSTEM_PROMPT_OVERRIDE_VALUE_FLAGS,
} from "../system-prompt-override-flags.ts"
import { builtinArity, deriveArity, EXTRA_NO_VALUE_TOKENS } from "./arity.ts"
import { builtinRegistry } from "./index.ts"
import type { BuiltinRegistry } from "./types.ts"

/** The old hand set `FLAGS_WITH_VALUES`. */
const OLD_FLAGS_WITH_VALUES: readonly string[] = [
  "--model",
  "--provider",
  "--endpoint",
  "--format",
  "--surface",
  "--auth-type",
  "--api-key",
  "--auth-header",
  "--provider-model",
  "--effort-levels",
  "--session-id",
  "--prompt",
  "--resume",
  "--resume-same-sid",
  "--formatter",
  "--formatter-args",
  "--effort",
  "--spinner",
  "--thinking-display",
  "--cache-ttl",
  "--mode",
  "--disable-plugin",
  "--enable-plugin",
  "--dump",
  "--dump-format",
  "--email",
  "--email-hint",
  "--auth-method",
  "--credential-name",
  "--name",
  "--output-schema",
  "--output-format",
  "--print-format",
  "--service-tier",
  "--platform",
  "--tools",
  "--host-mode",
  ...SYSTEM_PROMPT_OVERRIDE_VALUE_FLAGS,
]

/** The old hand set `FLAGS_NO_VALUE`. */
const OLD_FLAGS_NO_VALUE: readonly string[] = [
  "--debug",
  "--verbose",
  "--list-models",
  "--list-models-live",
  "--list-flags",
  "--list-plugins",
  "--list-spinners",
  "--list-providers",
  "--sessions",
  "--help",
  "-h",
  "-",
  "--skip-quota",
  "--show-hidden-chars",
  "--header",
  "--no-header",
  "--no-tools",
  "--no-color",
  "--no-agents-md",
  "--no-agents",
  "--login",
  "--logout",
  "--auth-status",
  ...SYSTEM_PROMPT_OVERRIDE_NO_VALUE_FLAGS,
]

/** The old hand map `SHORT_TO_LONG`. */
const OLD_SHORT_TO_LONG: Readonly<Record<string, string>> = {
  "-m": "--model",
  "-p": "--prompt",
  "-f": "--formatter",
  "-e": "--effort",
  "-s": "--spinner",
  "-r": "--resume",
  "-F": "--fast",
  "-d": "--debug",
  "-v": "--verbose",
  "-h": "--help",
}

/** The old hand map `LONG_ALIAS`. */
const OLD_LONG_ALIAS: Readonly<Record<string, string>> = {
  "--models": "--list-models",
  "--models-live": "--list-models-live",
  "--providers": "--list-providers",
  "--list-model": "--list-models",
  "--list-model-live": "--list-models-live",
  "--flags": "--list-flags",
  "--list-flag": "--list-flags",
  "--plugins": "--list-plugins",
  "--list-plugin": "--list-plugins",
  "--spinners": "--list-spinners",
  "--list-spinner": "--list-spinners",
  "--session": "--sessions",
  "--list-sessions": "--sessions",
  "--usage-stats": "--usage",
}

/**
 * Gap fix: a `required` flag that the old `FLAGS_WITH_VALUES` missed. The
 * prompt scan now skips its value.
 */
const GAINED_WITH_VALUES: Readonly<Record<string, string>> = {
  "--parallel":
    "auth-status refresh-all|plan|prune: required <n>. `--parallel 8 hello` gave prompt 8, now hello",
}

/**
 * Gap fix: flags that the old `FLAGS_NO_VALUE` missed. The prompt scan
 * already skipped every one of them (a token that starts with `--` is never
 * a prompt), so the scan result does not change. The set is now complete.
 */
const GAINED_NO_VALUE: Readonly<Record<string, string>> = {
  // `none` flags.
  "--all": "auth-status plan: none",
  "--diagnostics": "global: none",
  "--dry-run": "auth-status prune: none",
  "--dump-paths": "sessions dump: none",
  "--fast": "global: none",
  "--force": "auth-status prune: none",
  "--json": "global: none",
  "--table": "auth-status: none",
  // `optional` flag: stays a no-value flag (spec M-12). parse-argv.ts reads
  // the period with `valueAfter`. Same handling as `--sessions`.
  "--usage": "command form: optional <period>",
  // Command-form aliases. normalizeArgs rewrites them to the name before the
  // scan, so the scan never sees them.
  "--flags": "alias of --list-flags",
  "--list-flag": "alias of --list-flags",
  "--list-model": "alias of --list-models",
  "--list-model-live": "alias of --list-models-live",
  "--list-plugin": "alias of --list-plugins",
  "--list-sessions": "alias of --sessions",
  "--list-spinner": "alias of --list-spinners",
  "--models": "alias of --list-models",
  "--models-live": "alias of --list-models-live",
  "--plugins": "alias of --list-plugins",
  "--providers": "alias of --list-providers",
  "--session": "alias of --sessions",
  "--spinners": "alias of --list-spinners",
  "--usage-stats": "alias of --usage",
}

/** Optional-value flags. Spec M-12: they stay in `FLAGS_NO_VALUE`. */
const OPTIONAL_VALUE_FLAGS = [
  "--list-models",
  "--list-models-live",
  "--sessions",
  "--usage",
] as const

const sorted = (items: Iterable<string>): string[] => [...items].sort()

describe("V-18: derived arity tables equal the old hand tables plus the pinned gaps", () => {
  const derived = builtinArity()

  test("FLAGS_WITH_VALUES: old set plus --parallel", () => {
    expect(sorted(derived.flagsWithValues)).toEqual(
      sorted(new Set([...OLD_FLAGS_WITH_VALUES, ...Object.keys(GAINED_WITH_VALUES)])),
    )
  })

  test("FLAGS_NO_VALUE: old set plus the pinned gaps", () => {
    expect(sorted(derived.flagsNoValue)).toEqual(
      sorted(new Set([...OLD_FLAGS_NO_VALUE, ...Object.keys(GAINED_NO_VALUE)])),
    )
  })

  test("no flag left an old set, and no flag moved between the sets", () => {
    expect(OLD_FLAGS_WITH_VALUES.filter((f) => !derived.flagsWithValues.has(f))).toEqual([])
    expect(OLD_FLAGS_NO_VALUE.filter((f) => !derived.flagsNoValue.has(f))).toEqual([])
    expect([...derived.flagsWithValues].filter((f) => derived.flagsNoValue.has(f))).toEqual([])
  })

  test("optional-value flags stay in FLAGS_NO_VALUE (spec M-12)", () => {
    for (const flag of OPTIONAL_VALUE_FLAGS) {
      expect(derived.flagsNoValue.has(flag)).toBe(true)
      expect(derived.flagsWithValues.has(flag)).toBe(false)
    }
  })

  test("SHORT_TO_LONG equals the old hand map", () => {
    expect({ ...derived.shortToLong }).toEqual({ ...OLD_SHORT_TO_LONG })
  })

  test("LONG_ALIAS equals the old hand map", () => {
    expect({ ...derived.longAlias }).toEqual({ ...OLD_LONG_ALIAS })
  })

  test("the parser exports are the derived tables", () => {
    expect(FLAGS_WITH_VALUES).toBe(derived.flagsWithValues)
    expect(FLAGS_NO_VALUE).toBe(derived.flagsNoValue)
  })

  test("the extra no-value tokens are the stdin sentinel and -h", () => {
    expect([...EXTRA_NO_VALUE_TOKENS]).toEqual(["-", "-h"])
  })
})

describe("gap fixes through the real parser path", () => {
  const prompt = (raw: string[]) => extractPromptFromArgs(normalizeArgs(raw))

  test("--parallel no longer leaks its value as the prompt", () => {
    expect(prompt(["--parallel", "8", "hello"])).toEqual({ kind: "literal", text: "hello" })
    expect(prompt(["--parallel", "8"])).toEqual({ kind: "none" })
    expect(prompt(["--parallel=8"])).toEqual({ kind: "none" })
  })

  test("the auth-status sub-verb is still the first positional (unchanged)", () => {
    // run-subcommand.ts reads the sub-verb with args.includes. The prompt
    // scan sees it as a bare positional, before and after M-12.
    expect(prompt(["auth-status", "prune", "--parallel", "8"])).toEqual({
      kind: "literal",
      text: "prune",
    })
  })

  test("a boolean gap flag does not eat the next positional", () => {
    for (const flag of ["--fast", "-F", "--json", "--diagnostics", "--table", "--all"]) {
      expect(prompt([flag, "word"])).toEqual({ kind: "literal", text: "word" })
    }
  })

  test("an optional-value flag keeps today's scan result", () => {
    // Its value is a positional to the scan. The flag selects a command
    // that never reads the prompt, so this result has no effect on the run.
    expect(prompt(["--sessions", "q"])).toEqual({ kind: "literal", text: "q" })
    expect(prompt(["usage", "x"])).toEqual({ kind: "literal", text: "x" })
  })
})

describe("deriveArity", () => {
  const spec = (s: Partial<FlagSpec> & { name: string }): FlagSpec => ({
    type: "string",
    summary: "s",
    ...s,
  })
  const reg = (globalFlags: FlagSpec[], commandFlags: FlagSpec[] = []): BuiltinRegistry => {
    const base = builtinRegistry()
    const command = { name: "cmd", summary: "c", flags: commandFlags }
    return {
      ...base,
      root: { ...base.root, commands: [command] },
      commands: [command],
      globalFlags,
    }
  }

  test("maps value modes, shorts, negation, and command-form aliases", () => {
    const t = deriveArity(
      reg(
        [
          spec({ name: "req", short: "q", value: "required", aliases: ["rq"] }),
          spec({ name: "opt", value: "optional", group: "command-forms", aliases: ["op"] }),
          spec({ name: "hdr", type: "boolean", negatable: true }),
        ],
        [spec({ name: "num", type: "number" })],
      ),
    )
    expect(sorted(t.flagsWithValues)).toEqual(["--num", "--req", "--rq"])
    expect(sorted(t.flagsNoValue)).toEqual(
      sorted(["-", "-h", "--opt", "--op", "--hdr", "--no-hdr"]),
    )
    expect({ ...t.shortToLong }).toEqual({ "-q": "--req" })
    expect({ ...t.longAlias }).toEqual({ "--op": "--opt" })
  })

  test("throws when one long form has two arities", () => {
    expect(() =>
      deriveArity(
        reg([spec({ name: "x", value: "required" })], [spec({ name: "x", value: "none" })]),
      ),
    ).toThrow("two arities")
  })

  test("throws when one short form maps to two flags", () => {
    expect(() =>
      deriveArity(reg([spec({ name: "a", short: "z" })], [spec({ name: "b", short: "z" })])),
    ).toThrow("-z maps to")
  })
})
