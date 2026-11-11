/**
 * The help test catalog (SPEC-HELP R-34, plan M-10).
 *
 * Help tests must not depend on the plugins of the machine. They read the
 * catalog from the fixture root `help-plugins/` only, with the platform
 * gate off (`all`), and pass it to help through the `helpCatalog` seam of
 * `prepareEntrypointArgs` (or the `catalog` option of `printHelp`).
 *
 * The fixture root holds manifests only, no module files. If help ever
 * imported a plugin module, the fixture tests would fail.
 *
 * - alpha: on, host mode `acp` with args and examples, two help sections.
 * - beta: on, host mode `acp` (collides with alpha: `collision`) and
 *   `beta-rpc` (usable).
 * - delta: shipped disabled (`manifest`), host mode `delta-mode`, one help
 *   section.
 * - gamma: on, host mode `gamma-mode` with no `hostMode:stdio` permission
 *   (`permission`).
 *
 * @module startup/fixtures/help-catalog
 */

import { join } from "node:path"

import type { CatalogCliEntry } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { type HelpCatalogInput, readHelpCatalog } from "../../cli/registry/plugins.ts"

/** The fixture plugin root. */
export const HELP_FIXTURE_ROOT = join(import.meta.dir, "help-plugins")

/** The catalog of {@link HELP_FIXTURE_ROOT}. `overrides` set the enable lists. */
export function fixtureHelpCatalog(
  overrides: Pick<HelpCatalogInput, "cli" | "env" | "config"> = {},
): CatalogCliEntry[] {
  return readHelpCatalog({
    roots: { embedded: [HELP_FIXTURE_ROOT], user: [], project: [] },
    platform: "all",
    ...overrides,
  })
}
