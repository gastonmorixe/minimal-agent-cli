/**
 * Text fixture providers for CLI tests.
 *
 * Core owns no model-facing text. The real text plugins of the sibling
 * plugins repo own it: ma-turn-recovery-plugin and ma-core-tools-plugin
 * (synthetic kinds and built-in tool text), ma-base-prompt-plugin (identity
 * and the base system slots). A CLI test that checks today's English bytes
 * through a core path gets the text from these providers, never from a core
 * fallback. Same idea as core's `src/test-utils/text-fixture-providers.ts`.
 *
 * The CLI boundary check bans computed `import()`, so the providers come
 * from a real `PluginLoader` over a temp root that links the 3 plugins of
 * the sibling checkout (loaded once, at module load). tsc does not walk into
 * the plugins tree, and a missing checkout does not break the import. Tests
 * guard with `describe.skipIf(!textFixturesPresent())`, or skip on an empty
 * `textPluginDirs()`. When a text plugin or ma-prompt-template-plugin
 * ({@link BOOT_TEXT_PLUGINS}) is missing, this module prints one warning at
 * load and the guarded tests skip. With `MINIMAL_AGENT_REQUIRE_TEXT_FIXTURES=1`,
 * or `CI` set, it throws at load instead (the message names the trigger), so
 * every test file that imports it fails with a clear message.
 * `MA_PLUGINS_DIR` overrides the checkout path (see `sibling-repo.ts`).
 *
 * @module test-utils/text-fixture-providers
 */

import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import type { SyntheticTextProvider } from "@minimal-agent/core/plugin-api/types/synthetic-text"
import type { ToolTextProvider } from "@minimal-agent/core/plugin-api/types/tool-text"
import type { SyntheticTextResolverLike } from "@minimal-agent/core/sdk/ports"

import { SIBLING_REPO_ROOT, siblingPluginPresent } from "./sibling-repo.ts"
import { textFixturesTrigger } from "./text-fixtures-required.ts"

/** The plugins whose text the fixtures use. */
export const TEXT_PLUGINS = [
  "ma-turn-recovery-plugin",
  "ma-core-tools-plugin",
  "ma-base-prompt-plugin",
] as const

async function loadTextLoader(): Promise<PluginLoader | null> {
  if (!TEXT_PLUGINS.every((dir) => siblingPluginPresent(dir))) return null
  const root = mkdtempSync(join(tmpdir(), "ma-cli-text-fixture-"))
  // The root holds links only: removing it never touches the checkout.
  process.on("exit", () => rmSync(root, { recursive: true, force: true }))
  for (const dir of TEXT_PLUGINS) symlinkSync(join(SIBLING_REPO_ROOT, dir), join(root, dir))
  return PluginLoader.load({ roots: { embedded: [root] }, logger: () => {} })
}

export { textFixturesRequired, textFixturesTrigger } from "./text-fixtures-required.ts"

/**
 * The plugins a CLI boot needs to pass the text contract check: the text
 * plugins plus ma-prompt-template-plugin (`prompts.template`).
 */
export const BOOT_TEXT_PLUGINS = [...TEXT_PLUGINS, "ma-prompt-template-plugin"] as const

const LOADER: PluginLoader | null = await loadTextLoader()

// The guard covers BOOT_TEXT_PLUGINS (a superset of TEXT_PLUGINS): the
// providers need the text plugins, and `textPluginDirs()` (a spawned CLI
// boot) also needs the template plugin. A test that skips on either one is
// covered.
const MISSING: readonly string[] = BOOT_TEXT_PLUGINS.filter((dir) => !siblingPluginPresent(dir))

if (MISSING.length > 0) {
  const reason =
    `the text plugins (${MISSING.join(", ")}) are missing in ${SIBLING_REPO_ROOT}.` +
    " Set MA_PLUGINS_DIR, or clone minimal-agent-plugins next to this repo."
  const trigger = textFixturesTrigger()
  if (trigger !== null) {
    // Thrown at module load: every test file that imports this helper fails.
    throw new Error(`[text-fixture-providers] FAIL: ${trigger} is set, and ${reason}`)
  }
  console.warn(
    `[text-fixture-providers] WARNING: SKIP the text tests: ${reason} Set MINIMAL_AGENT_REQUIRE_TEXT_FIXTURES=1 to make this a failure.`,
  )
}

/** True when the text plugins are checked out. Guard with `describe.skipIf(!textFixturesPresent())`. */
export function textFixturesPresent(): boolean {
  return LOADER !== null
}

/**
 * Absolute directories of {@link BOOT_TEXT_PLUGINS} in the sibling checkout,
 * for the plugin root of a spawned CLI. `[]` when any one is absent (the load
 * guard has then already warned, or thrown under CI or the require flag).
 */
export function textPluginDirs(): string[] {
  if (MISSING.length > 0) return []
  return BOOT_TEXT_PLUGINS.map((dir) => join(SIBLING_REPO_ROOT, dir))
}

function loader(): PluginLoader {
  if (LOADER === null) {
    throw new Error(
      `[text-fixture-providers] the text plugins (${TEXT_PLUGINS.join(", ")}) are missing in ${SIBLING_REPO_ROOT}. Guard the test with describe.skipIf(!textFixturesPresent()).`,
    )
  }
  return LOADER
}

/** The synthetic text providers of the 2 real plugins (turn recovery and core tools). */
export function fixtureSyntheticTextProviders(): SyntheticTextProvider[] {
  return [...loader().syntheticTextProviders()]
}

/** The core-tools tool text provider (descriptions and params of the built-in tools). */
export function fixtureToolTextProviders(): ToolTextProvider[] {
  return [...loader().toolTextProviders()]
}

/**
 * The loader's synthetic text resolver over {@link fixtureSyntheticTextProviders}.
 * For a `ModeManager` (7th constructor arg or `bindSyntheticText`) and for
 * `ToolExecContext.text`.
 */
export function fixtureSyntheticTextResolver(): SyntheticTextResolverLike {
  return loader().syntheticText()
}

/** The 2 text deps of a core (`BuildAgentCoreDeps`, `InteractiveSessionDeps`). */
export interface TextCoreDeps {
  syntheticTextProviders: SyntheticTextProvider[]
  toolTextProviders: ToolTextProvider[]
}

/** The synthetic and tool text providers to spread into core deps. `{}` when the plugins are absent. */
export function textCoreDeps(): Partial<TextCoreDeps> {
  if (LOADER === null) return {}
  return {
    syntheticTextProviders: fixtureSyntheticTextProviders(),
    toolTextProviders: fixtureToolTextProviders(),
  }
}
