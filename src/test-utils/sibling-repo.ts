// Wave G test support: several integration tests exercise plugins that have
// been physically moved to the sibling `../minimal-agent-plugins/` repo. On a
// bare host checkout (CI, a fresh clone, contributors who have not cloned the
// sibling), that repo is absent and those tests cannot run. They must SKIP
// cleanly rather than fail, so the host repo stays green on its own.
//
// Use with bun:test `describe.skipIf(!siblingPluginPresent("ma-foo-plugin"))`.

import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * Absolute path to the plugins checkout. `MA_PLUGINS_DIR` (absolute, or
 * relative to the cwd) wins, used as is. Else the sibling
 * `../minimal-agent-plugins/`, resolved relative to the repo root (two levels
 * up from `src/test-utils/`). Same override name as `scripts/compile.ts`.
 */
export const SIBLING_REPO_ROOT: string = process.env.MA_PLUGINS_DIR
  ? resolve(process.env.MA_PLUGINS_DIR)
  : resolve(import.meta.dirname, "..", "..", "..", "minimal-agent-plugins")

/** True when the sibling plugins repo is checked out next to this repo. */
export function siblingRepoPresent(): boolean {
  return existsSync(SIBLING_REPO_ROOT)
}

/**
 * True when a specific migrated plugin is present in the sibling repo. `dir` is
 * the plugin's directory name (e.g. `ma-file-lock-plugin`). Checks for the dir
 * itself so both manifest plugins and provider (`provider.json`) plugins pass.
 */
export function siblingPluginPresent(dir: string): boolean {
  return existsSync(join(SIBLING_REPO_ROOT, dir))
}
