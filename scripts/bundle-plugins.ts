/**
 * Copy the plugin packages named in `plugins.bundle.json` into the CLI
 * embedded plugin dir (`<cli>/plugins`). An empty list does nothing and
 * creates nothing.
 *
 * @module scripts/bundle-plugins
 */

import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

export interface BundlePluginsOptions {
  /** Path of the JSON list file: `{"plugins": ["ma-foo-plugin"]}`. */
  listFile: string
  /** Directory that holds the plugin package dirs (minimal-agent-plugins). */
  pluginsRepo: string
  /** Destination dir (the embedded plugin root, `<cli>/plugins`). */
  destDir: string
}

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

/**
 * Copy each listed plugin dir into `destDir/<id>`.
 *
 * @returns The ids copied, in list order. Empty when the list is empty.
 */
export function bundlePlugins(opts: BundlePluginsOptions): string[] {
  const ids = readBundleList(opts.listFile)
  if (ids.length === 0) return []
  // Check every source before the first copy, so a bad entry leaves no partial output.
  for (const id of ids) {
    const src = join(opts.pluginsRepo, id)
    if (!existsSync(src) || !statSync(src).isDirectory()) {
      throw new Error(`bundle-plugins: ${src} is not a directory`)
    }
    if (!existsSync(join(src, "manifest.json")) && !existsSync(join(src, "provider.json"))) {
      throw new Error(`bundle-plugins: ${src} has no manifest.json or provider.json`)
    }
  }
  mkdirSync(opts.destDir, { recursive: true })
  for (const id of ids) {
    cpSync(join(opts.pluginsRepo, id), join(opts.destDir, id), { recursive: true })
  }
  return ids
}
