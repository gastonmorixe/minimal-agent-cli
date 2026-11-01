/**
 * The CLI static tool presentation map (S41): a plugin tool header shows
 * its icon live and on `--resume` replay. The live header of a tool with a
 * `headerKey` (Fetch) paints before its handler returns.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ToolFeedbackTracker } from "@minimal-agent/core/host-kit/feedback-tracker"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { ToolExecutorAdapter } from "@minimal-agent/core/host-kit/tool-executor-adapter"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { replayToScrollback } from "../session-replay.ts"
import * as TOOL_TRANSCRIPT_FORMAT from "../ui/tool-transcript/format.ts"
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
      presentation: TOOL_PRESENTATION,
      writeTranscript: (line) => transcript.push(line),
      loader,
      modeManager: null,
      blobStore: null,
      blobSkipTools: new Set(),
      feedbackTracker: new ToolFeedbackTracker(),
      transcriptFormatter: TOOL_TRANSCRIPT_FORMAT,
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
