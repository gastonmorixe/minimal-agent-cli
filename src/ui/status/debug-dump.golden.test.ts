/**
 * Byte-for-byte golden test of the `--debug` TUI request dump.
 *
 * The golden files in `__golden__/debug-dump/` hold the RAW ANSI output of
 * `renderDumpBlock` (lines joined with `\n`, plus a final `\n`, the same
 * bytes the live wiring writes). They were recorded against the renderer
 * that parsed the core text rows (with `DEBUG=1`), BEFORE it moved to the
 * typed `llm.requestWillSend` event, so they prove that the move changed no
 * byte.
 *
 * Two inputs:
 *   - a synthetic request (`debug-dump.golden.fixtures.ts`) in compact form
 *     at several widths and in verbose form at several wrap widths;
 *   - the second request of a real `AgentCore` tool turn (core test
 *     provider, fake network client), compact and verbose, through the
 *     direct renderer and through the live wiring.
 *
 * Run with `UPDATE_GOLDEN=1` to write the files. Do not update a golden file
 * to make this test pass: a byte change must be a deliberate, reviewed fix.
 *
 * @module ui/status/debug-dump.golden.test
 */

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { AuthResult } from "@minimal-agent/core/host/auth"
import { clearModelRegistry, clearProviderRegistry } from "@minimal-agent/core/host/model-registry"
import { NetworkClient, NetworkResponse } from "@minimal-agent/core/host/network"
import { clearProviderPlugins } from "@minimal-agent/core/host/provider-plugin"
import {
  processRequestInspector,
  type RequestSnapshot,
} from "@minimal-agent/core/host/request-inspector"
import { describeSystemBlock } from "@minimal-agent/core/host/system-block-origins"
import { makeCharRatioEstimator } from "@minimal-agent/core/plugin-api/llm/token-estimate"
import { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import {
  registerTestProvider,
  sseBodyFromEvents,
} from "@minimal-agent/core/testing/provider-fixture"

import { type DumpView, dumpView } from "../../logging/request-dump-model.ts"
import {
  CORE_VARIANTS,
  GOLDEN_SNAPSHOT,
  type GoldenVariant,
  goldenOrigins,
  SYNTH_VARIANTS,
} from "./debug-dump.golden.fixtures.ts"
import { renderDumpBlock } from "./debug-dump.ts"
import { attachRequestDumpRenderer } from "./debug-dump-live.ts"
import type { DumpOriginSource } from "./debug-dump-origins.ts"

const GOLDEN_DIR = join(import.meta.dir, "__golden__", "debug-dump")
const UPDATE = process.env.UPDATE_GOLDEN === "1"

/** Compare `actual` with one golden file, or write it under `UPDATE_GOLDEN=1`. */
function golden(file: string, actual: string): void {
  const path = join(GOLDEN_DIR, file)
  if (UPDATE) {
    mkdirSync(GOLDEN_DIR, { recursive: true })
    writeFileSync(path, actual)
    return
  }
  expect(existsSync(path)).toBe(true)
  // Compare bytes, not decoded text: an invalid UTF-16 half must not hide.
  expect(Buffer.from(actual, "utf8").equals(readFileSync(path))).toBe(true)
  expect(actual).toBe(readFileSync(path, "utf8"))
}

// ---------------------------------------------------------------------------
// Adapter: the ONLY part of this file that follows the renderer API.
// ---------------------------------------------------------------------------

/** Build the typed view of one request. */
function blockFromSnapshot(snap: RequestSnapshot, verbose: boolean): DumpView {
  return dumpView(snap, { lines: verbose })
}

/** Render one input as the bytes the live wiring writes. */
function renderBytes(
  input: DumpView,
  v: GoldenVariant,
  origins: DumpOriginSource | undefined,
): string {
  const lines = renderDumpBlock(input, v.width, {
    enabled: v.verbose,
    ...(origins === undefined ? {} : { origins }),
    ...(v.wrapWidth === undefined ? {} : { wrapWidth: v.wrapWidth }),
  })
  return `${lines.join("\n")}\n`
}

/**
 * Run one real AgentCore tool turn and give each request as a view.
 *
 * `DEBUG` and `VERBOSE` are UNSET: the typed channel needs no env var.
 */
async function captureCoreRequests(verbose: boolean): Promise<DumpView[]> {
  const saved = { DEBUG: process.env.DEBUG, VERBOSE: process.env.VERBOSE }
  delete process.env.DEBUG
  delete process.env.VERBOSE
  const views: DumpView[] = []
  // The snapshot is valid only during the call: build the view inside it.
  const off = processRequestInspector().subscribe((e) => {
    views.push(dumpView(e.request, { lines: verbose, ts: e.ts }))
  })
  try {
    await runTurn()
  } finally {
    off()
    restoreEnv(saved)
  }
  return views
}

/** Run one real AgentCore tool turn with the live wiring attached; give the painted text. */
async function captureLive(v: GoldenVariant, origins: DumpOriginSource): Promise<string[]> {
  const saved = { DEBUG: process.env.DEBUG, VERBOSE: process.env.VERBOSE }
  delete process.env.DEBUG
  delete process.env.VERBOSE
  const painted: string[] = []
  const live = attachRequestDumpRenderer({
    inspector: processRequestInspector(),
    write: (t) => painted.push(t),
    width: () => v.width,
    wrapWidth: () => v.wrapWidth,
    verbose: () => v.verbose,
    origins,
  })
  try {
    await runTurn()
  } finally {
    live.dispose()
    restoreEnv(saved)
  }
  return painted
}

// ---------------------------------------------------------------------------
// The real AgentCore turn (same setup as `debug-dump.e2e-core.test.ts`).
// ---------------------------------------------------------------------------

type CanonicalEvents = Parameters<typeof sseBodyFromEvents>[0]

const MODEL = "test-model-1"
const PROVIDER = "test-prov"
/** The explicit test estimator: 3.5 chars for each token. */
const TEST_ESTIMATOR = makeCharRatioEstimator(3.5)
const AUTH: AuthResult = { type: "provider", auth: { kind: "api-key", key: "test-token" } }

const SESSION_CONTEXT = [
  '<ma::sys::context name="environment">',
  "Host snapshot:",
  "    cwd=/work/repo",
  "    shell=fish",
  "",
  "End of snapshot.",
  "</ma::sys::context>",
].join("\n")

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

async function runTurn(): Promise<void> {
  const core = new AgentCore({
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
    toolExecutor: { execute: async () => ({ content: "README.md\nsrc", isError: false }) },
    promptContributors: [{ systemPromptBlocks: () => [{ type: "text", text: SESSION_CONTEXT }] }],
    systemPromptOverrides: {
      identity: { kind: "replace", text: "You are a test agent." },
      instructions: { kind: "omit" },
      toolOutputConventions: { kind: "omit" },
    },
    retry: { clock: { now: () => Date.now(), sleep: async () => {} }, random: () => 0 },
  })
  const gen = core.run("fix this:\n    indented line")
  while (!(await gen.next()).done) {
    // drain
  }
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

beforeEach(() => {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
  // An explicit test estimator for the core model and the synthetic model,
  // so the goldens show `~N tok`. Core has no ratio of its own.
  registerTestProvider({
    id: PROVIDER,
    models: [
      { id: MODEL, estimateTokens: TEST_ESTIMATOR },
      { id: GOLDEN_SNAPSHOT.model ?? "", estimateTokens: TEST_ESTIMATOR },
    ],
  })
  // The header shows the local event time (`HH:MM:SS`). Freeze the clock at
  // a LOCAL wall time, so the header is `14:43:26` in each time zone. Do not
  // change `process.env.TZ`: Bun keeps the zone for the full process, and a
  // write here changes the zone for the test files that run after this file.
  setSystemTime(new Date(2026, 0, 2, 14, 43, 26))
})

afterEach(() => {
  setSystemTime()
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("debug dump golden: synthetic request", () => {
  for (const v of SYNTH_VARIANTS) {
    it(v.name, () => {
      const input = blockFromSnapshot(GOLDEN_SNAPSHOT, v.verbose)
      golden(`synthetic.${v.name}.ansi`, renderBytes(input, v, goldenOrigins()))
    })
  }

  it("no token estimator: bytes only", () => {
    clearModelRegistry()
    const v: GoldenVariant = { name: "compact-w80-no-estimator", verbose: false, width: 80 }
    golden(
      `synthetic.${v.name}.ansi`,
      renderBytes(blockFromSnapshot(GOLDEN_SNAPSHOT, false), v, goldenOrigins()),
    )
  })

  it("verbose without origins", () => {
    const v: GoldenVariant = { name: "verbose-no-origins", verbose: true, wrapWidth: 100 }
    golden(
      `synthetic.${v.name}.ansi`,
      renderBytes(blockFromSnapshot(GOLDEN_SNAPSHOT, true), v, undefined),
    )
  })
})

describe("debug dump golden: real AgentCore request", () => {
  const origins = goldenOrigins(describeSystemBlock)

  for (const v of CORE_VARIANTS) {
    it(v.name, async () => {
      const inputs = await captureCoreRequests(v.verbose)
      expect(inputs).toHaveLength(2)
      golden(`core.${v.name}.ansi`, renderBytes(inputs[1] as DumpView, v, origins))
    }, 20_000)
  }

  for (const v of CORE_VARIANTS.filter((x) => x.name === "compact-w80" || x.verbose)) {
    it(`live wiring paints the same bytes: ${v.name}`, async () => {
      const painted = await captureLive(v, origins)
      expect(painted).toHaveLength(2)
      golden(`core.${v.name}.ansi`, painted[1] ?? "")
    }, 20_000)
  }
})
