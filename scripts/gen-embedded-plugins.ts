#!/usr/bin/env bun
/**
 * Generate the embedded plugin table of a compiled binary.
 *
 *   bun run scripts/gen-embedded-plugins.ts [PLUGINS_DIR] [--out FILE] [--build-id ID]
 *
 * `scripts/compile.ts` calls {@link writeEmbeddedPluginsModule} before
 * `Bun.build`. A source run never sees the output: `src/index.ts` imports
 * `#embedded-plugins`, which `package.json#imports` maps to a committed
 * empty stub, and only the compile resolver points it at the generated file.
 *
 * The plugins dir is `MA_PLUGINS_DIR` or `../minimal-agent-plugins`. Every
 * subdir with a `manifest.json` or a `provider.json` is a package, and all
 * of them are embedded: `enabled: false` and platform gates stay runtime
 * decisions of the core loader.
 *
 * Per package (contract: core `src/plugins/source.ts`, `EmbeddedPluginTable`):
 *
 *   - texts: `manifest.json`, `provider.json`, `PROMPT.md` (when present),
 *     `manifest.prompt` (when set and present), and every file under
 *     `prompts/` (the templates `ctx.prompts.render` reads). Imported
 *     `with { type: "text" }`.
 *   - modules: every module the core loader or the CLI ui loader imports:
 *     each `{ type: "module", path }` entry anywhere in the manifest
 *     (tools, events, hooks, commands, fragments, host modes, setups,
 *     replay renderers, turn attachments, `ui.setup`, `ui.liveAreaSlots`,
 *     `cli.commands` handlers), `promptTemplate.entry`, `systemPromptBase.entry`,
 *     `errorRenderers[].entry`, `syntheticText[].entry`, `toolText[].entry`,
 *     `sidebandCodec.entry`, `toolResultTransforms.entry`, every `scripts`
 *     value, and `provider.json` `entry`. Literal `() => import("<abs path>")` thunks.
 *   - files: every relative subprocess `command[0]` that is not a `.ts`/`.js`
 *     module (today `ma-env-info-plugin/gather.sh`). Imported
 *     `with { type: "file" }`, so core can extract it before exec. A file is
 *     never imported both as text and as file (the file import would turn
 *     into text, W2 probe 4).
 *
 * Keys are `normalizePackagePath(rel)` of the path as written, the same
 * function core uses to look them up. Output is deterministic: sorted
 * packages and keys, no timestamps. Paths in import literals are absolute.
 *
 * @module scripts/gen-embedded-plugins
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { normalizePackagePath } from "@minimal-agent/core/host-kit/embedded-plugins"

/** One package of the table, as collected from disk. Keys are normalized. */
export interface CollectedPackage {
  /** The package dir name, e.g. `ma-fetch-plugin`. */
  readonly name: string
  /** Absolute package dir. */
  readonly dir: string
  /** Text asset key to absolute path. */
  readonly texts: ReadonlyMap<string, string>
  /** Module key to absolute path. */
  readonly modules: ReadonlyMap<string, string>
  /** Run file key to absolute path. */
  readonly files: ReadonlyMap<string, string>
}

/** A generator failure: a bad path or a missing module in a manifest. */
export class EmbedGenError extends Error {}

/** Module file extensions. A subprocess command with one is not a run file. */
const MODULE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    throw new EmbedGenError(`cannot parse ${path}: ${(e as Error).message}`)
  }
}

/** Collected references of one manifest/provider JSON. Values are paths as written. */
interface Refs {
  modules: string[]
  files: string[]
  prompt?: string
}

/**
 * Walk a manifest and collect every module path and run file. Generic over
 * the manifest shape: any `{ type: "module", path }` object is a module
 * entry and any `{ type: "subprocess", command: [exe, ...] }` names a run
 * file, wherever it sits. The few non-handler entry fields are listed.
 */
