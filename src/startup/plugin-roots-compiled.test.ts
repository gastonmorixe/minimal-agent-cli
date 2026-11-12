/**
 * Unit tests for the compiled-binary plugin root (`compiledRoot`).
 *
 * @module startup/plugin-roots-compiled.test
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  compiledPluginsRoot,
  computePluginRoots,
  isStandaloneExecutable,
  PLUGINS_CHECKOUT_DIR,
  type PluginMode,
  pluginCheckoutRoots,
  resolvePluginMode,
} from "./plugin-roots.ts"

const install: PluginMode = { kind: "install", checkouts: [] }
const dev: PluginMode = { kind: "dev", checkouts: ["/co/plugins"] }

describe("computePluginRoots compiledRoot", () => {
  test("no compiledRoot: embedded root is <cliRoot>/plugins", () => {
    const r = computePluginRoots("/cli", {}, "/proj", "/home/.ma", dev)
    expect(r.embedded).toEqual([join("/cli", "plugins"), "/co/plugins"])
  })

  test("compiledRoot replaces the first embedded entry and keeps checkouts", () => {
    const r = computePluginRoots("/$bunfs", {}, "/proj", "/home/.ma", dev, "/$bunfs/root/plugins")
    expect(r.embedded).toEqual(["/$bunfs/root/plugins", "/co/plugins"])
  })

  test("install mode keeps the user tier", () => {
    const r = computePluginRoots(
      "/$bunfs",
      {},
      "/proj",
      "/home/.ma",
      install,
      "/$bunfs/root/plugins",
    )
    expect(r.embedded).toEqual(["/$bunfs/root/plugins"])
    expect(r.user).toEqual([join("/home/.ma", "plugins")])
  })
})

describe("compiledPluginsRoot", () => {
  test("true for the Bun virtual fs dir", () => {
    expect(compiledPluginsRoot("/$bunfs/root")).toBe(join("/$bunfs/root", "plugins"))
  })
  test("true for the Windows form", () => {
    expect(compiledPluginsRoot("B:/~BUN/root")).toBe(join("B:/~BUN/root", "plugins"))
  })
  test("undefined for a disk dir", () => {
    expect(compiledPluginsRoot("/repo/minimal-agent-cli/src")).toBeUndefined()
  })
})

describe("standalone binary: no implicit checkout probe (plan 2.4)", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ma-roots-standalone-"))
    // A `minimal-agent-plugins` dir with a package next to the "CLI root".
    const pkg = join(root, PLUGINS_CHECKOUT_DIR, "ma-x-plugin")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, "manifest.json"), "{}")
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test("from source the sibling probe finds the checkout (dev mode)", () => {
    const mode = resolvePluginMode(join(root, "cli"), {}, false)
    expect(mode).toEqual({ kind: "dev", checkouts: [join(root, PLUGINS_CHECKOUT_DIR)] })
  })

  test("a standalone binary ignores the sibling dir (install mode)", () => {
    expect(pluginCheckoutRoots(join(root, "cli"), {}, true)).toEqual([])
    expect(resolvePluginMode(join(root, "cli"), {}, true)).toEqual({
      kind: "install",
      checkouts: [],
    })
  })

  test("a standalone binary still honors MINIMAL_AGENT_PLUGIN_SIBLINGS", () => {
    const dir = join(root, PLUGINS_CHECKOUT_DIR)
    const env = { MINIMAL_AGENT_PLUGIN_SIBLINGS: dir }
    expect(resolvePluginMode(join(root, "cli"), env, true)).toEqual({
      kind: "dev",
      checkouts: [dir],
    })
  })

  test("a test run is not a standalone binary", () => {
    expect(isStandaloneExecutable()).toBe(false)
  })
})
