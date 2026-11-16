/**
 * The CLI static tool presentation map (S41): a plugin tool header shows
 * its icon live and on `--resume` replay. The live header of a tool with a
 * `headerKey` (Fetch) paints before its handler returns.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BUILTIN_TOOL_NAMES } from "@minimal-agent/core/host/tool-catalog"
import { ToolFeedbackTracker } from "@minimal-agent/core/host-kit/feedback-tracker"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { ToolExecutorAdapter } from "@minimal-agent/core/host-kit/tool-executor-adapter"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { replayToScrollback } from "../session-replay.ts"
import { SIBLING_REPO_ROOT, siblingRepoPresent } from "../test-utils/sibling-repo.ts"
import { DEFAULT_TOOL_ICON, formatToolHeaderRows } from "../ui/tool-transcript/format.ts"
import { createReplToolView } from "../ui/tool-transcript/tool-view.ts"
import { startupToolEntries } from "./startup-tool-entries.ts"
import { TOOL_PRESENTATION, toolPresentationMap } from "./tool-presentation.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A plugin that registers a slow `Fetch` tool. It returns when `release` exists. */
function writeFetchPlugin(): { pluginsDir: string; release: string } {
  const root = mkdtempSync(join(tmpdir(), "cli-tool-presentation-"))
  dirs.push(root)
  const pluginsDir = join(root, "plugins")
  const dir = join(pluginsDir, "fetch-probe")
  mkdirSync(dir, { recursive: true })
  const release = join(root, "release")
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "fetch-probe",
      name: "fetch-probe",
      version: "0.1.0",
      description: "t",
      headless: {
        tools: [
          {
            id: "fetch",
            trigger: {
              type: "tool",
              tool: {
                name: "Fetch",
                description: "probe",
                input_schema: { type: "object", properties: { url: { type: "string" } } },
                explicitName: true,
              },
            },
            handler: { type: "module", path: "./fetch.ts", export: "default" },
            interactive: false,
          },
        ],
      },
    }),
  )
  writeFileSync(
    join(dir, "fetch.ts"),
    `import { existsSync } from "node:fs"
export default async () => {
  while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5)
  return { kind: "tool_result", content: "page text" }
}`,
  )
  return { pluginsDir, release }
}

describe("CLI tool presentation map (S41)", () => {
  it("has the icon, color, and header key of the Fetch tool", () => {
    expect(TOOL_PRESENTATION.get("Fetch")).toEqual({ icon: "⤓", color: "sky", headerKey: "url" })
    expect(toolPresentationMap()).not.toBe(toolPresentationMap())
  })

  it("paints the live Fetch header with its icon before the handler returns", async () => {
    const { pluginsDir, release } = writeFetchPlugin()
    const loader = await PluginLoader.load({ roots: { embedded: [pluginsDir] }, logger: () => {} })
    const transcript: string[] = []
    const executor = new ToolExecutorAdapter({
      toolView: createReplToolView({
        writeTranscript: (line) => transcript.push(line),
        presentation: TOOL_PRESENTATION,
      }),
      loader,
      modeManager: null,
      blobStore: null,
      blobSkipTools: new Set(),
      feedbackTracker: new ToolFeedbackTracker(),
      model: "test-model",
    })
    const run = executor.execute({
      type: "tool_use",
      id: "fetch-1",
      name: "Fetch",
      input: { url: "https://example.com/a" },
    })
    const deadline = Date.now() + 5000
    while (!transcript.join("").includes("Fetch") && Date.now() < deadline) await Bun.sleep(5)
    const early = stripAnsi(transcript.join(""))
    expect(early).toMatch(/╭ ⤓ Fetch\s+https:\/\/example\.com\/a/)
    writeFileSync(release, "")
    const result = await run
    expect(result.content).toBe("page text")
  })

  it("replays the Fetch header with its icon on --resume", async () => {
    const out: string[] = []
    await replayToScrollback(
      [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "f1", name: "Fetch", input: { url: "https://example.com/a" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "f1", content: "page" }] },
      ],
      { write: (s: string) => out.push(s) },
      { toolPresentation: toolPresentationMap() },
    )
    expect(stripAnsi(out.join(""))).toMatch(/╭ ⤓ Fetch\s+https:\/\/example\.com\/a/)
  })
})