export function manifestRefs(manifest: unknown): Refs {
  const refs: Refs = { modules: [], files: [] }
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (!isObject(node)) return
    if (node.type === "module" && typeof node.path === "string") refs.modules.push(node.path)
    if (node.type === "subprocess" && Array.isArray(node.command)) {
      const exe = node.command[0]
      if (typeof exe === "string" && normalizePackagePath(exe) !== null) {
        if (MODULE_EXT_RE.test(exe)) refs.modules.push(exe)
        else refs.files.push(exe)
      }
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(manifest)
  if (!isObject(manifest)) return refs
  const entryOf = (v: unknown): void => {
    if (isObject(v) && typeof v.entry === "string") refs.modules.push(v.entry)
  }
  entryOf(manifest.promptTemplate)
  entryOf(manifest.systemPromptBase)
  entryOf(manifest.sidebandCodec)
  entryOf(manifest.toolResultTransforms)
  if (Array.isArray(manifest.errorRenderers)) manifest.errorRenderers.forEach(entryOf)
  if (Array.isArray(manifest.syntheticText)) manifest.syntheticText.forEach(entryOf)
  if (Array.isArray(manifest.toolText)) manifest.toolText.forEach(entryOf)
  if (isObject(manifest.scripts)) {
    for (const v of Object.values(manifest.scripts)) if (typeof v === "string") refs.modules.push(v)
  }
  if (typeof manifest.prompt === "string") refs.prompt = manifest.prompt
  return refs
}

/** Normalize `rel` or throw with the package and the field. */
function keyOf(pkg: string, rel: string, what: string): string {
  const key = normalizePackagePath(rel)
  if (key === null) {
    throw new EmbedGenError(`${pkg}: ${what} path ${JSON.stringify(rel)} is not inside the package`)
  }
  return key
}

/** True when `path` is a regular file. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Keys (`prompts/a.md`, `prompts/sub/b.md`) of every regular file under the
 * `prompts/` dir of a package, sorted. Dot files are skipped. Empty when the
 * package has no `prompts/` dir.
 */
export function promptAssetKeys(dir: string): string[] {
  const keys: string[] = []
  const walk = (rel: string): void => {
    const abs = join(dir, rel)
    let names: string[]
    try {
      if (!statSync(abs).isDirectory()) return
      names = readdirSync(abs).sort()
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith(".")) continue
      const child = `${rel}/${name}`
      if (isFile(join(dir, child))) keys.push(child)
      else walk(child)
    }
  }
  walk("prompts")
  return keys.sort()
}

/** Collect one package dir. Returns undefined when it has no manifest or provider. */
export function collectPackage(dir: string): CollectedPackage | undefined {
  const name =
    dir
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? dir
  const manifestPath = join(dir, "manifest.json")
  const providerPath = join(dir, "provider.json")
  const hasManifest = isFile(manifestPath)
  const hasProvider = isFile(providerPath)
  if (!hasManifest && !hasProvider) return undefined
  const texts = new Map<string, string>()
  const modules = new Map<string, string>()
  const files = new Map<string, string>()
  const addModule = (rel: string, what: string): void => {
    const key = keyOf(name, rel, what)
    const abs = join(dir, key)
    if (!isFile(abs)) throw new EmbedGenError(`${name}: ${what} module ${rel} does not exist`)
    modules.set(key, abs)
  }
  if (hasManifest) {
    texts.set("manifest.json", manifestPath)
    const refs = manifestRefs(readJson(manifestPath))
    for (const rel of refs.modules) addModule(rel, "manifest")
    for (const rel of refs.files) {
      const key = keyOf(name, rel, "subprocess command")
      const abs = join(dir, key)
      if (!isFile(abs)) throw new EmbedGenError(`${name}: subprocess command ${rel} does not exist`)
      files.set(key, abs)
    }
    const promptRel = refs.prompt ?? "./PROMPT.md"
    const promptKey = keyOf(name, promptRel, "prompt")
    // A missing prompt is the loader's diagnostic, not a build failure.
    if (isFile(join(dir, promptKey))) texts.set(promptKey, join(dir, promptKey))
    // Prompt templates: `ctx.prompts.render(name)` reads `prompts/<name>`
    // through the package reader, so every file under `prompts/` is a text.
    for (const key of promptAssetKeys(dir)) texts.set(key, join(dir, key))
  }
  if (hasProvider) {
    texts.set("provider.json", providerPath)
    const provider = readJson(providerPath)
    if (isObject(provider) && typeof provider.entry === "string") {
      addModule(provider.entry, "provider.json entry")
    }
  }
  // One import style per file: a run file is never also a text.
  for (const key of files.keys()) texts.delete(key)
  return { name, dir, texts, modules, files }
}

/** Every package under `pluginsDir`, sorted by dir name. */
export function collectPackages(pluginsDir: string): CollectedPackage[] {
  if (!existsSync(pluginsDir) || !statSync(pluginsDir).isDirectory()) {
    throw new EmbedGenError(`plugins dir not found: ${pluginsDir}`)
  }
  const out: CollectedPackage[] = []
  for (const entry of readdirSync(pluginsDir).sort()) {
    if (entry.startsWith(".") || entry === "node_modules") continue
    const dir = join(pluginsDir, entry)
    if (!statSync(dir).isDirectory()) continue
    const pkg = collectPackage(dir)
    if (pkg !== undefined) out.push(pkg)
  }
  return out
}

