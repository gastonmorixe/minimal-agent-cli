/**
 * Help drift: the long flags the parser knows against the long flags the
 * help side declares (SPEC-HELP M-2, M-8b, R-33, V-4).
 *
 * The parser is not registry-driven yet (M-12). So the parser set is the
 * union of:
 *   - the exported arity sets `FLAGS_WITH_VALUES` and `FLAGS_NO_VALUE`
 *     (src/cli/extract-prompt.ts), which include the system-prompt override
 *     flags, and
 *   - every whole long-flag string literal in the parse sites listed in
 *     research 01/C-1 (`PARSER_FILES`). This covers the alias maps
 *     `SHORT_TO_LONG` and `LONG_ALIAS` (src/cli/cli-args.ts), which are not
 *     exported, and the ad hoc `args.includes` reads.
 *
 * The help set is the union of:
 *   - the registry set: every long form (name, aliases, `--no-<name>`) of
 *     every FlagSpec in the built-in registry (src/cli/registry and the
 *     `*.command.ts` files), global and per command, hidden included, and
 *   - the text set: every `--x` token in the ANSI-free root help text. This
 *     catches flag names that only appear in note text.
 *
 * Both differences (parser minus help, help minus parser) must equal the
 * entries in help-drift.allow.txt. The test fails on a new mismatch and on
 * a stale entry (an entry that no longer mismatches). The list must only
 * shrink.
 *
 * A second check keeps root help text in step with the registry until
 * M-8c builds root help from it: the text shows every long form of every
 * visible global flag.
 *
 * @module architecture/help-drift.test
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { FLAGS_NO_VALUE, FLAGS_WITH_VALUES } from "../cli/extract-prompt.ts"
import { allFlags, builtinRegistry, longForms } from "../cli/registry/index.ts"
import { renderHelp } from "../startup/help.ts"
import { flagLiterals } from "./flag-ownership.ts"

const CLI_ROOT = join(import.meta.dir, "..", "..")
const ALLOW_FILE = join(import.meta.dir, "help-drift.allow.txt")

/** Parse sites from research 01/C-1, repo-relative. */
const PARSER_FILES = [
  "src/cli/cli-args.ts",
  "src/cli/extract-prompt.ts",
  "src/cli/non-interactive-defaults.ts",
  "src/cli/parse-argv.ts",
  "src/cli/system-prompt-override-flags.ts",
  "src/cli/system-prompt-override-resolution.ts",
  "src/main.ts",
  "src/startup/entry-args.ts",
  "src/startup/live-repl.ts",
  "src/startup/run-subcommand.ts",
] as const

const MARKERS = ["help-only", "parser-only"] as const
type Marker = (typeof MARKERS)[number]

/**
 * A `--x` token in help text. A placeholder prefix such as `--no-<name>` is
 * not a token: a match that ends in `-` or is followed by `<` is rejected.
 */
const HELP_FLAG_RE = /--[a-z0-9][a-z0-9-]*(?![a-z0-9<-])/gu

interface AllowEntry {
  readonly marker: Marker
  readonly flag: string
}

interface Drift {
  /** Mismatches that are not in the allowlist, as `<marker> <flag>`. */
  readonly unlisted: readonly string[]
  /** Allowlist entries that no longer mismatch. */
  readonly stale: readonly string[]
}

const isLongFlag = (s: string): boolean => /^--[a-z0-9]/u.test(s)

function parserFlags(): Set<string> {
  const out = new Set<string>()
  for (const flag of [...FLAGS_WITH_VALUES, ...FLAGS_NO_VALUE]) {
    if (isLongFlag(flag)) out.add(flag)
  }
  for (const file of PARSER_FILES) {
    for (const flag of flagLiterals(readFileSync(join(CLI_ROOT, file), "utf8"))) out.add(flag)
  }
  return out
}

/** Every long form of every FlagSpec in the registry, at every depth, hidden included. */
function registryFlags(): Set<string> {
  return new Set(allFlags(builtinRegistry()).flatMap((f) => f.longs))
}

/** Every `--x` token in the ANSI-free root help text. */
function helpTextFlags(): Set<string> {
  const text = stripAnsi(renderHelp().join("\n"))
  return new Set([...text.matchAll(HELP_FLAG_RE)].map((m) => m[0]))
}

/** The help side of the drift: the registry set plus the root help text set. */
function helpFlags(): Set<string> {
  return new Set([...registryFlags(), ...helpTextFlags()])
}

/** Every long form of every visible global flag in the registry. */
function visibleGlobalFlags(): string[] {
  return builtinRegistry()
    .globalFlags.filter((spec) => spec.hidden !== true)
    .flatMap((spec) => longForms(spec))
}

