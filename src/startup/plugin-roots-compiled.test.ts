/**
 * Unit tests for the plugin roots of a compiled binary.
 *
 * @module startup/plugin-roots-compiled.test
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  computePluginRoots,
  isStandaloneExecutable,
  PLUGINS_CHECKOUT_DIR,
  type PluginMode,
  pluginCheckoutRoots,
  resolvePluginMode,
} from "./plugin-roots.ts"

const install: PluginMode = { kind: "install", checkouts: [] }
const dev: PluginMode = { kind: "dev", checkouts: ["/co/plugins"] }

describe("computePluginRoots in a compiled binary", () => {
  // The binary's own plugins are the registered embedded table (core
  // appends it after these disk roots), not a `<cli>/plugins` dir.
  test("dev mode: the embedded tier is the checkouts only", () => {
    const r = computePluginRoots("/$bunfs", {}, "/proj", "/home/.ma", dev)
    expect(r.embedded).toEqual(["/co/plugins"])
    expect(r.user).toEqual([])
  })

  test("install mode: no disk embedded root, the user tier stays (overrides)", () => {
    const r = computePluginRoots("/$bunfs", {}, "/proj", "/home/.ma", install)
    expect(r.embedded).toEqual([])
    expect(r.user).toEqual([join("/home/.ma", "plugins")])
  })

  test("no root ever points into the Bun virtual fs", () => {
    const r = computePluginRoots("/$bunfs/root", {}, "/proj", "/home/.ma", install)
    for (const dir of [...(r.embedded ?? []), ...(r.user ?? []), ...(r.project ?? [])]) {
      expect(dir.startsWith("/$bunfs")).toBe(false)
    }
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
