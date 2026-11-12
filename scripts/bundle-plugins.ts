/**
 * Build the embedded plugin bundle: copy the plugin packages named in
 * `plugins.bundle.json` into `<cli>/plugins`, transpile every `.ts` file to
 * `.js` (one file at a time, `Bun.Transpiler`), and rewrite `.ts` specifiers
 * and manifest paths in the COPY. The plugin source dir is never changed.
 * An empty list does nothing and creates nothing.
 *
 * A plugin must declare `"embeddable": true` in its manifest.json or
 * provider.json. Files of the embedded dir live in the read-only Bun virtual
 * fs of the binary: no exec, no writes, no `.ts` loading. Design and probes:
 * the s0.4c spike. Transpiler docs: https://bun.com/docs/api/transpiler
 *
 * @module scripts/bundle-plugins
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

export interface BundlePluginsOptions {
  /** Path of the JSON list file: `{"plugins": ["ma-foo-plugin"]}`. */
  listFile: string
  /** Directory that holds the plugin package dirs (minimal-agent-plugins). */
  pluginsRepo: string
  /** Destination dir (the embedded plugin root, `<cli>/plugins`). */
  destDir: string
}

/** One finding of {@link findUnsafePatterns}. */
export interface PatternHit {
  /** 1-based line number. */
  line: number
  /** Short name of the check that matched. */
  check: "new-url-import-meta" | "create-require-import-meta" | "non-literal-ts-string"
}

const MANIFEST_FILES = ["manifest.json", "provider.json"]
const SKIP_DIRS = new Set(["node_modules", "scripts"])

/** Read and check the plugin id list. Throws on a bad shape or a bad id. */
export function readBundleList(listFile: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(listFile, "utf8"))
  const list = (parsed as { plugins?: unknown } | null)?.plugins
  if (!Array.isArray(list)) throw new Error(`${listFile}: "plugins" must be an array`)
  for (const id of list) {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes("..")) {
      throw new Error(`${listFile}: bad plugin id ${JSON.stringify(id)} (use a plain dir name)`)
    }
  }
  return list as string[]
}

