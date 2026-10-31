import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  collectFlagOwnership,
  flagLiterals,
  installedCoreRoot,
  loadCoreManifest,
  type ManifestRow,
  sharedFlags,
} from "./flag-ownership.ts"

const REPO_ROOT = join(import.meta.dir, "..", "..")

describe("flagLiterals", () => {
  test("finds whole-flag string and template literals", () => {
    const source = [
      `const a = "--model"`,
      `const b = '--prompt'`,
      "const c = `--debug`",
      `const d = { flag: "--resume" as const }`,
      `export const e = ["--list-models", "--x2"]`,
    ].join("\n")
    expect([...flagLiterals(source)].sort()).toEqual([
      "--debug",
      "--list-models",
      "--model",
      "--prompt",
      "--resume",
      "--x2",
    ])
  })

  test("ignores comments, type-only literals, and text that only contains a flag", () => {
    const source = [
      `/** Use ["--in-doc"] here */`,
      `// "--in-line-comment"`,
      `function f(x: "--type-only"): void {}`,
      `const a = "--flag value"`,
      `const b = "x--y"`,
      `const c = "-m"`,
    ].join("\n")
    expect([...flagLiterals(source)]).toEqual([])
  })
})

describe("collectFlagOwnership (fixture packages)", () => {
  const root = mkdtempSync(join(tmpdir(), "flag-ownership-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const write = (rel: string, text: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  const coreRoot = join(root, "core")
  const cliRoot = join(root, "cli")
  write("core/src/config/config.ts", `export const KEYS = ["--both-config"]\n`)
  write("core/src/config/moving.ts", `export const F = "--moving-config"\n`)
  write("core/src/cli/keys.ts", `export const K = "--kept-in-config"\n`)
  write("core/src/cli/flags.ts", `export const F = ["--both-config", "--cli-only"]\n`)
  write("core/src/llm/other.ts", `export const O = "--engine-elsewhere"\n`)
  write("cli/src/main.ts", `export const M = ["--kept-in-config", "--own"]\n`)
  write("cli/src/main.test.ts", `export const T = "--moving-config"\n`)
  const rows: ManifestRow[] = [
    { path: "src/cli/flags.ts", dest: "cli", target: "minimal-agent-cli/src/cli/flags.ts" },
    { path: "src/cli/keys.ts", dest: "core-engine", target: "src/config/keys.ts" },
    { path: "src/config/moving.ts", dest: "cli", target: "minimal-agent-cli/src/moving.ts" },
  ]
  const ownership = collectFlagOwnership({ cliRoot, coreRoot, rows })

  test("classifies both sides by the manifest", () => {
    expect(ownership.coreConfigFiles).toEqual(["src/cli/keys.ts", "src/config/config.ts"])
    expect(ownership.cliFiles).toEqual([
      "cli:src/main.ts",
      "core:src/cli/flags.ts",
      "core:src/config/moving.ts",
    ])
  })

  test("reports each flag defined on both sides, with its files", () => {
    expect(sharedFlags(ownership)).toEqual([
      "--both-config: core config src/config/config.ts; CLI core:src/cli/flags.ts",
      "--kept-in-config: core config src/cli/keys.ts; CLI cli:src/main.ts",
    ])
  })
})

describe("flag ownership (installed core)", () => {
  const coreRoot = installedCoreRoot(REPO_ROOT)
  const rows = loadCoreManifest(coreRoot)

  test("installed core has a migration manifest while it still ships src/cli", () => {
    if (rows !== undefined) {
      expect(rows.length).toBeGreaterThan(0)
      return
    }
    // After the group move (S34) core may drop the manifest, but only once
    // it no longer ships CLI flag specs.
    expect(
      existsSync(join(coreRoot, "src", "cli")),
      "Installed core ships src/cli but has no migration manifest. Re-pin core.",
    ).toBe(false)
  })

  test("no flag name is defined both in core config and in the CLI flag specs", () => {
    const ownership = collectFlagOwnership({ cliRoot: REPO_ROOT, coreRoot, rows: rows ?? [] })
    expect(ownership.coreConfigFiles).toContain("src/config/config.ts")
    // The check is only meaningful if it sees the CLI flag specs.
    expect(ownership.cliFlags.has("--model")).toBe(true)
    expect(ownership.cliFlags.has("--prompt")).toBe(true)
    const shared = sharedFlags(ownership)
    expect(
      shared,
      shared.length > 0
        ? "Flags the engine reads stay in core config as data; CLI-only flags stay in\n" +
            "the CLI. These are defined on both sides:\n" +
            shared.join("\n")
        : "",
    ).toEqual([])
  })
})
