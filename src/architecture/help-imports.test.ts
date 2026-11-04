/**
 * Help loads no runtime code (SPEC-HELP R-18, plan M-9c).
 *
 * Help resolves and renders from the built-in registry and the plugin
 * catalog (`src/cli/registry/plugins.ts`, M-10). This test walks the
 * transitive runtime imports of the resolve path (`src/cli/registry/**`,
 * `src/commands/*.command.ts`) and the render path (`src/startup/help.ts`,
 * `src/ui/help/**`) and asserts that none of them is:
 *
 * - a command handler module (`src/commands/*.ts` that is not
 *   `*.command.ts`), or
 * - a core host module (`@minimal-agent/core/host*`, or a file under the
 *   core package's `src/host-public/`), except the modules in
 *   {@link ALLOWED_HOST_MODULES}.
 *
 * `Bun.Transpiler.scanImports` lists the runtime imports only: an
 * `import type` is removed by the transpiler, so it does not load code and
 * does not count. It drops a non-literal `import(x)` or `require(x)`
 * without a trace, so the test also fails on any such call in the closure.
 *
 * @module architecture/help-imports.test
 */

import { describe, expect, test } from "bun:test"
import { basename, dirname, join, relative, sep } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const COMMANDS_DIR = join(REPO_ROOT, "src", "commands")
const SCANNED = /\.(?:[cm]?[jt]sx?)$/u

/** Root globs: the resolve path and the render path, no tests. */
const ROOT_PATTERNS = [
  "src/cli/registry/**/*.ts",
  "src/commands/*.command.ts",
  "src/startup/help.ts",
  "src/ui/help/**/*.ts",
] as const

/**
 * Core host modules help may import. Each one must be a leaf with no side
 * effects beyond constants.
 *
 * - `@minimal-agent/core/host/build-info`: src/ui/help/model.ts reads
 *   `AGENT_VERSION` for the program row. The module re-exports core
 *   `src/utils/build-info.ts`, which imports only `package.json` (a static
 *   JSON import) and defines one function and one constant. No env, no fs,
 *   no network, no other host code.
 * - `@minimal-agent/core/host/plugin-catalog`: src/cli/registry/plugins.ts
 *   reads the plugin catalog for HOST MODES and PLUGIN NOTES (SPEC-HELP
 *   R-22, plan M-10). The catalog reads `manifest.json` files as JSON and
 *   never imports a plugin module. The test below also checks that the
 *   closure holds no plugin package file.
 */
const ALLOWED_HOST_MODULES: ReadonlyMap<string, RegExp> = new Map([
  ["@minimal-agent/core/host/build-info", /\/src\/host-public\/build-info\.ts$/u],
  ["@minimal-agent/core/host/plugin-catalog", /\/src\/host-public\/plugin-catalog\.ts$/u],
])

/**
 * A file of a plugin package (`ma-*-plugin/`) or the plugin loader. Help
 * must not load one. The catalog uses three loader leaf files: `roots.ts`
 * (root tiers), `helpers.ts` (`discoverPackageDirs`), and `PROMPTS.ts`
 * (string helpers that `helpers.ts` imports). None of them imports a plugin.
 */
const PLUGIN_CODE =
  /\/ma-[a-z0-9-]+-plugin\/|\/src\/plugins\/loader\/(?!helpers\.ts$|roots\.ts$|PROMPTS\.ts$)/u

/** Root files: every file that matches {@link ROOT_PATTERNS}, no tests. */
function rootFiles(): string[] {
  const out = new Set<string>()
  for (const pattern of ROOT_PATTERNS) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: REPO_ROOT, absolute: true })) {
      if (!file.endsWith(".test.ts")) out.add(file)
    }
  }
  return [...out].sort()
}

