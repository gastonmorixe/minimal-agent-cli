/**
 * Import one plugin module by its absolute path (S35).
 *
 * This is the one CLI file that loads code by a computed path. It loads
 * plugin `ui` entry modules, never core: the core boundary check
 * (`src/architecture/core-boundary.ts`) exempts this file only from the
 * computed-loader rule, and this function refuses a core path.
 *
 * The checks use real paths (links resolved), never the path text. The
 * import uses the path text, the same as the core loader:
 *
 *   - The target must be inside the plugin's own root.
 *   - The target must not be under the real root of the installed
 *     `@minimal-agent/core` package.
 *   - The nearest `package.json` above the target must not name
 *     `@minimal-agent/core`. This refuses any core checkout, whatever
 *     its dir name.
 *
 * @module plugins-ui/plugin-module
 */

import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, sep } from "node:path"

/** The package name of core. */
const CORE_PACKAGE = "@minimal-agent/core"

/** True when `child` is `parent` or a path under it. Both are real paths. */
function isUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel))
}

/** The `name` field of `dir/package.json`, or undefined. */
function packageNameAt(dir: string): string | undefined {
  const file = join(dir, "package.json")
  if (!existsSync(file)) return undefined
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf-8"))
    if (typeof raw !== "object" || raw === null || !("name" in raw)) return undefined
    return typeof raw.name === "string" ? raw.name : undefined
  } catch {
    return undefined
  }
}

/** The name of the nearest `package.json` at or above `dir`, or undefined. */
function nearestPackageName(dir: string): string | undefined {
  let current = dir
  while (true) {
    if (existsSync(join(current, "package.json"))) return packageNameAt(current)
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

let coreRootCache: string | null | undefined

/**
 * True when this code runs from a `bun build --compile` binary. The same
 * narrow cast as core's `isStandaloneExecutable()` (not exported by core).
 */
function isStandaloneExecutable(): boolean {
  return (Bun as { isStandaloneExecutable?: boolean }).isStandaloneExecutable === true
}

/**
 * The real root dir of the installed core package, or null when it does not
 * resolve. A compiled binary has no installed core: its core is bundled in
 * `/$bunfs`, and a `Bun.resolveSync` there would fall back to the cwd and
 * could name a project's own `node_modules` core. So a binary returns null
 * (the same guard as core's `hostCoreRoot()`), and the package name check
 * still refuses any core checkout on disk.
 */
function realCoreRoot(): string | null {
  if (coreRootCache !== undefined) return coreRootCache
  coreRootCache = null
  if (isStandaloneExecutable()) return coreRootCache
  try {
    let dir = dirname(realpathSync(Bun.resolveSync(CORE_PACKAGE, import.meta.dir)))
    while (packageNameAt(dir) !== CORE_PACKAGE) {
      const parent = dirname(dir)
      if (parent === dir) return coreRootCache
      dir = parent
    }
    coreRootCache = dir
  } catch {
    // No installed core. The package name check still applies.
  }
  return coreRootCache
}

/** True when the real path `real` is core code. */
function isCorePath(real: string): boolean {
  const coreRoot = realCoreRoot()
  if (coreRoot !== null && isUnder(real, coreRoot)) return true
  return nearestPackageName(dirname(real)) === CORE_PACKAGE
}

/**
 * Import the plugin module at `abs`. `pluginRoot` is the plugin package
 * dir. The module must be inside it.
 *
 * @throws Error when `abs` is not absolute, is outside `pluginRoot`, or is core code
 */
export async function importPluginModule(abs: string, pluginRoot: string): Promise<unknown> {
  if (!isAbsolute(abs)) throw new Error(`plugin module path must be absolute: ${abs}`)
  const real = realpathSync(abs)
  if (isCorePath(real)) throw new Error(`plugin module path names core code: ${abs}`)
  if (!isUnder(real, realpathSync(pluginRoot))) {
    throw new Error(`plugin module path is outside the plugin root ${pluginRoot}: ${abs}`)
  }
  // Import the path text, not the real path. Core loads the headless
  // handlers by the path text. Bun keys its module cache by that text, so a
  // real path under a link (macOS /var -> /private/var) loads a second copy
  // of each shared module, such as the style slots.
  return import(abs)
}
