import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { providerRootsOf } from "@minimal-agent/core/host-kit/plugin-loader"

import { computePluginRoots, PLUGINS_CHECKOUT_DIR, pluginCheckoutRoots } from "./plugin-roots.ts"

describe("computePluginRoots (S40)", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cli-plugin-roots-"))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("computes the embedded, user, home, and project roots", () => {
    const cliRoot = join(root, "cli")
    mkdirSync(join(root, PLUGINS_CHECKOUT_DIR), { recursive: true })
    const roots = computePluginRoots(cliRoot, { HOME: "/h" }, "/work", "/h/.minimal-agent")
    expect(roots).toEqual({
      embedded: [join(cliRoot, "plugins"), join(root, PLUGINS_CHECKOUT_DIR)],
      user: ["/h/.minimal-agent/plugins"],
      home: ["/h/.agents/plugins"],
      project: ["/work/.agents/plugins"],
    })
    // Provider roots: embedded first (the dev checkout shadows the clone), then user.
    expect(providerRootsOf(roots)).toEqual([
      join(cliRoot, "plugins"),
      join(root, PLUGINS_CHECKOUT_DIR),
      "/h/.minimal-agent/plugins",
    ])
  })

  it("skips a missing checkout and unknown homes", () => {
    const roots = computePluginRoots(join(root, "cli"), {}, "/work", undefined)
    expect(roots.embedded).toEqual([join(root, "cli", "plugins")])
    expect(roots.user).toEqual([])
    expect(roots.home).toEqual([])
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
})
