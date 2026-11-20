/**
 * Sideband fixture for CLI tests (design 40, step 13).
 *
 * The CLI holds no wire form. A test that reads or pins tag bytes gets the
 * real codec and kinds through the public `loadSidebandOnly()` over the
 * sibling plugins checkout (`SIBLING_REPO_ROOT`). Each plugin that declares
 * kinds or the codec is enabled, also one that its manifest disables. No
 * handler is imported. Guard a test with
 * `describe.skipIf(!sidebandFixturePresent())`.
 *
 * @module test-utils/sideband-fixture
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  loadSidebandOnly,
  NO_SIDEBAND,
  type SidebandApi,
  type SidebandOnlyOptions,
} from "@minimal-agent/core/host/sideband"

import { SIBLING_REPO_ROOT, siblingPluginPresent } from "./sibling-repo.ts"

const CODEC_PLUGIN = "ma-sideband-plugin"

/** The ids of the sibling plugins that declare sideband kinds or the codec. */
function sidebandPluginIds(): Set<string> {
  const ids = new Set<string>()
  let dirs: string[] = []
  try {
    dirs = readdirSync(SIBLING_REPO_ROOT)
  } catch {
    return ids
  }
  for (const dir of dirs) {
    const path = join(SIBLING_REPO_ROOT, dir, "manifest.json")
    if (!existsSync(path)) continue
    try {
      const m = JSON.parse(readFileSync(path, "utf8")) as {
        id?: unknown
        sideband?: unknown
        sidebandCodec?: unknown
      }
      if (typeof m.id === "string" && (Array.isArray(m.sideband) || m.sidebandCodec)) ids.add(m.id)
    } catch {
      // A bad manifest is not a fixture input.
    }
  }
  return ids
}

/** A diagnostics target that drops each event (plugin skip notices). */
const SILENT = {
  sessionId: undefined,
  emit: () => {},
} as unknown as NonNullable<SidebandOnlyOptions["diagnostics"]>

async function boot(): Promise<SidebandApi> {
  if (!siblingPluginPresent(CODEC_PLUGIN)) return NO_SIDEBAND
  return loadSidebandOnly({
    roots: { embedded: [SIBLING_REPO_ROOT], user: [], project: [] },
    enabledPluginIds: sidebandPluginIds(),
    diagnostics: SILENT,
  })
}

/** The real sideband API of the sibling checkout, or `NO_SIDEBAND` when it is missing. */
export const testSideband: SidebandApi = await boot()

if (!testSideband.ready) {
  console.warn(
    `[sideband-fixture] SKIP the sideband tests: ${CODEC_PLUGIN} is missing in ${SIBLING_REPO_ROOT}.`,
  )
}

/** True when the real codec is loaded. */
export function sidebandFixturePresent(): boolean {
  return testSideband.ready
}
