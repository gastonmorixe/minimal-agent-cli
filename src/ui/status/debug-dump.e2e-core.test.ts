/**
 * Core-to-CLI proof of the `--debug --verbose` request dump.
 *
 * A real `AgentCore` runs one tool turn over the real canonical transport
 * (core test provider, fake network client). The core producer
 * (`debugRequestOptions`) emits the dump rows on the process diagnostic bus.
 * The CLI collector and `renderDumpBlock` paint them. No row is hand-made.
 *
 * The second request of the turn has 3 messages (user text, assistant
 * `tool_use`, user `tool_result`), 2 system blocks (identity, a multi-line
 * session context), and 2 tools.
 *
 * Set `MA_DUMP_SAMPLE_DIR` to also write the ANSI-stripped renders as
 * `sample-verbose.txt` and `sample-compact.txt` in that directory.
 *
 * @module ui/status/debug-dump.e2e-core.test
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import type { AuthResult } from "@minimal-agent/core/host/auth"
import { getDiagnosticBus, Severity } from "@minimal-agent/core/host/diagnostics"
import { clearModelRegistry, clearProviderRegistry } from "@minimal-agent/core/host/model-registry"
import { NetworkClient, NetworkResponse } from "@minimal-agent/core/host/network"
import { clearProviderPlugins } from "@minimal-agent/core/host/provider-plugin"
import { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import {
  registerTestProvider,
  sseBodyFromEvents,
} from "@minimal-agent/core/testing/provider-fixture"

import { type DumpBlock, RequestDumpCollector, renderDumpBlock } from "./debug-dump.ts"
import { attachLiveAreaRequestDump } from "./debug-dump-live.ts"

type CanonicalEvents = Parameters<typeof sseBodyFromEvents>[0]

const MODEL = "test-model-1"
const PROVIDER = "test-prov"
const AUTH: AuthResult = { type: "provider", auth: { kind: "api-key", key: "test-token" } }
const WIDTH = 93

/** The multi-line session-context block: indented lines and one blank line. */
const SESSION_CONTEXT = [
  '<ma::sys::context name="environment">',
  "Host snapshot:",
  "    cwd=/work/repo",
  "    shell=fish",
  "",
  "End of snapshot.",
  "</ma::sys::context>",
].join("\n")

const USER_TEXT = "fix this:\n    indented line"
const TOOL_OUTPUT = "README.md\nsrc"

/** One canonical response stream. */
function stream(body: CanonicalEvents, stop: "tool_use" | "end_turn"): CanonicalEvents {
  return [
    {
      type: "message_start",
      messageId: `msg_${stop}`,
      modelId: MODEL,
      initialUsage: { inputTokens: 1, outputTokens: 0 },
    },
    ...body,
    { type: "message_delta", stopReason: stop, usage: { inputTokens: 1, outputTokens: 2 } },
    { type: "message_stop" },
  ]
}

const TOOL_CALL = stream(
  [
    { type: "tool_use_start", index: 0, id: "toolu_e2e_a1b2c3", name: "Read" },
    { type: "tool_use_input_delta", index: 0, partialJson: '{"file_path":"README.md"}' },
    { type: "tool_use_stop", index: 0 },
  ],
  "tool_use",
)

const DONE = stream(
  [
    { type: "text_start", index: 0 },
    { type: "text_delta", index: 0, text: "done" },
    { type: "text_stop", index: 0 },
  ],
  "end_turn",
)

/** A network client that answers the first request with a tool call, then text. */
function scriptedClient(): NetworkClient {
  let n = 0
  return new NetworkClient({
    primary: {
      id: "fake",
      request: async () =>
        new NetworkResponse({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          transport: { id: "fake", protocol: "h2" },
          body: sseBodyFromEvents(n++ === 0 ? TOOL_CALL : DONE),
        }),
    },
  })
}

function buildCore(): AgentCore {
  return new AgentCore({
    auth: AUTH,
    model: MODEL,
    providerId: PROVIDER,
    systemPrompt: "",
    maxTokens: 4096,
    networkClient: scriptedClient(),
    toolRegistry: {
      list: () => [
        {
          name: "Read",
          description: "Read a file.\n  Returns its text.",
          input_schema: { type: "object", properties: { file_path: { type: "string" } } },
        },
        {
          name: "Echo",
          description: "Echo the input back.",
          input_schema: { type: "object", properties: {} },
        },
      ],
    },
    toolExecutor: { execute: async () => ({ content: TOOL_OUTPUT, isError: false }) },
    promptContributors: [{ systemPromptBlocks: () => [{ type: "text", text: SESSION_CONTEXT }] }],
    // Keep the dump small: no instructions block.
    systemPromptOverrides: {
      instructions: { kind: "omit" },
      loopSafety: { kind: "omit" },
      toolOutputConventions: { kind: "omit" },
    },
    retry: { clock: { now: () => Date.now(), sleep: async () => {} }, random: () => 0 },
  })
}

/** Strip SGR escapes. */
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

