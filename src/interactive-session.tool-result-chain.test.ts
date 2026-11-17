/**
 * Test E (spec v6.1 M0 exit): a plugin with one tool-result stage per phase
 * runs in the CLI. `InteractiveSession` builds its own `ToolExecutorAdapter`
 * (`interactive-session.ts`, `openInteractiveSession`) and passes only
 * `loader`. The adapter must get the tool-result chain and the frozen
 * sideband registry from the real `PluginLoader` by its loader fallback.
 *
 * The fixture plugin is written as split JSON into a temp dir (the plugin is
 * not under a plugin root, so no golden scenario loads it). Its stages log to
 * a CLI-only global, so this file does not share state with the core tests.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import type { AuthResult } from "@minimal-agent/core/host/auth"
import type { BuildAgentCoreDeps } from "@minimal-agent/core/host-kit/build-agent-core"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import type { Message } from "@minimal-agent/core/sdk/messages"

import { InteractiveSession } from "./interactive-session.ts"
import { textCoreDeps, textFixturesPresent } from "./test-utils/text-fixture-providers.ts"
import type {
  TestSendParams as SendOptions,
  TestSendResult as StreamedResponse,
} from "./test-utils/transport-types.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const PHASES = ["clamp", "pre-outcome", "post-blob", "final", "stamp"] as const
const KIND = "probe-mark"
const TOOL = "ProbeTool"
const CONTENT = "probe ok"
const LOG_KEY = "__cliChainProbeLog"

function phaseLog(): string[] {
  const g = globalThis as unknown as Record<string, string[] | undefined>
  g[LOG_KEY] ??= []
  return g[LOG_KEY]
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  ;(globalThis as unknown as Record<string, unknown>)[LOG_KEY] = []
})

/** Write the `chain-probe` package (split S31 manifest). Returns the plugins dir. */
function writeChainProbe(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-tool-result-chain-"))
  dirs.push(root)
  const pluginsDir = join(root, "plugins")
  const dir = join(pluginsDir, "chain-probe")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "chain-probe",
      name: "chain-probe",
      version: "0.1.0",
      description: "test",
      toolResultTransforms: { id: "probe", entry: "./transforms.ts" },
      sideband: [
        {
          kind: KIND,
          direction: "to-model",
          placement: "tool-result",
          attrs: {},
          body: "text",
          trust: "harness",
          summary: "probe mark",
        },
      ],
      headless: {
        tools: [
          {
            id: "only",
            trigger: {
              type: "tool",
              tool: {
                name: TOOL,
                description: "d",
                input_schema: { type: "object", properties: {} },
                explicitName: true,
              },
            },
            handler: { type: "module", path: "./h.ts", export: "default" },
            interactive: false,
          },
        ],
      },
    }),
  )
  writeFileSync(
    join(dir, "h.ts"),
    `export default async () => ({ kind: "tool_result", content: ${JSON.stringify(CONTENT)} })\n`,
  )
  writeFileSync(
    join(dir, "transforms.ts"),
    `const log = () => ((globalThis[${JSON.stringify(LOG_KEY)}] ??= []))
const stage = (phase) => ({
  phase,
  order: 0,
  transform: (s) => {
    log().push(phase)
    return phase === "stamp" ? { ...s, kind: ${JSON.stringify(KIND)} } : s
  },
})
export default ${JSON.stringify(PHASES)}.map(stage)
`,
  )
  return pluginsDir
}

/** Round 1 calls ProbeTool. Round 2 ends the turn. Captures each request. */
function scriptedSend(captured: Message[][]): BuildAgentCoreDeps["sendFn"] {
  let round = 0
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    captured.push(structuredClone(opts.messages) as Message[])
    round++
    if (round === 1) {
      return {
        blocks: [{ type: "tool_use", id: "call-1", name: TOOL, input: {} }],
        text: "",
        stopReason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 3 },
      } as StreamedResponse
    }
    yield "ok"
    return {
      blocks: [{ type: "text", text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 4 },
    } as StreamedResponse
  }
}

function toolResultOf(history: readonly Message[]) {
  for (const m of history) {
    if (typeof m.content === "string") continue
    for (const b of m.content) if (b.type === "tool_result") return b
  }
  return undefined
}

describe("InteractiveSession tool-result chain (test E, spec v6.1 M0)", () => {
  it("the CLI resolves the local core package", () => {
    const cliRoot = resolve(import.meta.dir, "..")
    const coreRoot = realpathSync(resolve(cliRoot, "../minimal-agent-core"))
    const resolved = realpathSync(
      Bun.resolveSync("@minimal-agent/core/host-kit/plugin-loader", cliRoot),
    )
    expect(resolved.startsWith(`${coreRoot}/`)).toBe(true)
    expect(dirname(resolved)).toBe(join(coreRoot, "src/host-public"))
  })

  it.skipIf(!textFixturesPresent())(
    "runs every phase stage and keeps the sideband mark in live history",
    async () => {
      const loader = await PluginLoader.load({
        roots: { embedded: [writeChainProbe()] },
        logger: () => {},
      })
      // The loader built the chain and the frozen registry (core boot).
      expect(loader.toolResultChain().map((e) => e.decl.phase)).toEqual([...PHASES])
      expect(loader.toolResultChain().every((e) => e.pluginId === "chain-probe")).toBe(true)
      expect(loader.sidebandRegistry().kind(KIND)?.owner).toBe("chain-probe")

      const captured: Message[][] = []
      const transcript: string[] = []
      const session = await InteractiveSession.create({
        auth: AUTH,
        model: "test-model",
        sendFn: scriptedSend(captured),
        loader,
        modeManager: null,
        store: null,
        blobStore: null,
        saveEcho: null,
        turnAttachments: [],
        writeTranscript: (line) => transcript.push(line),
        ...textCoreDeps(),
      })
      // The CLI passes the real loader object to its executor, not a copy.
      expect(session.pluginLoader()).toBe(loader)
      expect(session.pluginLoader()).toBeInstanceOf(PluginLoader)

      const gen = session.run("go")
      while (!(await gen.next()).done) {}

      expect(phaseLog()).toEqual([...PHASES])
      const block = toolResultOf(session.history())
      expect(block?.content).toBe(CONTENT)
      expect(block?.sideband).toEqual({ kind: KIND })

      // The second request carries the same tool_result content.
      expect(captured).toHaveLength(2)
      expect(toolResultOf(captured[1] ?? [])?.content).toBe(CONTENT)
    },
  )
})