/**
 * Regression: S29 dropped `icon`/`color` from the core `ToolDefinition`, and
 * S41 rebuilt the map for plugin tools only. So the core built-ins (Bash,
 * Read, Write, Edit, Glob, Grep, FilesStats, Mode) lost the icon in the
 * `╭` header. These checks keep every core built-in in the map.
 */
describe("CLI tool presentation map covers the core built-in tools", () => {
  /** The glyphs the built-ins had in core before S29 (core 65b832d). */
  const BUILT_IN_ICONS: Readonly<Record<string, string>> = {
    Bash: "»",
    Read: "•",
    Write: "✚",
    Edit: "✦",
    Glob: "✱",
    Grep: "⌕",
    FilesStats: "▦",
    Mode: "◐",
  }

  it("has a row with an icon and a color for every core built-in tool", () => {
    const names = BUILTIN_TOOL_NAMES
    expect(names.length).toBeGreaterThan(0)
    const missing = names.filter(
      (n) => !TOOL_PRESENTATION.get(n)?.icon || !TOOL_PRESENTATION.get(n)?.color,
    )
    expect(missing).toEqual([])
  })

  it("keeps the pre-S29 glyph of each core built-in tool", () => {
    for (const [name, icon] of Object.entries(BUILT_IN_ICONS)) {
      expect(TOOL_PRESENTATION.get(name)?.icon).toBe(icon)
    }
  })

  it("paints the live header of each built-in tool with its icon", () => {
    for (const [name, icon] of Object.entries(BUILT_IN_ICONS)) {
      const rows = formatToolHeaderRows({
        tool: { type: "tool_use", id: "b1", name, input: { command: "ls" } },
        presentation: TOOL_PRESENTATION.get(name),
      })
      expect(stripAnsi(rows.join("\n"))).toContain(`╭ ${icon} ${name}`)
    }
  })

  it("replays the header of each built-in tool with its icon on --resume", async () => {
    for (const [name, icon] of Object.entries(BUILT_IN_ICONS)) {
      const out: string[] = []
      await replayToScrollback(
        [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "b1", name, input: { command: "ls" } }],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "ok" }] },
        ],
        { write: (s: string) => out.push(s) },
        { toolPresentation: toolPresentationMap() },
      )
      expect(stripAnsi(out.join(""))).toContain(`╭ ${icon} ${name}`)
    }
  })
})

/**
 * Regression: every tool header shows an icon. A tool with no map row (a
 * user plugin, an alias) gets DEFAULT_TOOL_ICON, never the bare name.
 */
describe("every tool header has an icon", () => {
  it("draws the default icon for a tool with no map row", () => {
    expect(TOOL_PRESENTATION.has("UnknownProbe")).toBe(false)
    const rows = formatToolHeaderRows({
      tool: { type: "tool_use", id: "u1", name: "UnknownProbe", input: {} },
      presentation: TOOL_PRESENTATION.get("UnknownProbe"),
    })
    expect(stripAnsi(rows[0] ?? "")).toContain(`╭ ${DEFAULT_TOOL_ICON} UnknownProbe`)
  })

  it("draws the default icon for a row with no icon", () => {
    const rows = formatToolHeaderRows({
      tool: { type: "tool_use", id: "u2", name: "NoIcon", input: {} },
      presentation: { color: "sky" },
    })
    expect(stripAnsi(rows[0] ?? "")).toContain(`╭ ${DEFAULT_TOOL_ICON} NoIcon`)
  })

  it("replays an unknown tool header with the default icon on --resume", async () => {
    const out: string[] = []
    await replayToScrollback(
      [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "u3", name: "UnknownProbe", input: {} }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u3", content: "ok" }] },
      ],
      { write: (s: string) => out.push(s) },
      { toolPresentation: toolPresentationMap() },
    )
    expect(stripAnsi(out.join(""))).toContain(`╭ ${DEFAULT_TOOL_ICON} UnknownProbe`)
  })

  it("gives every startup row entry an icon, also for an unknown tool", () => {
    const entries = startupToolEntries([{ name: "Bash" }, { name: "UnknownProbe" }])
    expect(entries).toEqual([
      { name: "Bash", icon: "»", color: "orange" },
      { name: "UnknownProbe", icon: DEFAULT_TOOL_ICON },
    ])
  })

  it("gives every map row its own icon and a color", () => {
    const bad = [...TOOL_PRESENTATION].filter(([, p]) => !p.icon || !p.color).map(([n]) => n)
    expect(bad).toEqual([])
  })
})