/** A dynamic `import(` or `require(` whose argument is not a string literal. */
const NON_LITERAL_LOAD = /\b(?:import|require)\(\s*[^"'`\s)]/u

/**
 * Non-literal loads that are in the closure but that help never calls, as
 * `<path suffix>: <transpiled line>`. The list must only shrink.
 *
 * - core `src/plugins/loader/helpers.ts`: `resolveHandler` imports a plugin
 *   handler by path. The catalog imports this file only for
 *   `discoverPackageDirs` (a directory scan) and never calls
 *   `resolveHandler`. Follow-up: move `discoverPackageDirs` to a leaf module
 *   in core, then drop this entry.
 */
const ALLOWED_DYNAMIC: readonly string[] = [
  "/src/plugins/loader/helpers.ts: mod = await import(abs);",
]

/** True when `load` (`<relative path>: <line>`) is in {@link ALLOWED_DYNAMIC}. */
function allowedDynamic(load: string): boolean {
  const norm = `/${load.split(sep).join("/")}`
  return ALLOWED_DYNAMIC.some((suffix) => norm.endsWith(suffix))
}

/**
 * The non-literal `import(x)` / `require(x)` calls in `source`. The source
 * is transpiled first, so comments and types do not count.
 */
function nonLiteralLoads(transpiler: Bun.Transpiler, source: string): string[] {
  return transpiler
    .transformSync(source)
    .split("\n")
    .filter((line) => NON_LITERAL_LOAD.test(line))
    .map((line) => line.trim())
}

/** Why `specifier` (resolved to `resolved`) is not allowed, or `undefined`. */
function forbiddenReason(specifier: string, resolved: string): string | undefined {
  const norm = resolved.split(sep).join("/")
  const allowedFile = ALLOWED_HOST_MODULES.get(specifier)
  if (allowedFile?.test(norm) === true) return undefined
  if (/^@minimal-agent\/core\/host(?:[-/]|$)/u.test(specifier)) {
    return `core host module ${specifier}`
  }
  if (
    /\/@minimal-agent\/core\/src\/host-public\//u.test(norm) ||
    /\/minimal-agent-core\/src\/host-public\//u.test(norm)
  ) {
    return `core host module file ${norm}`
  }
  if (dirname(resolved) === COMMANDS_DIR && !basename(resolved).endsWith(".command.ts")) {
    return `command handler module ${relative(REPO_ROOT, resolved)}`
  }
  return undefined
}

interface Edge {
  readonly from: string
  readonly specifier: string
  readonly resolved: string
}

/**
 * The runtime import closure of `roots`: every visited file, every edge, and
 * every non-literal dynamic load (as `file: line`).
 */
async function importClosure(
  roots: readonly string[],
): Promise<{ files: string[]; edges: Edge[]; dynamic: string[] }> {
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  const seen = new Set<string>()
  const edges: Edge[] = []
  const dynamic: string[] = []
  const queue = [...roots]
  while (queue.length > 0) {
    const file = queue.pop() ?? ""
    if (seen.has(file)) continue
    seen.add(file)
    const source = await Bun.file(file).text()
    if (!file.endsWith(".json")) {
      for (const line of nonLiteralLoads(transpiler, source)) {
        dynamic.push(`${relative(REPO_ROOT, file)}: ${line}`)
      }
    }
    for (const imp of transpiler.scanImports(source)) {
      if (imp.path.startsWith("node:") || imp.path.startsWith("bun:")) continue
      const resolved = Bun.resolveSync(imp.path, dirname(file))
      edges.push({ from: file, specifier: imp.path, resolved })
      if (SCANNED.test(resolved)) queue.push(resolved)
    }
  }
  return { files: [...seen].sort(), edges, dynamic }
}

describe("help imports no runtime code", () => {
  test("the closure of the resolve and render paths holds no handler or host module", async () => {
    const roots = rootFiles()
    expect(roots.length).toBeGreaterThan(20)
    const { files, edges, dynamic } = await importClosure(roots)
    // Sanity: the walk sees the resolver, the command specs, and the renderer.
    const rel = files.map((f) => relative(REPO_ROOT, f).split(sep).join("/"))
    expect(rel).toContain("src/cli/registry/resolve.ts")
    expect(rel).toContain("src/commands/sessions.command.ts")
    expect(rel).toContain("src/startup/help.ts")
    expect(rel).toContain("src/ui/help/model.ts")
    expect(rel).toContain("src/cli/registry/plugins.ts")
    // The catalog reads manifests as JSON: no plugin package file and no
    // loader module other than the root and dir helpers is in the closure.
    const pluginCode = files.filter((f) => PLUGIN_CODE.test(f.split(sep).join("/")))
    expect(pluginCode).toEqual([])
    const bad = edges
      .map((e) => ({ e, why: forbiddenReason(e.specifier, e.resolved) }))
      .filter((x) => x.why !== undefined)
      .map((x) => `${relative(REPO_ROOT, x.e.from)} imports ${x.e.specifier}: ${x.why}`)
    expect(bad).toEqual([])
    // scanImports cannot follow a non-literal load, so none is allowed.
    expect(dynamic.filter((d) => !allowedDynamic(d))).toEqual([])
  })

  test("the non-literal load check flags import(x) and require(x) only", () => {
    const t = new Bun.Transpiler({ loader: "ts" })
    expect(nonLiteralLoads(t, "const m = await import(name)")).toHaveLength(1)
    expect(nonLiteralLoads(t, "const m = require(name)")).toHaveLength(1)
    expect(nonLiteralLoads(t, 'const m = await import("./x.ts")')).toEqual([])
    expect(nonLiteralLoads(t, "const m = await import(`./x.ts`)")).toEqual([])
    expect(nonLiteralLoads(t, "// import(name)\nexport const a = 1")).toEqual([])
    expect(
      allowedDynamic("node_modules/x/src/plugins/loader/helpers.ts: mod = await import(abs);"),
    ).toBe(true)
    expect(allowedDynamic("src/ui/help/model.ts: mod = await import(abs);")).toBe(false)
  })

  test("the allow list passes only its own file", () => {
    expect(
      forbiddenReason(
        "@minimal-agent/core/host/build-info",
        "/r/node_modules/@minimal-agent/core/src/host-public/build-info.ts",
      ),
    ).toBeUndefined()
    expect(
      forbiddenReason("@minimal-agent/core/host/build-info", "/r/elsewhere/build-info.ts"),
    ).toContain("core host module")
    expect(
      forbiddenReason(
        "@minimal-agent/core/host/plugin-catalog",
        "/r/node_modules/@minimal-agent/core/src/host-public/plugin-catalog.ts",
      ),
    ).toBeUndefined()
    expect(PLUGIN_CODE.test("/r/plugins/ma-acp-plugin/host-mode.ts")).toBe(true)
    expect(PLUGIN_CODE.test("/r/core/src/plugins/loader/host-modes.ts")).toBe(true)
    expect(PLUGIN_CODE.test("/r/core/src/plugins/loader/helpers.ts")).toBe(false)
    expect(
      forbiddenReason(
        "@minimal-agent/core/host/auth-store",
        "/r/node_modules/@minimal-agent/core/src/host-public/auth-store.ts",
      ),
    ).toContain("core host module")
  })

  test("the rule flags a handler module and a core host module", () => {
    expect(forbiddenReason("./sessions.ts", join(COMMANDS_DIR, "sessions.ts"))).toContain(
      "command handler module",
    )
    expect(
      forbiddenReason("./sessions.command.ts", join(COMMANDS_DIR, "sessions.command.ts")),
    ).toBeUndefined()
    expect(forbiddenReason("@minimal-agent/core/host/config", "/x/config.ts")).toContain(
      "core host module",
    )
    expect(
      forbiddenReason("./auth.ts", "/r/node_modules/@minimal-agent/core/src/host-public/auth.ts"),
    ).toContain("core host module file")
    expect(
      forbiddenReason(
        "@minimal-agent/core/plugin-api/utils/usage-report",
        "/r/node_modules/@minimal-agent/core/plugin-api/src/utils/usage-report.ts",
      ),
    ).toBeUndefined()
  })
})
