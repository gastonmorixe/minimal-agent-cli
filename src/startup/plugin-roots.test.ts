import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { providerRootsOf } from "@minimal-agent/core/host-kit/plugin-loader"

import {
  computePluginRoots,
  legacyPluginRoots,
  PLUGINS_CHECKOUT_DIR,
  PROJECT_PLUGINS_SUBDIR,
  pluginCheckoutRoots,
  reportPluginRoots,
  resolvePluginMode,
} from "./plugin-roots.ts"

/** Make `dir/<name>/manifest.json`, so `dir` holds one plugin package. */
function addPackage(dir: string, name = "ma-x-plugin"): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, "manifest.json"), "{}")
}

describe("computePluginRoots", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cli-plugin-roots-"))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("dev mode: a checkout with packages empties the user tier", () => {
    const cliRoot = join(root, "cli")
    const checkout = join(root, PLUGINS_CHECKOUT_DIR)
    addPackage(checkout)
    const roots = computePluginRoots(cliRoot, { HOME: "/h" }, "/work", "/h/.minimal-agent")
    expect(roots).toEqual({
      embedded: [checkout],
      user: [],
      project: [join("/work", PROJECT_PLUGINS_SUBDIR)],
    })
    // Provider roots: only one first-party copy, the checkout.
    expect(providerRootsOf(roots)).toEqual([checkout])
  })

  it("install mode: no checkout keeps the user clone", () => {
    const cliRoot = join(root, "cli")
    const roots = computePluginRoots(cliRoot, { HOME: "/h" }, "/work", "/h/.minimal-agent")
    expect(roots).toEqual({
      embedded: [],
      user: ["/h/.minimal-agent/plugins"],
      project: [join("/work", PROJECT_PLUGINS_SUBDIR)],
    })
  })

  it("has no home tier", () => {
    const roots = computePluginRoots(
      join(root, "cli"),
      { HOME: "/h" },
      "/work",
      "/h/.minimal-agent",
    )
    expect("home" in roots).toBe(false)
  })

  it("project tier is <cwd>/.agents/minimal-agent/plugins", () => {
    expect(PROJECT_PLUGINS_SUBDIR).toBe(join(".agents", "minimal-agent", "plugins"))
  })

  it("an empty checkout dir is install mode", () => {
    mkdirSync(join(root, PLUGINS_CHECKOUT_DIR))
    const cliRoot = join(root, "cli")
    const mode = resolvePluginMode(cliRoot, {})
    expect(mode.kind).toBe("install")
    expect(mode.checkouts).toEqual([])
    const roots = computePluginRoots(cliRoot, {}, "/work", "/h/.minimal-agent")
    expect(roots.user).toEqual(["/h/.minimal-agent/plugins"])
  })

  it("unknown agent home gives an empty user tier", () => {
    const roots = computePluginRoots(join(root, "cli"), {}, "/work", undefined)
    expect(roots.embedded).toEqual([])
    expect(roots.user).toEqual([])
  })

  it("MINIMAL_AGENT_PLUGIN_SIBLINGS replaces the default checkout, existing dirs only", () => {
    const a = join(root, "a")
    mkdirSync(a)
    expect(
      pluginCheckoutRoots(join(root, "cli"), {
        MINIMAL_AGENT_PLUGIN_SIBLINGS: `${a}:${join(root, "missing")}`,
      }),
    ).toEqual([a])
  })

  it("a checkout of symlinked packages is dev mode", () => {
    const real = join(root, "real")
    addPackage(real)
    const linked = join(root, "linked")
    mkdirSync(linked)
    symlinkSync(join(real, "ma-x-plugin"), join(linked, "ma-x-plugin"))
    const mode = resolvePluginMode(join(root, "cli"), { MINIMAL_AGENT_PLUGIN_SIBLINGS: linked })
    expect(mode).toEqual({ kind: "dev", checkouts: [linked] })
  })

  it("a checkout with only a provider.json package is dev mode", () => {
    const a = join(root, "a")
    mkdirSync(join(a, "ma-llm-x-plugin"), { recursive: true })
    writeFileSync(join(a, "ma-llm-x-plugin", "provider.json"), "{}")
    const mode = resolvePluginMode(join(root, "cli"), { MINIMAL_AGENT_PLUGIN_SIBLINGS: a })
    expect(mode).toEqual({ kind: "dev", checkouts: [a] })
  })

  it("MINIMAL_AGENT_PLUGIN_SIBLINGS with packages is dev mode", () => {
    const a = join(root, "a")
    addPackage(a)
    const mode = resolvePluginMode(join(root, "cli"), { MINIMAL_AGENT_PLUGIN_SIBLINGS: a })
    expect(mode).toEqual({ kind: "dev", checkouts: [a] })
  })
})

describe("reportPluginRoots", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cli-report-roots-"))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("dev mode: one notice; legacy root: one warn (scrollback + file log)", () => {
    const cwd = join(root, "work")
    addPackage(join(cwd, ".agents", "plugins"))
    const notices: string[] = []
    const warns: string[] = []
    reportPluginRoots({ kind: "dev", checkouts: ["/c"] }, {}, cwd, {
      notice: (_s, m) => notices.push(m),
      warn: (_s, m) => warns.push(m),
    })
    expect(notices).toEqual(["dev mode: plugins from /c, no clone"])
    expect(warns).toEqual([
      `ignored legacy plugin root ${join(cwd, ".agents", "plugins")}, move its plugins to ${join(cwd, PROJECT_PLUGINS_SUBDIR)}`,
    ])
  })

  it("install mode with no legacy roots reports nothing", () => {
    const calls: string[] = []
    reportPluginRoots({ kind: "install", checkouts: [] }, {}, join(root, "w"), {
      notice: (_s, m) => calls.push(m),
      warn: (_s, m) => calls.push(m),
    })
    expect(calls).toEqual([])
  })
})

describe("legacyPluginRoots", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cli-legacy-roots-"))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("lists old roots that still hold packages", () => {
    const home = join(root, "home")
    const cwd = join(root, "work")
    addPackage(join(home, ".agents", "plugins"))
    addPackage(join(cwd, ".agents", "plugins"))
    expect(legacyPluginRoots({ HOME: home }, cwd)).toEqual([
      join(cwd, ".agents", "plugins"),
      join(home, ".agents", "plugins"),
    ])
  })

  it("ignores empty or missing old roots and dedupes cwd == HOME", () => {
    const home = join(root, "home")
    mkdirSync(join(home, ".agents", "plugins"), { recursive: true })
    expect(legacyPluginRoots({ HOME: home }, home)).toEqual([])
    addPackage(join(home, ".agents", "plugins"))
    expect(legacyPluginRoots({ HOME: home }, home)).toEqual([join(home, ".agents", "plugins")])
  })
})
