/**
 * Sideband codec plugin root for CLI loader tests (design step 7).
 *
 * Core renders the plugin system-prompt sections (`<ma::sys::ROLE>`) with the
 * sideband codec, and the role kinds (`behavior`, `context`, `emit`, `mode`,
 * `tool`) come from a plugin manifest. A test that loads only temp fixture
 * plugins has no codec and no kinds, so `getPromptBlock()` gives `null`.
 *
 * This helper writes one tiny temp package that declares the real codec of
 * the sibling checkout (`ma-sideband-plugin/lib/codec.ts`) and only the 5
 * role kinds, copied from the sibling manifests. It has no prompt and no
 * tool, so it does not change the prompt text of the test. The CLI cannot
 * import core `src/test-utils`, so this is a copy of the approach of core
 * `sidebandCodecPluginRoot()` / `withSidebandCodec()`.
 *
 * @module test-utils/sideband-codec-root
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { SIBLING_REPO_ROOT, siblingPluginPresent } from "./sibling-repo.ts"

const CODEC_PLUGIN = "ma-sideband-plugin"

/** The system role kinds (design step 7): one for each prompt role. */
const SYSTEM_ROLE_KINDS: ReadonlySet<string> = new Set([
  "behavior",
  "context",
  "emit",
  "mode",
  "tool",
])

/** Id of the package that {@link sidebandCodecPluginRoot} writes. */
export const SIDEBAND_CODEC_FIXTURE_ID = "zz-sideband-fixture"

/** The embedded root of the fixture package (one for each process). */
const FIXTURE_ROOT = join(
  import.meta.dirname,
  "..",
  "..",
  "tmp",
  `sideband-codec-fixture-${process.pid}`,
)

/** The role kinds that the sibling manifests declare. */
function siblingRoleKinds(): unknown[] {
  const out: unknown[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(SIBLING_REPO_ROOT).sort()
  } catch {
    return out
  }
  for (const dir of dirs) {
    const path = join(SIBLING_REPO_ROOT, dir, "manifest.json")
    if (!existsSync(path)) continue
    try {
      const m = JSON.parse(readFileSync(path, "utf8")) as { sideband?: { kind?: unknown }[] }
      for (const k of m.sideband ?? []) {
        if (typeof k.kind === "string" && SYSTEM_ROLE_KINDS.has(k.kind)) out.push(k)
      }
    } catch {
      // A bad manifest is not a fixture input.
    }
  }
  return out
}

/**
 * The embedded plugin root of a test package with the real codec and the 5
 * system role kinds. Written one time for each process. `null` when the codec
 * checkout is missing.
 */
export function sidebandCodecPluginRoot(): string | null {
  const codec = join(SIBLING_REPO_ROOT, CODEC_PLUGIN, "lib", "codec.ts")
  if (!siblingPluginPresent(CODEC_PLUGIN) || !existsSync(codec)) return null
  const dir = join(FIXTURE_ROOT, SIDEBAND_CODEC_FIXTURE_ID)
  if (existsSync(join(dir, "manifest.json"))) return FIXTURE_ROOT
  mkdirSync(dir, { recursive: true })
  const manifest = {
    id: SIDEBAND_CODEC_FIXTURE_ID,
    name: "Sideband codec fixture",
    version: "0.1.0",
    description: "test",
    sidebandCodec: { id: "xml-ma-v1", entry: "./codec.ts" },
    sideband: siblingRoleKinds(),
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))
  writeFileSync(join(dir, "codec.ts"), `export { default } from ${JSON.stringify(codec)}\n`)
  return FIXTURE_ROOT
}

/** The fixture root as a list: empty when the codec checkout is missing. */
export function sidebandCodecRoots(): string[] {
  const root = sidebandCodecPluginRoot()
  return root === null ? [] : [root]
}
