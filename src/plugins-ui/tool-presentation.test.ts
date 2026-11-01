/**
 * The CLI static tool presentation map (S41): a plugin tool header shows
 * its icon live and on `--resume` replay. The live header of a tool with a
 * `headerKey` (Fetch) paints before its handler returns.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ToolFeedbackTracker } from "@minimal-agent/core/host-kit/feedback-tracker"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { ToolExecutorAdapter } from "@minimal-agent/core/host-kit/tool-executor-adapter"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { replayToScrollback } from "../session-replay.ts"
import { SIBLING_REPO_ROOT, siblingRepoPresent } from "../test-utils/sibling-repo.ts"
import { createReplToolView } from "../ui/tool-transcript/tool-view.ts"
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
 * Tools of the shipped plugins that keep the bare bold tool name on purpose.
 * They never had an icon in their manifests. Add a new tool here only when it
 * must have no icon. Otherwise add a row to TOOL_PRESENTATION.
 */
const BARE_TOOLS: ReadonlySet<string> = new Set([
  "ModelInfo",
  "SecurityStatus",
  "SessionHistory",
  "SessionInfo",
])

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
    it("has a row (or a BARE_TOOLS entry) for every tool in every plugin manifest", () => {
      const shipped = shippedTools().flatMap((p) => p.tools)
      expect(shipped.length).toBeGreaterThan(30)
      const missing = shipped.filter((n) => !TOOL_PRESENTATION.has(n) && !BARE_TOOLS.has(n))
      expect(missing).toEqual([])
    })

    it("has no row or BARE_TOOLS entry for a tool that no plugin ships", () => {
      const shipped = new Set(shippedTools().flatMap((p) => p.tools))
      const stale = [...TOOL_PRESENTATION.keys(), ...BARE_TOOLS].filter((n) => !shipped.has(n))
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
