/**
 * End-to-end check of concurrent tool calls in the REPL (D11, decision A),
 * with REAL core waves: `InteractiveSession` runs a core `Session` with a
 * scripted model and a concurrency cap of 2. A temp plugin gives one
 * concurrency-safe tool that waits for `input.ms`. The model calls it twice
 * in one batch; call 1 waits longer, so it ends last.
 *
 * The transcript must show call 2's block first, then call 1's block, with
 * no row of one block inside the other. The tool call tracker (the live tool tree) must see
 * both calls run at the same time.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AuthResult } from "@minimal-agent/core/host/auth"
import { StatusBus } from "@minimal-agent/core/host/status-bus"
import type { BuildAgentCoreDeps } from "@minimal-agent/core/host-kit/build-agent-core"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { InteractiveSession } from "./interactive-session.ts"
import { createStatusPort } from "./startup/host-ports.ts"
import { textCoreDeps } from "./test-utils/text-fixture-providers.ts"
import type {
  TestSendParams as SendOptions,
  TestSendResult as StreamedResponse,
} from "./test-utils/transport-types.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const TOOL = "WaveProbe"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Write a plugin with one concurrency-safe tool. Returns the plugins dir. */
function writeWavePlugin(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-concurrent-waves-"))
  dirs.push(root)
  const pluginsDir = join(root, "plugins")
  const dir = join(pluginsDir, "wave-probe")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "wave-probe",
      name: "wave-probe",
      version: "0.1.0",
      description: "test",
      headless: {
        tools: [
          {
            id: "only",
            trigger: {
              type: "tool",
              tool: {
                name: TOOL,
                description: "d",
                input_schema: {
                  type: "object",
                  properties: { ms: { type: "number" }, tag: { type: "string" } },
                },
                explicitName: true,
                concurrencySafe: true,
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
    `export default async (ctx) => {
  const input = ctx.trigger.input
  await new Promise((r) => setTimeout(r, input.ms))
  return { kind: "tool_result", content: "body of " + input.tag }
}
`,
  )
  return pluginsDir
}

/** Round 1: two calls (call 1 slow, call 2 fast). Round 2 ends the turn. */
function scriptedSend(): BuildAgentCoreDeps["sendFn"] {
  let round = 0
  return async function* (_opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    round++
    if (round === 1) {
      return {
        blocks: [
          { type: "tool_use", id: "call-1", name: TOOL, input: { ms: 400, tag: "ONE" } },
          { type: "tool_use", id: "call-2", name: TOOL, input: { ms: 20, tag: "TWO" } },
        ],
        text: "",
        stopReason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 3 },
      } as StreamedResponse
    }
    yield "done"
    return {
      blocks: [{ type: "text", text: "done" }],
      text: "done",
      stopReason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 4 },
    } as StreamedResponse
  }
}

/** Record the most calls that were open, and the most that ran, at one time. */
function trackRunning(session: InteractiveSession): {
  maxRunning: number
  maxOpen: number
  /** The most calls that were queued (not started) at one time. */
  maxQueued: number
} {
  const seen = { maxRunning: 0, maxOpen: 0, maxQueued: 0 }
  const tracker = session.toolCallTracker()
  tracker.subscribe(() => {
    const open = tracker.openCalls()
    const running = open.filter((call) => call.state === "running").length
    seen.maxRunning = Math.max(seen.maxRunning, running)
    seen.maxOpen = Math.max(seen.maxOpen, open.length)
    seen.maxQueued = Math.max(seen.maxQueued, open.length - running)
  })
  return seen
}

describe("InteractiveSession: concurrent tool calls with real core waves", () => {
  it("shows call 2's block first, then call 1's block, and one group status row", async () => {
    const loader = await PluginLoader.load({
      roots: { embedded: [writeWavePlugin()] },
      logger: () => {},
    })
    const bus = new StatusBus()
    const labels: string[] = []
    bus.subscribe((label) => {
      if (label !== null) labels.push(label)
    })
    const transcript: string[] = []
    const session = await InteractiveSession.create({
      auth: AUTH,
      model: "test-model",
      sendFn: scriptedSend(),
      loader,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
      writeTranscript: (line) => transcript.push(line),
      statusPort: createStatusPort(bus),
      maxConcurrentToolCalls: 2,
      ...textCoreDeps(),
    })

    const seen = trackRunning(session)
    const gen = session.run("go")
    while (!(await gen.next()).done) {}

    // Call 2 ended first, so its block is first. Each block is whole: no
    // row of one call is inside the other block.
    expect(transcript.map((row) => stripAnsi(row))).toEqual([
      `\n  ╭ ◆ ${TOOL}  ms:20 · tag:TWO`,
      "  │",
      "  ╰ body of TWO",
      `\n  ╭ ◆ ${TOOL}  ms:400 · tag:ONE`,
      "  │",
      "  ╰ body of ONE",
    ])

    // The tool tree saw both calls run at the same time, and queued first.
    expect(seen.maxRunning).toBe(2)
    expect(seen.maxOpen).toBe(2)
    // `item_started` reached the REPL before any call ran: both were queued.
    expect(seen.maxQueued).toBe(2)
    // The run end leaves no open call and no tool row.
    expect(session.toolCallTracker().snapshot().running).toEqual([])
    expect(bus.current()).toBeNull()
  })

  it("cap 1 keeps today's serial order and rows: call 1 first, no group row", async () => {
    const loader = await PluginLoader.load({
      roots: { embedded: [writeWavePlugin()] },
      logger: () => {},
    })
    const bus = new StatusBus()
    const labels: string[] = []
    bus.subscribe((label) => {
      if (label !== null) labels.push(label)
    })
    const transcript: string[] = []
    const session = await InteractiveSession.create({
      auth: AUTH,
      model: "test-model",
      sendFn: scriptedSend(),
      loader,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
      writeTranscript: (line) => transcript.push(line),
      statusPort: createStatusPort(bus),
      maxConcurrentToolCalls: 1,
      ...textCoreDeps(),
    })

    const seen = trackRunning(session)
    const gen = session.run("go")
    while (!(await gen.next()).done) {}

    expect(transcript.map((row) => stripAnsi(row))).toEqual([
      `\n  ╭ ◆ ${TOOL}  ms:400 · tag:ONE`,
      "  │",
      "  ╰ body of ONE",
      `\n  ╭ ◆ ${TOOL}  ms:20 · tag:TWO`,
      "  │",
      "  ╰ body of TWO",
    ])
    // Cap 1: the calls never overlap, and the tool row is the plain one.
    expect(seen.maxRunning).toBe(1)
    expect(labels).toContain(`Running ${TOOL}`)
  })
})
