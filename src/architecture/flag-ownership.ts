/**
 * Flag ownership between core config and the CLI flag specs (spec S26).
 *
 * THE RULE: a flag the engine reads stays in core config as data, and a
 * CLI-only flag stays with the CLI. No flag name is defined in both.
 *
 * Both sides are classified by core's migration manifest
 * (`src/architecture/migration-manifest.json` in the installed
 * `@minimal-agent/core` package):
 *   - Core config: the installed core's non-test `src/config/` files that
 *     the manifest does not send to the CLI, plus files the manifest keeps
 *     in core with a `src/config/` target.
 *   - CLI flag specs: this repo's non-test `src/` files, plus the installed
 *     core files the manifest sends to the CLI. Today most CLI flag specs
 *     still live in core (`src/cli/`); after the group move (S34) they live
 *     here, and the same check holds.
 *
 * A flag definition is a string literal whose whole text is a long flag
 * (`"--model"`). Comments and type-only literals do not count:
 * `Bun.Transpiler` drops them before the scan.
 *
 * Core files are read through the installed package, never a sibling
 * checkout.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, posix } from "node:path"

/** One row of core's migration manifest (the fields this check reads). */
export interface ManifestRow {
  readonly path: string
  readonly dest: "core-engine" | "cli" | "delete"
  readonly target: string | null
}

/** Where each flag name is defined, per side. */
export interface FlagOwnership {
  /** Core config files, repo-relative to the core package. */
  readonly coreConfigFiles: readonly string[]
  /** CLI flag spec files: `cli:<path>` for this repo, `core:<path>` for installed core. */
  readonly cliFiles: readonly string[]
  /** Flag name to the core config files that define it. */
  readonly coreConfigFlags: ReadonlyMap<string, readonly string[]>
  /** Flag name to the CLI files that define it. */
  readonly cliFlags: ReadonlyMap<string, readonly string[]>
}

/** A string literal whose whole text is a long flag. */
const FLAG_LITERAL_RE = /(["'`])(--[a-z0-9][a-z0-9-]*)\1/gu

const transpiler = new Bun.Transpiler({ loader: "ts" })

/** The long flags that `source` defines as whole string literals. */
export function flagLiterals(source: string): Set<string> {
  const code = transpiler.transformSync(source)
  return new Set([...code.matchAll(FLAG_LITERAL_RE)].map((m) => m[2] ?? ""))
}

/** Root folder of the installed `@minimal-agent/core` package, as seen from `fromDir`. */
export function installedCoreRoot(fromDir: string): string {
  return dirname(Bun.resolveSync("@minimal-agent/core/package.json", fromDir))
}

function isManifestRow(value: unknown): value is ManifestRow {
  if (typeof value !== "object" || value === null) return false
  const row: { path?: unknown; dest?: unknown; target?: unknown } = value
  return (
    typeof row.path === "string" &&
    (row.dest === "core-engine" || row.dest === "cli" || row.dest === "delete") &&
    (typeof row.target === "string" || row.target === null)
  )
}

/** Core's migration manifest rows, or undefined when the installed core has none. */
export function loadCoreManifest(coreRoot: string): readonly ManifestRow[] | undefined {
  const path = join(coreRoot, "src", "architecture", "migration-manifest.json")
  if (!existsSync(path)) return undefined
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"))
  const rows: unknown =
    typeof manifest === "object" && manifest !== null && "rows" in manifest
      ? manifest.rows
      : undefined
  if (!Array.isArray(rows) || !rows.every(isManifestRow)) {
    throw new Error(`unexpected migration manifest shape: ${path}`)
  }
  return rows
}

/** The row that covers `file`: its own row, else the deepest folder row above it. */
export function rowFor(file: string, rows: readonly ManifestRow[]): ManifestRow | undefined {
  let folder: ManifestRow | undefined
  for (const row of rows) {
    if (row.path === file) return row
    if (row.path.endsWith("/") && file.startsWith(row.path)) {
      if (folder === undefined || row.path.length > folder.path.length) folder = row
    }
  }
  return folder
}

/** Non-test `.ts` files under `root/rel`, as `rel`-prefixed posix paths, sorted. */
export function sourceFiles(root: string, rel: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    const full = join(root, dir)
    if (!existsSync(full)) return
    for (const name of readdirSync(full)) {
      if (name === "node_modules" || name.startsWith(".")) continue
      const child = posix.join(dir, name)
      if (statSync(join(root, child)).isDirectory()) walk(child)
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(child)
    }
  }
  walk(rel)
  return out.sort()
}

function addFlags(
  into: Map<string, string[]>,
  root: string,
  file: string,
  label: string = file,
): void {
  for (const flag of flagLiterals(readFileSync(join(root, file), "utf8"))) {
    const files = into.get(flag) ?? []
    files.push(label)
    into.set(flag, files)
  }
}

/** Collect the flags defined in core config and in the CLI flag specs. */
export function collectFlagOwnership(opts: {
  readonly cliRoot: string
  readonly coreRoot: string
  readonly rows: readonly ManifestRow[]
}): FlagOwnership {
  const { cliRoot, coreRoot, rows } = opts
  const cliBound = (file: string): boolean => {
    const dest = rowFor(file, rows)?.dest
    return dest === "cli" || dest === "delete"
  }
  const keptInConfig = rows
    .filter((r) => r.dest === "core-engine" && r.target?.startsWith("src/config/") === true)
    .map((r) => r.path)
    .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts") && existsSync(join(coreRoot, p)))
  const coreConfigFiles = [
    ...new Set([
      ...sourceFiles(coreRoot, "src/config").filter((f) => !cliBound(f)),
      ...keptInConfig,
    ]),
  ].sort()
  const coreCliFiles = sourceFiles(coreRoot, "src").filter((f) => rowFor(f, rows)?.dest === "cli")
  const ownCliFiles = sourceFiles(cliRoot, "src")

  const coreConfigFlags = new Map<string, string[]>()
  for (const file of coreConfigFiles) addFlags(coreConfigFlags, coreRoot, file)
  const cliFlags = new Map<string, string[]>()
  for (const file of ownCliFiles) addFlags(cliFlags, cliRoot, file, `cli:${file}`)
  for (const file of coreCliFiles) addFlags(cliFlags, coreRoot, file, `core:${file}`)

  return {
    coreConfigFiles,
    cliFiles: [...ownCliFiles.map((f) => `cli:${f}`), ...coreCliFiles.map((f) => `core:${f}`)],
    coreConfigFlags,
    cliFlags,
  }
}

/** Flags defined on both sides, as readable lines. Empty when ownership is clean. */
export function sharedFlags(ownership: FlagOwnership): string[] {
  const out: string[] = []
  for (const [flag, coreFiles] of [...ownership.coreConfigFlags].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const cliFiles = ownership.cliFlags.get(flag)
    if (cliFiles === undefined) continue
    out.push(`${flag}: core config ${coreFiles.join(", ")}; CLI ${cliFiles.join(", ")}`)
  }
  return out
}
