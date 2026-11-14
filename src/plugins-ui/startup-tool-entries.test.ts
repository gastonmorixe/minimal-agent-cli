/**
 * The startup tree `tools` row shows the icon of each plugin tool.
 *
 * Regression: after S29/S31 core tool definitions carry no icon or color.
 * The banner still passed the core tool list straight to the row formatter,
 * so every tool rendered as a bare name. The CLI must decorate the list from
 * its own presentation map (S41), the same map the transcript uses. A tool
 * with no map row (or no icon) gets DEFAULT_TOOL_ICON.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { formatStartupToolsRow } from "../ui/chrome/startup-tools-row.ts"
import { setStartupTreeVisible } from "../ui/startup/tree.ts"
import { DEFAULT_TOOL_ICON } from "../ui/tool-transcript/format.ts"
import { closeStartupTreeWithLoadedTools, startupToolEntries } from "./startup-tool-entries.ts"
import { TOOL_PRESENTATION } from "./tool-presentation.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One plugin with two explicit-name tools: `Fetch` (in the map) and `Probe` (not in it). */
function writePlugin(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-startup-tools-"))
  dirs.push(root)
  const dir = join(root, "plugins", "probe")
  mkdirSync(dir, { recursive: true })
  const tool = (name: string) => ({
    id: name.toLowerCase(),
    trigger: {
      type: "tool",
      tool: {
        name,
        description: "probe",
        input_schema: { type: "object", properties: {} },
        explicitName: true,
      },
    },
    handler: { type: "module", path: "./h.ts", export: "default" },
    interactive: false,
  })
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "probe",
      name: "probe",
      version: "0.1.0",
      description: "t",
      headless: { tools: [tool("Fetch"), tool("Probe")] },
    }),
  )
  writeFileSync(
    join(dir, "h.ts"),
    `export default async () => ({ kind: "tool_result", content: "ok" })`,
  )
  return join(root, "plugins")
}

describe("startup tools row presentation (S41)", () => {
  it("core tool definitions carry no icon or color (the decoupling contract)", async () => {
    const loader = await PluginLoader.load({
      roots: { embedded: [writePlugin()] },
      logger: () => {},
    })
    for (const t of loader.getExtraTools()) {
      expect(Object.keys(t).sort()).toEqual(["description", "input_schema", "name"])
    }
  })

  it("decorates loader tools with the CLI icon and color, default icon otherwise", async () => {
    const loader = await PluginLoader.load({
      roots: { embedded: [writePlugin()] },
      logger: () => {},
    })
    const entries = startupToolEntries(loader.getExtraTools())
    const fetch = TOOL_PRESENTATION.get("Fetch")
    expect(entries).toEqual([
      { name: "Fetch", icon: fetch?.icon, color: fetch?.color },
      { name: "Probe", icon: DEFAULT_TOOL_ICON },
    ])
    expect(stripAnsi(formatStartupToolsRow(entries) ?? "")).toBe(
      `⤓ Fetch · ${DEFAULT_TOOL_ICON} Probe`,
    )
  })

  it("takes an explicit presentation map", () => {
    const map = new Map([["Probe", { icon: "*", color: "lime" }]])
    expect(startupToolEntries([{ name: "Probe" }, { name: "Fetch" }], map)).toEqual([
      { name: "Probe", icon: "*", color: "lime" },
      { name: "Fetch", icon: DEFAULT_TOOL_ICON },
    ])
  })

  it("never copies headerKey or other fields into a row entry", () => {
    const entries = startupToolEntries([{ name: "Fetch" }])
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual(["color", "icon", "name"])
  })

  describe("closeStartupTreeWithLoadedTools", () => {
    const printed: string[] = []
    const origError = console.error
    const close = (
      tools: { name: string }[],
      policy: Parameters<typeof closeStartupTreeWithLoadedTools>[1],
    ) => {
      printed.length = 0
      console.error = (line: unknown) => printed.push(stripAnsi(String(line)))
      setStartupTreeVisible(true)
      try {
        closeStartupTreeWithLoadedTools(tools, policy)
      } finally {
        console.error = origError
        setStartupTreeVisible(false)
      }
      return printed
    }

    it("prints the closing tools row with icons for the advertised tools", () => {
      const out = close([{ name: "Fetch" }, { name: "Probe" }], null)
      expect(out).toEqual([`  ╰ tools      ⤓ Fetch · ${DEFAULT_TOOL_ICON} Probe`])
    })

    it("applies the tool name policy before it prints", () => {
      const out = close([{ name: "Fetch" }, { name: "Probe" }], {
        kind: "allow-list",
        tools: ["Probe"],
      })
      expect(out).toEqual([`  ╰ tools      ${DEFAULT_TOOL_ICON} Probe`])
    })
  })
})