function lineOf(text: string, index: number): number {
  let n = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/**
 * Find code that breaks when the file moves into the embedded dir:
 * `new URL(..., import.meta.url)`, `createRequire(import.meta.url)`, and a
 * string literal ending `.ts` that is not an import specifier.
 */
export function findUnsafePatterns(source: string): PatternHit[] {
  const hits: PatternHit[] = []
  for (const m of source.matchAll(/new\s+URL\s*\([^)]*import\.meta\.url/g)) {
    hits.push({ line: lineOf(source, m.index), check: "new-url-import-meta" })
  }
  for (const m of source.matchAll(/createRequire\s*\(\s*import\.meta\.url/g)) {
    hits.push({ line: lineOf(source, m.index), check: "create-require-import-meta" })
  }
  const lines = source.split("\n")
  lines.forEach((text, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return
    if (!/["'`][^"'`\n]*\.ts["'`]/.test(text)) return
    // Import position: the transpile step rewrites these.
    if (/\b(from|import|require)\b\s*\(?\s*["']/.test(text)) return
    hits.push({ line: i + 1, check: "non-literal-ts-string" })
  })
  return hits.sort((a, b) => a.line - b.line)
}

/** List files under `dir` (relative paths) minus the dirs and files we never embed. */
function listFiles(dir: string, rel = ""): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...listFiles(dir, r))
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue
      out.push(r)
    }
  }
  return out
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"))
}

/** True when any object in the JSON tree has `type: "subprocess"`. */
function hasSubprocessHandler(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasSubprocessHandler)
  if (node === null || typeof node !== "object") return false
  const rec = node as Record<string, unknown>
  if (rec.type === "subprocess") return true
  return Object.values(rec).some(hasSubprocessHandler)
}

/** Rewrite `path` and `entry` string values that end `.ts` to `.js`. */
function rewriteManifestPaths(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) rewriteManifestPaths(item)
    return
  }
  if (node === null || typeof node !== "object") return
  const rec = node as Record<string, unknown>
  for (const [key, value] of Object.entries(rec)) {
    if ((key === "path" || key === "entry") && typeof value === "string" && value.endsWith(".ts")) {
      rec[key] = `${value.slice(0, -3)}.js`
    } else {
      rewriteManifestPaths(value)
    }
  }
}

/** Check one plugin source. Throws a clear error that names the id. */
function validatePlugin(id: string, src: string): void {
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error(`bundle-plugins: ${src} is not a directory`)
  }
  const present = MANIFEST_FILES.filter((f) => existsSync(join(src, f)))
  if (present.length === 0) {
    throw new Error(`bundle-plugins: ${src} has no manifest.json or provider.json`)
  }
  const manifests = present.map((f) => readJson(join(src, f)) as Record<string, unknown>)
  if (!manifests.some((m) => m?.embeddable === true)) {
    throw new Error(
      `bundle-plugins: plugin "${id}" is not embeddable (set "embeddable": true in its manifest.json or provider.json)`,
    )
  }
  if (manifests.some(hasSubprocessHandler)) {
    throw new Error(
      `bundle-plugins: plugin "${id}" declares a subprocess handler. Files in the embedded dir cannot be exec'd`,
    )
  }
  if (manifests.some((m) => m?.embeddableChecked === true)) return
  for (const rel of listFiles(src)) {
    if (!rel.endsWith(".ts")) continue
    const hits = findUnsafePatterns(readFileSync(join(src, rel), "utf8"))
    const first = hits[0]
    if (first) {
      throw new Error(
        `bundle-plugins: plugin "${id}" ${rel}:${first.line} matches check ${first.check}. ` +
          `Fix it, or set "embeddableChecked": true in the manifest after a human probe`,
      )
    }
  }
}

/** Transpile `.ts` source and rewrite relative `.ts` specifiers to `.js`. */
function transpileFile(transpiler: Bun.Transpiler, source: string): string {
  let out = transpiler.transformSync(source)
  for (const imp of transpiler.scanImports(source)) {
    const p = imp.path
    if (!p.startsWith(".") || !p.endsWith(".ts")) continue
    const js = `${p.slice(0, -3)}.js`
    out = out.split(`"${p}"`).join(`"${js}"`).split(`'${p}'`).join(`'${js}'`)
  }
  return out
}

function copyPlugin(id: string, src: string, dest: string, transpiler: Bun.Transpiler): void {
  rmSync(dest, { recursive: true, force: true })
  for (const rel of listFiles(src)) {
    const from = join(src, rel)
    if (rel.endsWith(".ts")) {
      const to = join(dest, `${rel.slice(0, -3)}.js`)
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, transpileFile(transpiler, readFileSync(from, "utf8")))
      continue
    }
    const to = join(dest, rel)
    mkdirSync(dirname(to), { recursive: true })
    if (!MANIFEST_FILES.includes(rel)) {
      writeFileSync(to, readFileSync(from))
      continue
    }
    const json = readJson(from)
    rewriteManifestPaths(json)
    writeFileSync(to, `${JSON.stringify(json, null, 2)}\n`)
  }
  if (!existsSync(dest)) throw new Error(`bundle-plugins: plugin "${id}" produced no files`)
}

/**
 * Bundle each listed plugin into `destDir/<id>`.
 *
 * @returns The ids bundled, in list order. Empty when the list is empty.
 */
export function bundlePlugins(opts: BundlePluginsOptions): string[] {
  const ids = readBundleList(opts.listFile)
  if (ids.length === 0) return []
  // Check every plugin before the first copy, so a bad entry leaves no partial output.
  for (const id of ids) validatePlugin(id, join(opts.pluginsRepo, id))
  mkdirSync(opts.destDir, { recursive: true })
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" })
  for (const id of ids) {
    copyPlugin(id, join(opts.pluginsRepo, id), join(opts.destDir, id), transpiler)
  }
  return ids
}
