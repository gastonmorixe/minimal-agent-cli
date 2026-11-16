// Wave G test support: several integration tests exercise plugins that have
// been physically moved to the sibling plugins checkout (`MA_PLUGINS_DIR`, else
// `../minimal-agent-plugins/`). When that checkout is absent (a fresh clone,
// contributors who have not cloned the sibling), those tests cannot run, and
// they SKIP. Exception: the text fixtures. `text-fixture-providers.ts` FAILS
// at load instead of skipping when `textFixturesRequired()` is true
// (`MINIMAL_AGENT_REQUIRE_TEXT_FIXTURES=1`, or `CI` set), so CI cannot skip
// the text tests silently.
//
// Use with bun:test `describe.skipIf(!siblingPluginPresent("ma-foo-plugin"))`.

import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * Absolute path to the plugins checkout. `MA_PLUGINS_DIR` (absolute, or
 * relative to the cwd) wins, used as is. An empty `MA_PLUGINS_DIR` counts as
 * unset (same rule as `scripts/compile.ts`). Else the sibling
 * `../minimal-agent-plugins/`, resolved relative to the repo root (two levels
 * up from `src/test-utils/`).
 */
export const SIBLING_REPO_ROOT: string = process.env.MA_PLUGINS_DIR
  ? resolve(process.env.MA_PLUGINS_DIR)
  : resolve(import.meta.dirname, "..", "..", "..", "minimal-agent-plugins")

/** True when the plugins checkout exists at {@link SIBLING_REPO_ROOT}. */
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
