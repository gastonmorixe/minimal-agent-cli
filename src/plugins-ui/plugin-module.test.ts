/**
 * The plugin module loader refuses core code and code outside the plugin (S35).
 *
 * A name deny list is not enough: `@minimal-agent//core` and a core
 * checkout with another dir name both passed it. The loader now compares
 * real paths with the real core package root, checks the name of the
 * nearest `package.json`, and keeps each import inside the plugin's own root.
 *
 * @module plugins-ui/plugin-module.test
 */

import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { importPluginModule } from "./plugin-module.ts"

const CLI_ROOT = join(import.meta.dir, "..", "..")
const TMP_ROOT = join(CLI_ROOT, "tmp")
mkdirSync(TMP_ROOT, { recursive: true })
const DIR = mkdtempSync(join(TMP_ROOT, "plugin-module-"))

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true })
})

/** Write `path` with a module that exports `value` as default. */
function writeModule(path: string, value: string): string {
  writeFileSync(path, `export default ${JSON.stringify(value)}\n`)
  return path
}

// A plugin package with one good module.
const PLUGIN = join(DIR, "plugin")
mkdirSync(PLUGIN)
const GOOD = writeModule(join(PLUGIN, "good.ts"), "good")

// A code dir outside the plugin, and a link to it inside the plugin.
const OTHER = join(DIR, "other")
mkdirSync(OTHER)
const OUTSIDE = writeModule(join(OTHER, "outside.ts"), "outside")
symlinkSync(OUTSIDE, join(PLUGIN, "linked.ts"))

// A core checkout whose dir name is not minimal-agent-core.
const WS = join(DIR, "ws")
mkdirSync(join(WS, "core", "src"), { recursive: true })
writeFileSync(join(WS, "core", "package.json"), '{"name":"@minimal-agent/core"}\n')
const FAKE_CORE = writeModule(join(WS, "core", "src", "index.ts"), "core")

describe("importPluginModule (S35)", () => {
  it("imports a module inside the plugin root", async () => {
    expect(await importPluginModule(GOOD, PLUGIN)).toMatchObject({ default: "good" })
  })

  it("refuses the installed core package through a double slash", async () => {
    const path = join(CLI_ROOT, "node_modules", "@minimal-agent")
    await expect(importPluginModule(`${path}//core/src/sdk/runtime.ts`, CLI_ROOT)).rejects.toThrow(
      /names core code/,
    )
  })

  it("refuses a core checkout with another dir name", async () => {
    await expect(importPluginModule(FAKE_CORE, WS)).rejects.toThrow(/names core code/)
  })

  it("refuses a module outside the plugin root", async () => {
    await expect(importPluginModule(OUTSIDE, PLUGIN)).rejects.toThrow(/outside the plugin/)
  })

  it("refuses a link inside the plugin root to a module outside it", async () => {
    await expect(importPluginModule(join(PLUGIN, "linked.ts"), PLUGIN)).rejects.toThrow(
      /outside the plugin/,
    )
  })
})
