/**
 * The CLI plugin UI loader (S35): `ctx.tui` is absent for headless entries
 * and present for `ui` entries. A `ui.setup` module fills the plugin's
 * style slots from `ctx.tui.kit` (S41). Flat manifests get no ui part.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import type { LiveAreaHandlerContext } from "@minimal-agent/core/plugin-api/types/plugin"

import { loadPluginUi } from "./ui-loader.ts"

/** A handler body that reports whether its ctx has `tui`. */
const TOOL_BODY = `export default async (ctx) => ({
  kind: "tool_result",
  content: JSON.stringify({ hasTui: "tui" in ctx && ctx.tui !== undefined }),
})`
const SLOT_BODY = `export default async (ctx) =>
  JSON.stringify({ hasTui: ctx.tui !== undefined, capability: ctx.tui?.capability ?? null })`

const TOOL_ENTRY = {
  id: "probe",
  trigger: {
    type: "tool",
    tool: {
      name: "UiProbe",
      description: "probe",
      input_schema: { type: "object", properties: {} },
      explicitName: true,
    },
  },
  handler: { type: "module", path: "./tool.ts", export: "default" },
  interactive: false,
}
const SLOT_ENTRY = { id: "probe_slot", handler: { type: "module", path: "./slot.ts" } }

/** A minimal live-area ctx; the loader adds `tui`. */
function slotCtx(dir: string): LiveAreaHandlerContext {
  return {
    packageDir: dir,
    cwd: dir,
    env: {},
    abort: new AbortController().signal,
    stderr: process.stderr,
    log: {} as LiveAreaHandlerContext["log"],
    tick: 0,
  } as LiveAreaHandlerContext
}

describe("loadPluginUi (S35)", () => {
  let root: string
  let pluginsDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cli-ui-loader-"))
    pluginsDir = join(root, "plugins")
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writePlugin(id: string, manifest: Record<string, unknown>): string {
    const dir = join(pluginsDir, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ id, name: id, version: "0.1.0", description: "t", ...manifest }),
    )
    writeFileSync(join(dir, "tool.ts"), TOOL_BODY)
    writeFileSync(join(dir, "slot.ts"), SLOT_BODY)
    return dir
  }

  async function boot(disabled: string[] = []) {
    const logs: string[] = []
    const loader = await PluginLoader.load({
      roots: { embedded: [pluginsDir] },
      logger: (m) => logs.push(m),
      disabledPluginIds: new Set(disabled),
    })
    const ui = await loadPluginUi({
      packages: loader.loadedPackages(),
      logger: (m) => logs.push(m),
    })
    return { loader, ui, logs }
  }

  it("ctx.tui is absent for a headless entry and present for a ui entry", async () => {
    const dir = writePlugin("ui-probe", {
      headless: { tools: [TOOL_ENTRY] },
      ui: { liveAreaSlots: [SLOT_ENTRY] },
    })
    const { loader, ui, logs } = await boot()

    const toolResult = await loader.dispatch(
      { type: "tool", name: "UiProbe", input: {}, tool_use_id: "t1" },
      dir,
    )
    expect(toolResult.kind).toBe("tool_result")
    if (toolResult.kind !== "tool_result") throw new Error("unreachable")
    expect(JSON.parse(toolResult.content as string)).toEqual({ hasTui: false })

    expect(ui.liveAreaSlots.map((s) => s.definition.id)).toEqual(["probe_slot"])
    const slot = ui.liveAreaSlots[0]
    if (!slot) throw new Error("no slot")
    expect(slot.definition.position).toBe("footer")
    expect(slot.definition.refreshMs).toBe(60_000)
    const out = await slot.invoke(slotCtx(dir))
    expect(JSON.parse(out ?? "{}")).toEqual({ hasTui: true, capability: "ui.terminal" })
    expect(logs).toEqual([])
  })

  it("loads no ui part for a flat manifest (S41)", async () => {
    writePlugin("flat-probe", { tuis: [TOOL_ENTRY], liveAreaSlots: [SLOT_ENTRY] })
    const { ui, logs } = await boot()
    expect(ui.liveAreaSlots).toEqual([])
    expect(logs.some((l) => l.includes("flat-probe"))).toBe(true)
  })

  it("ui.setup fills the style slots that the headless handler reads (S41)", async () => {
    const dir = writePlugin("style-probe", {
      headless: {
        tools: [{ ...TOOL_ENTRY, handler: { ...TOOL_ENTRY.handler, path: "./styled.ts" } }],
      },
      ui: { setup: { type: "module", path: "./ui/setup.ts" } },
    })
    mkdirSync(join(dir, "ui"), { recursive: true })
    writeFileSync(
      join(dir, "style.ts"),
      `import { createStyleSlots } from "@minimal-agent/core/plugin-api/utils/style-slots"
export const slots = createStyleSlots()`,
    )
    writeFileSync(
      join(dir, "styled.ts"),
      `import { slots } from "./style.ts"
export default async () => ({ kind: "tool_result", content: "plain", display: slots.styles.dim("body") })`,
    )
    writeFileSync(
      join(dir, "ui", "setup.ts"),
      `import { slots } from "../style.ts"
export default (ctx) => { slots.install(ctx.tui.kit) }`,
    )
    const logs: string[] = []
    const loader = await PluginLoader.load({
      roots: { embedded: [pluginsDir] },
      logger: (m) => logs.push(m),
    })
    const call = { type: "tool" as const, name: "UiProbe", input: {}, tool_use_id: "t1" }
    const before = await loader.dispatch(call, dir)
    if (before.kind !== "tool_result") throw new Error("unreachable")
    expect(before.display).toBe("body")
    await loadPluginUi({ packages: loader.loadedPackages(), logger: (m) => logs.push(m) })
    const after = await loader.dispatch(call, dir)
    if (after.kind !== "tool_result") throw new Error("unreachable")
    expect(after.content).toBe("plain")
    expect(after.display).toBe("\x1b[2mbody\x1b[22m")
    expect(logs).toEqual([])
  })

  it("logs a ui.setup without a default export and keeps the slots", async () => {
    const dir = writePlugin("nosetup-probe", {
      headless: {},
      ui: { setup: { type: "module", path: "./slot-none.ts" }, liveAreaSlots: [SLOT_ENTRY] },
    })
    writeFileSync(join(dir, "slot-none.ts"), "export const x = 1")
    const { ui, logs } = await boot()
    expect(ui.liveAreaSlots.map((s) => s.definition.id)).toEqual(["probe_slot"])
    expect(logs.some((l) => l.includes("ui.setup") && l.includes("no default export"))).toBe(true)
  })

  it("loads no ui part for a plugin that core did not accept", async () => {
    writePlugin("off-probe", { headless: {}, ui: { liveAreaSlots: [SLOT_ENTRY] } })
    const { ui } = await boot(["off-probe"])
    expect(ui.liveAreaSlots).toEqual([])
  })

  it("skips a malformed ui slot and keeps the others", async () => {
    writePlugin("bad-probe", {
      headless: {},
      ui: {
        liveAreaSlots: [
          { id: "Bad ID!", handler: { type: "module", path: "./slot.ts" } },
          SLOT_ENTRY,
        ],
      },
    })
    const { ui, logs } = await boot()
    expect(ui.liveAreaSlots.map((s) => s.definition.id)).toEqual(["probe_slot"])
    expect(logs.some((l) => l.includes("live-area slot skipped"))).toBe(true)
  })
})