/** The fields of a plugin manifest that set its canonical tool names. */
type ManifestTools = {
  id?: unknown
  name?: unknown
  camelName?: unknown
  headless?: { tools?: unknown }
}

/** Plugin id and canonical tool names of each sibling `ma-*` manifest. */
function shippedTools(): { pluginId: string; tools: string[] }[] {
  const out: { pluginId: string; tools: string[] }[] = []
  for (const dir of readdirSync(SIBLING_REPO_ROOT)
    .filter((d) => d.startsWith("ma-"))
    .sort()) {
    let raw: string
    try {
      raw = readFileSync(join(SIBLING_REPO_ROOT, dir, "manifest.json"), "utf8")
    } catch {
      continue // A provider plugin (provider.json) or a kit: no tools.
    }
    const m: ManifestTools = JSON.parse(raw)
    const name = typeof m.name === "string" ? m.name : ""
    // Same rule as the core loader (computeEffectiveName): an explicit name
    // passes unchanged. Otherwise the CamelCase plugin name is the prefix.
    const prefix =
      typeof m.camelName === "string"
        ? m.camelName
        : name
            .split(/[\s-]+/)
            .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
            .join("")
    const tools: string[] = []
    const entries: unknown[] = Array.isArray(m.headless?.tools) ? m.headless.tools : []
    for (const entry of entries) {
      const tool: unknown = Reflect.get(Object(Reflect.get(Object(entry), "trigger")), "tool")
      const toolName: unknown = Reflect.get(Object(tool), "name")
      if (typeof toolName !== "string") continue
      const explicit = Reflect.get(Object(tool), "explicitName") === true
      tools.push(explicit ? toolName : `${prefix}${toolName}`)
    }
    out.push({ pluginId: typeof m.id === "string" ? m.id : dir, tools })
  }
  return out
}

describe.skipIf(!siblingRepoPresent())(
  "CLI tool presentation map covers the shipped plugins",
  () => {
    it("has a row for every tool in every plugin manifest", () => {
      const shipped = shippedTools().flatMap((p) => p.tools)
      expect(shipped.length).toBeGreaterThan(30)
      const missing = shipped.filter((n) => !TOOL_PRESENTATION.has(n))
      expect(missing).toEqual([])
    })

    it("has no row for a tool that no plugin or core ships", () => {
      const shipped = new Set([...shippedTools().flatMap((p) => p.tools), ...BUILTIN_TOOL_NAMES])
      const stale = [...TOOL_PRESENTATION.keys()].filter((n) => !shipped.has(n))
      expect(stale).toEqual([])
    })

    it("derives the same canonical names as the core loader", async () => {
      // The loader skips plugins that are off by default or on another
      // platform. Check the name rule on the plugins that it loads.
      const loader = await PluginLoader.load({
        roots: { embedded: [SIBLING_REPO_ROOT] },
        logger: () => {},
      })
      const loaded = new Set(loader.loadedPluginIds())
      const checked = shippedTools().filter((p) => loaded.has(p.pluginId))
      expect(checked.length).toBeGreaterThan(10)
      for (const p of checked) {
        for (const tool of p.tools)
          expect({ tool, known: loader.hasTool(tool) }).toEqual({ tool, known: true })
      }
    })
  },
)
