/**
 * The empty embedded plugin table. `package.json#imports` maps
 * `#embedded-plugins` here, so a source run, a test, and a plain `bun build`
 * register no table and load plugins from disk only. `scripts/compile.ts`
 * resolves `#embedded-plugins` to the table that
 * `scripts/gen-embedded-plugins.ts` generates for the binary.
 *
 * @module generated/embedded-plugins.empty
 */

import type { EmbeddedPluginTable } from "@minimal-agent/core/host-kit/embedded-plugins"

/** No packages: nothing is registered. */
export const TABLE: EmbeddedPluginTable = { buildId: "source", packages: {} }