/** Entry lines of the allowlist text: no comments, no blank lines. */
function allowLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
}

function parseAllowLine(line: string): AllowEntry {
  const [marker, flag, ...rest] = line.split(/\s+/u)
  if (!MARKERS.includes(marker as Marker) || flag === undefined || rest.length > 0) {
    throw new Error(`bad allowlist line: ${JSON.stringify(line)}`)
  }
  return { marker: marker as Marker, flag }
}

/** Compare the two flag sets with the allowlist. Pure, so the failure cases are testable. */
function computeDrift(
  parser: ReadonlySet<string>,
  help: ReadonlySet<string>,
  allow: readonly AllowEntry[],
): Drift {
  const actual = new Set([
    ...[...parser].filter((f) => !help.has(f)).map((f) => `parser-only ${f}`),
    ...[...help].filter((f) => !parser.has(f)).map((f) => `help-only ${f}`),
  ])
  const listed = new Set(allow.map((e) => `${e.marker} ${e.flag}`))
  return {
    unlisted: [...actual].filter((x) => !listed.has(x)).sort(),
    stale: [...listed].filter((x) => !actual.has(x)).sort(),
  }
}

describe("help drift allowlist file", () => {
  const lines = allowLines(readFileSync(ALLOW_FILE, "utf8"))

  test("every line is `<marker> <flag>` with a long flag", () => {
    for (const line of lines) {
      const entry = parseAllowLine(line)
      expect(entry.flag.startsWith("--")).toBe(true)
    }
  })

  test("is sorted and has no duplicates", () => {
    expect(lines).toEqual([...new Set(lines)].sort())
  })
})

describe("help drift", () => {
  test("parser and help (registry plus root help text) differ only by the allowlist", () => {
    const allow = allowLines(readFileSync(ALLOW_FILE, "utf8")).map(parseAllowLine)
    const drift = computeDrift(parserFlags(), helpFlags(), allow)
    // `unlisted`: add a FlagSpec in src/cli/registry or a `*.command.ts` file,
    // or fix the help text (do not grow the list).
    // `stale`: the mismatch is fixed, so remove the entry from help-drift.allow.txt.
    expect(drift).toEqual({ unlisted: [], stale: [] })
  })

  test("root help text shows every visible global flag in the registry", () => {
    const text = helpTextFlags()
    // A missing flag means root help dropped a row (src/startup/help.ts).
    expect(visibleGlobalFlags().filter((flag) => !text.has(flag))).toEqual([])
  })

  test("the scan finds real flags on every side", () => {
    const parser = parserFlags()
    const registry = registryFlags()
    const text = helpTextFlags()
    // Guards against a scan that silently finds nothing (an empty set has no drift).
    for (const flag of ["--model", "--output-format", "--help", "--host-mode"]) {
      expect(parser.has(flag)).toBe(true)
      expect(registry.has(flag)).toBe(true)
      expect(text.has(flag)).toBe(true)
    }
    // A hidden command form (M-8d: only in command help, not root help text).
    expect(parser.has("--list-models")).toBe(true)
    expect(registry.has("--list-models")).toBe(true)
    expect(visibleGlobalFlags().length).toBeGreaterThan(0)
  })
})

describe("computeDrift", () => {
  const parser = new Set(["--a", "--b", "--c"])
  const help = new Set(["--a", "--b", "--z"])
  const allow: AllowEntry[] = [
    { marker: "help-only", flag: "--z" },
    { marker: "parser-only", flag: "--c" },
  ]

  test("no drift when the allowlist matches", () => {
    expect(computeDrift(parser, help, allow)).toEqual({ unlisted: [], stale: [] })
  })

  test("a new parser flag that help does not show is unlisted", () => {
    const drift = computeDrift(new Set([...parser, "--new"]), help, allow)
    expect(drift).toEqual({ unlisted: ["parser-only --new"], stale: [] })
  })

  test("a new help token that the parser does not read is unlisted", () => {
    const drift = computeDrift(parser, new Set([...help, "--ghost"]), allow)
    expect(drift).toEqual({ unlisted: ["help-only --ghost"], stale: [] })
  })

  test("a fixed mismatch that stays in the list is stale", () => {
    const drift = computeDrift(parser, new Set([...help, "--c"]), allow)
    expect(drift).toEqual({ unlisted: [], stale: ["parser-only --c"] })
  })

  test("a bad allowlist line throws", () => {
    expect(() => parseAllowLine("both --a")).toThrow("bad allowlist line")
    expect(() => parseAllowLine("parser-only")).toThrow("bad allowlist line")
    expect(() => parseAllowLine("parser-only --a extra")).toThrow("bad allowlist line")
  })
})
