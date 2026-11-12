/**
 * Unit tests for the compiled-binary plugin root (`compiledRoot`).
 *
 * @module startup/plugin-roots-compiled.test
 */

import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { compiledPluginsRoot, computePluginRoots, type PluginMode } from "./plugin-roots.ts"

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
