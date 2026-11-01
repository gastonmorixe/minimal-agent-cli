/**
 * Import one plugin module by its absolute path (S35).
 *
 * This is the one CLI file that loads code by a computed path. It loads
 * plugin `ui` entry modules, never core: the core boundary check
 * (`src/architecture/core-boundary.ts`) exempts this file only from the
 * computed-loader rule, and this function refuses a core path.
 *
 * @module plugins-ui/plugin-module
 */

import { isAbsolute } from "node:path"

/** True when `path` names core source or the core package. */
function isCorePath(path: string): boolean {
  const p = path.replaceAll("\\", "/")
  return (
    /(?:^|\/)minimal-agent-core\/src(?:\/|$)/u.test(p) ||
    /(?:^|\/)@minimal-agent\/core(?:\/|$)/u.test(p)
  )
}

/**
 * Import the plugin module at `abs`.
 *
 * @throws Error when `abs` is not absolute or names core code
 */
export async function importPluginModule(abs: string): Promise<unknown> {
  if (!isAbsolute(abs)) throw new Error(`plugin module path must be absolute: ${abs}`)
  if (isCorePath(abs)) throw new Error(`plugin module path names core code: ${abs}`)
  return import(abs)
}