/** Sorted entries of a map. */
function sorted(map: ReadonlyMap<string, string>): [string, string][] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** The build id must match core's `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. */
const BUILD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Render the TypeScript module text of the table. Pure: same packages and
 * build id give the same bytes.
 */
export function renderEmbeddedPluginsModule(
  packages: readonly CollectedPackage[],
  buildId: string,
): string {
  if (!BUILD_ID_RE.test(buildId))
    throw new EmbedGenError(`invalid build id ${JSON.stringify(buildId)}`)
  const lit = (s: string): string => JSON.stringify(s)
  const imports: string[] = []
  const body: string[] = []
  let t = 0
  let f = 0
  const ordered = [...packages].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const pkg of ordered) {
    const texts: string[] = []
    for (const [key, abs] of sorted(pkg.texts)) {
      const id = `t${t++}`
      imports.push(`import ${id} from ${lit(abs)} with { type: "text" }`)
      texts.push(`        ${lit(key)}: ${id},`)
    }
    const files: string[] = []
    for (const [key, abs] of sorted(pkg.files)) {
      const id = `f${f++}`
      imports.push(`import ${id} from ${lit(abs)} with { type: "file" }`)
      files.push(`        ${lit(key)}: ${id},`)
    }
    const modules = sorted(pkg.modules).map(
      ([key, abs]) => `        ${lit(key)}: () => import(${lit(abs)}),`,
    )
    const block = (label: string, rows: string[]): string =>
      rows.length === 0 ? `      ${label}: {},` : `      ${label}: {\n${rows.join("\n")}\n      },`
    body.push(
      `    ${lit(pkg.name)}: {\n${block("texts", texts)}\n${block("modules", modules)}\n${block("files", files)}\n    },`,
    )
  }
  return [
    "// GENERATED by scripts/gen-embedded-plugins.ts. Do not edit, do not commit.",
    "// biome-ignore-all lint: generated",
    "/* eslint-disable */",
    'import type { EmbeddedPluginTable } from "@minimal-agent/core/host-kit/embedded-plugins"',
    ...imports,
    "",
    "export const TABLE: EmbeddedPluginTable = {",
    `  buildId: ${lit(buildId)},`,
    "  packages: {",
    ...body,
    "  },",
    "}",
    "",
  ].join("\n")
}

/** Summary of one generated table. */
export interface GeneratedTable {
  readonly outFile: string
  readonly packages: number
  readonly modules: number
  readonly texts: number
  readonly files: number
  readonly scripts: readonly string[]
}

/** The script ids (`<manifest id>/<name>`) the table carries, sorted. */
export function scriptIds(packages: readonly CollectedPackage[]): string[] {
  const ids: string[] = []
  for (const pkg of packages) {
    const path = pkg.texts.get("manifest.json")
    if (path === undefined) continue
    const m = readJson(path)
    if (!isObject(m) || typeof m.id !== "string" || !isObject(m.scripts)) continue
    for (const name of Object.keys(m.scripts)) ids.push(`${m.id}/${name}`)
  }
  return ids.sort()
}

/** Collect `pluginsDir`, render, and write `outFile` (parent dirs created). */
export function writeEmbeddedPluginsModule(
  pluginsDir: string,
  outFile: string,
  buildId: string,
): GeneratedTable {
  const packages = collectPackages(resolve(pluginsDir))
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, renderEmbeddedPluginsModule(packages, buildId))
  const count = (pick: (p: CollectedPackage) => ReadonlyMap<string, string>): number =>
    packages.reduce((n, p) => n + pick(p).size, 0)
  return {
    outFile,
    packages: packages.length,
    modules: count((p) => p.modules),
    texts: count((p) => p.texts),
    files: count((p) => p.files),
    scripts: scriptIds(packages),
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  let dir: string | undefined
  let out = resolve(import.meta.dir, "..", "tmp", "embedded-plugins.gen.ts")
  let buildId = "local"
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--out") out = resolve(argv[++i] ?? out)
    else if (a === "--build-id") buildId = argv[++i] ?? buildId
    else dir = a
  }
  const pluginsDir =
    dir ??
    process.env.MA_PLUGINS_DIR ??
    resolve(import.meta.dir, "..", "..", "minimal-agent-plugins")
  const r = writeEmbeddedPluginsModule(pluginsDir, out, buildId)
  console.log(
    `gen-embedded-plugins: ${r.packages} packages, ${r.modules} modules, ${r.texts} texts, ${r.files} files -> ${r.outFile}`,
  )
}