/** Run one turn with DEBUG on and collect every finished dump block from the bus. */
async function runTurn(verbose: boolean): Promise<DumpBlock[]> {
  const saved = { DEBUG: process.env.DEBUG, VERBOSE: process.env.VERBOSE }
  process.env.DEBUG = "1"
  if (verbose) process.env.VERBOSE = "1"
  else delete process.env.VERBOSE
  const collector = new RequestDumpCollector()
  const blocks: DumpBlock[] = []
  const off = getDiagnosticBus().on(
    (e) => e.source === "transport.request-dump" && e.severity === Severity.Debug,
    (e) => {
      const done = collector.push(e.message, e.structuredData)
      if (done !== null) blocks.push(done)
    },
  )
  try {
    const gen = buildCore().run(USER_TEXT)
    while (!(await gen.next()).done) {
      // drain
    }
  } finally {
    off()
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  return blocks
}

/** The gutter number of a verbose line, or undefined. */
const gutter = (line: string): number | undefined => {
  const m = /^ {9} *(\d+) │/.exec(line)
  return m === null ? undefined : Number(m[1])
}

beforeEach(() => {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
  registerTestProvider({ id: PROVIDER, models: [{ id: MODEL }] })
})

afterEach(() => {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
})

describe("request dump: real core producer to CLI renderer", () => {
  it("verbose: real lines, a gutter per part, kept indentation, #N, tool names", async () => {
    // The live wiring with its default core `describeSystemBlock`.
    const painted: string[] = []
    const live = attachLiveAreaRequestDump(
      { writeStream: (t) => painted.push(t) },
      { origins: { loadedPackages: () => [] }, wrapWidth: () => WIDTH },
    )
    let blocks: DumpBlock[]
    try {
      blocks = await runTurn(true)
    } finally {
      live.dispose()
    }
    expect(blocks).toHaveLength(2)
    expect(painted).toHaveLength(2)

    const lines = strip(painted[1] ?? "")
      .replace(/\n$/, "")
      .split("\n")
    const out = lines.join("\n")

    // (a) Real line breaks, no collapse marker.
    expect(out).not.toContain("⏎")
    expect(lines).toContain("         1 │ fix this:")
    expect(lines).toContain("         2 │     indented line")

    // (b) The gutter restarts at 1 after each part header.
    const headers = lines.filter((l) => /^ {6}\S/.test(l))
    expect(headers.length).toBeGreaterThanOrEqual(7)
    let after = false
    let firsts = 0
    for (const l of lines) {
      if (/^ {6}\S/.test(l)) {
        after = true
        continue
      }
      const n = gutter(l)
      if (after && n !== undefined) {
        expect(n).toBe(1)
        firsts++
        after = false
      }
    }
    // 3 messages + 2 system blocks + 2 tools.
    expect(firsts).toBe(7)

    // (c) Indentation after the gutter is kept, also in the system block.
    expect(lines).toContain("         3 │     cwd=/work/repo")
    expect(lines).toContain("         5 │")
    expect(lines).toContain("         2 │   Returns its text.")

    // (d) Message numbers.
    expect(lines).toContain("      #1 user")
    expect(lines).toContain("      #2 assistant")
    expect(lines.some((l) => l.startsWith("      #3 user"))).toBe(true)

    // (e) The tool_result names the tool from the tool_use.
    expect(out).toContain("↳ tool_use · Read · #toolu_e2e_a1b2c3")
    expect(out).toContain("↳ tool_result · from tool_use Read #toolu_e2e_a1b2c3")

    // The default core `describeSystemBlock` gave the session-context slot.
    expect(out).toContain("↳ core · sessionContext")

    // The collector path gives the same text as the live path.
    const direct = renderDumpBlock(blocks[1] as DumpBlock, undefined, {
      origins: { loadedPackages: () => [] },
      wrapWidth: WIDTH,
    })
    expect(direct.map(strip)).toContain("      #1 user")

    const dir = process.env.MA_DUMP_SAMPLE_DIR
    if (dir) writeFileSync(join(dir, "sample-verbose.txt"), `${out}\n`)
  }, 20_000)

  it("non-verbose: no gutter, #N, every line fits the width", async () => {
    const blocks = await runTurn(false)
    expect(blocks).toHaveLength(2)
    const lines = renderDumpBlock(blocks[1] as DumpBlock, WIDTH).map(strip)
    const out = lines.join("\n")

    expect(lines.some((l) => gutter(l) !== undefined)).toBe(false)
    expect(out).not.toContain(" │ ")
    expect(lines.some((l) => l.startsWith("      #1 user"))).toBe(true)
    expect(lines.some((l) => l.startsWith("      #2 assistant"))).toBe(true)
    expect(lines.some((l) => l.startsWith("      #3 user"))).toBe(true)
    for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(WIDTH)

    const dir = process.env.MA_DUMP_SAMPLE_DIR
    if (dir) writeFileSync(join(dir, "sample-compact.txt"), `${out}\n`)
  }, 20_000)
})
