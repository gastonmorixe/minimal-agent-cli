/**
 * S38 + S39: the JSON route keeps stdout clean.
 *
 * - `--output-format json` stdout equals the events-jsonl golden, byte for
 *   byte (the same four lines core's `events-jsonl.integration.test.ts` pins).
 * - The stdout guard lets the JSON event lines through, and nothing else.
 *   A planted stray stdout write (or `console.log`) fails the run.
 * - `--diagnostics` writes only session log entries: each line has a `ch`
 *   field, and both `ch:"event"` and `ch:"diag"` lines appear.
 * - The sink plan attaches no scrollback sink in `protocol` mode, and
 *   `--debug` adds the stderr mirror there.
 *
 * @module startup/json-route-clean.test
 */

import { beforeEach, describe, expect, it } from "bun:test"
import { createRuntime, type Session } from "@minimal-agent/core"
import type { AuthResult } from "@minimal-agent/core/host/auth"
import type {
  ToolExecResult,
  ToolExecutor,
  ToolRegistry,
  TranscriptSink,
} from "@minimal-agent/core/sdk/ports"
import { resolveStdioMode } from "../cli/output-format.ts"
import type { ReplAgentLike } from "../repl.ts"
import type { TestStreamedResponse as StreamedResponse } from "../test-utils/transport-types.ts"

import { planDiagnosticSinks } from "./diagnostic-sinks.ts"
import {
  installJsonStdioGuard,
  type RunNonInteractivePromptInput,
  runNonInteractivePrompt,
  selectStdioMode,
} from "./run-non-interactive.ts"
import { resetStreamJsonWriterForTests } from "./stream-json-writer.ts"

beforeEach(() => resetStreamJsonWriterForTests())

/** The events-jsonl golden: a text-only turn "hi", usage 5 in / 2 out. */
const GOLDEN =
  '{"type":"turn_started","turn":1}\n' +
  '{"type":"item_started","itemType":"text","id":"1:0"}\n' +
  '{"type":"item_completed","itemType":"text","id":"1:0","text":"hi"}\n' +
  '{"type":"turn_completed","turn":1,"stopReason":"end_turn","usage":{"inputTokens":5,"outputTokens":2}}\n'

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const EMPTY_REGISTRY: ToolRegistry = { list: () => [] }

class StubExecutor implements ToolExecutor {
  async execute(): Promise<ToolExecResult> {
    return { content: "", isError: false }
  }
}

class DiscardTranscript implements TranscriptSink {
  write(): void {}
}

/** The part of the send options this file reads. */
interface SendOpts {
  readonly diagnostics?: { info: (source: string, message: string) => void }
}

/** Open a real `Session` whose one turn answers "hi". `during` runs inside the send. */
function openSession(during: (opts: SendOpts) => void = () => {}): Session {
  const sendFn = async function* (
    opts: SendOpts,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    during(opts)
    yield "hi"
    return {
      blocks: [{ type: "text" as const, text: "hi" }],
      text: "hi",
      stopReason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
    } as StreamedResponse
  }
  return createRuntime().openSession({
    auth: AUTH,
    model: "test-model",
    toolRegistry: EMPTY_REGISTRY,
    toolExecutor: new StubExecutor(),
    transcriptSink: new DiscardTranscript(),
    sendFn,
  })
}

/** A legacy agent that must never run on the event-stream route. */
function neverAgent(): ReplAgentLike {
  return {
    run(): never {
      throw new Error("legacy agent.run must not be called on the JSON route")
    },
  } as unknown as ReplAgentLike
}

interface RunCapture {
  readonly stdout: string
  readonly stderr: string
  readonly exitCodes: readonly number[]
  /** Whether a write made after the run reached the stub (guard removed). */
  readonly probeReached: boolean
}

/**
 * Run the json route with a capture stub in place of `process.stdout.write`.
 * The guard wraps the stub, so the stub sees only what passes the guard.
 */
async function runJson(
  session: () => Session,
  over: Partial<RunNonInteractivePromptInput> = {},
): Promise<RunCapture> {
  const original = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let stderr = ""
  const exitCodes: number[] = []
  const stub = ((chunk: unknown) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write
  process.stdout.write = stub
  let runStdout = ""
  try {
    await runNonInteractivePrompt({
      agent: neverAgent(),
      prompt: "go",
      formatterCmd: undefined,
      showHeader: false,
      wantJsonOutput: false,
      outputFormat: "json",
      outputSchema: undefined,
      loader: null,
      cwd: process.cwd(),
      openEventStreamSession: () => Promise.resolve(session()),
      stderr: (s) => {
        stderr += s
      },
      exit: ((code: number) => {
        exitCodes.push(code)
      }) as (code: number) => never,
      ...over,
    })
  } finally {
    runStdout = stdout
    process.stdout.write("probe")
    process.stdout.write = original
  }
  return { stdout: runStdout, stderr, exitCodes, probeReached: stdout.endsWith("probe") }
}

describe("S38: json route stdout guard", () => {
  it("json stdout equals the events-jsonl golden byte for byte", async () => {
    const run = await runJson(() => openSession())
    expect(run.stdout).toBe(GOLDEN)
    expect(run.exitCodes).toEqual([])
    expect(run.stderr).toBe("")
  })

  it("a planted stray stdout write fails the run and never reaches stdout", async () => {
    const run = await runJson(() =>
      openSession(() => {
        process.stdout.write("a human line\n")
      }),
    )
    // The JSON event lines still pass the guard.
    expect(run.stdout).toBe(GOLDEN)
    expect(run.stdout).not.toContain("a human line")
    expect(run.exitCodes).toEqual([1])
    expect(run.stderr).toContain("dropped 1 stray stdout write")
  })

  it("a planted console.log fails the run too", async () => {
    const run = await runJson(() =>
      openSession(() => {
        // biome-ignore lint/suspicious/noConsole: the planted stray write under test.
        console.log("a human line")
      }),
    )
    expect(run.stdout).toBe(GOLDEN)
    expect(run.exitCodes).toEqual([1])
  })

  it("the run removes the guard it installed", async () => {
    const run = await runJson(() => openSession())
    expect(run.probeReached).toBe(true)
  })

  it("a guard the host installed at boot stays in place after the run", async () => {
    const original = process.stdout.write.bind(process.stdout)
    let stdout = ""
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk)
      return true
    }) as typeof process.stdout.write
    const guard = installJsonStdioGuard()
    try {
      process.stdout.write("startup noise\n")
      await runNonInteractivePrompt({
        agent: neverAgent(),
        prompt: "go",
        formatterCmd: undefined,
        showHeader: false,
        wantJsonOutput: false,
        outputFormat: "json",
        outputSchema: undefined,
        loader: null,
        cwd: process.cwd(),
        openEventStreamSession: () => Promise.resolve(openSession()),
        stderr: () => {},
        exit: ((_code: number) => {}) as (code: number) => never,
      })
      expect(installJsonStdioGuard()).toBe(guard)
      expect(guard.strays()).toBe(1)
    } finally {
      guard.restore()
      process.stdout.write = original
    }
    expect(stdout).toBe(GOLDEN)
  })
})

describe("S39: --diagnostics on the json route", () => {
  const withDiag = (): Session =>
    openSession((opts) => opts.diagnostics?.info("test.diag", "a session diagnostic"))

  it("writes only lines with a ch field, with both event and diag lines", async () => {
    const run = await runJson(withDiag, { diagnostics: true })
    const lines = run.stdout
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => l.v === 1 && (l.ch === "event" || l.ch === "diag"))).toBe(true)
    expect(lines.some((l) => l.ch === "diag")).toBe(true)
    expect(lines.some((l) => l.ch === "event")).toBe(true)
    const diag = lines.find((l) => l.ch === "diag")
    expect(diag?.data).toMatchObject({ code: "test.diag", message: "a session diagnostic" })
    // The event lines hold the same kept events as the golden.
    const events = lines.filter((l) => l.ch === "event").map((l) => JSON.stringify(l.data))
    expect(`${events.join("\n")}\n`).toBe(GOLDEN)
    expect(run.exitCodes).toEqual([])
  })

  it("without the flag, stdout still equals the golden when diagnostics fire", async () => {
    const run = await runJson(withDiag)
    expect(run.stdout).toBe(GOLDEN)
  })
})

describe("S38: sink plan by stdio mode", () => {
  const env = {}

  it("protocol mode attaches no scrollback sink and no mirror", () => {
    expect(planDiagnosticSinks({ showHeader: false, env, mode: "protocol" })).toEqual({
      scrollback: false,
      stderrMirror: false,
    })
  })

  it("--debug mirrors diagnostics to stderr in protocol and print mode", () => {
    for (const mode of ["protocol", "print"] as const) {
      expect(planDiagnosticSinks({ showHeader: false, env, mode, debug: true }).stderrMirror).toBe(
        true,
      )
    }
  })

  it("the REPL keeps the scrollback sink and gets no raw mirror from --debug", () => {
    expect(
      planDiagnosticSinks({ showHeader: true, env, mode: "interactive", debug: true }),
    ).toEqual({ scrollback: true, stderrMirror: false })
  })

  it("MINIMAL_AGENT_LOG_STDERR=1 still adds the mirror in every mode", () => {
    const logEnv = { MINIMAL_AGENT_LOG_STDERR: "1" }
    for (const mode of ["protocol", "print", "interactive"] as const) {
      expect(planDiagnosticSinks({ showHeader: false, env: logEnv, mode }).stderrMirror).toBe(true)
    }
  })

  it("resolveStdioMode picks protocol for json, stream-json, and host mode", () => {
    const at = (
      outputFormat: "text" | "json" | "stream-json",
      hostMode: boolean,
      hasPrompt: boolean,
    ) => resolveStdioMode({ outputFormat, hostMode, hasPrompt })
    expect(at("json", false, true)).toBe("protocol")
    expect(at("stream-json", false, true)).toBe("protocol")
    expect(at("text", true, false)).toBe("protocol")
    expect(at("text", false, true)).toBe("print")
    expect(at("text", false, false)).toBe("interactive")
    expect(at("json", false, false)).toBe("interactive")
  })
})

describe("S38: selectStdioMode at boot", () => {
  const json = { outputFormat: "json" as const, outputSchemaPath: undefined }

  it("installs the guard on the JSON event route", () => {
    expect(selectStdioMode(["--prompt", "go"], "agent", json)).toBe("protocol")
    const guard = installJsonStdioGuard()
    try {
      process.stdout.write("")
      expect(guard.strays()).toBe(1)
    } finally {
      guard.restore()
    }
  })

  it("installs no guard for --host-mode, --output-schema, or the REPL", () => {
    const original = process.stdout.write.bind(process.stdout)
    let seen = ""
    process.stdout.write = ((chunk: unknown) => {
      seen += String(chunk)
      return true
    }) as typeof process.stdout.write
    try {
      expect(selectStdioMode(["--host-mode", "acp"], "host-mode", json)).toBe("protocol")
      const schema = { ...json, outputSchemaPath: "s.json" }
      expect(selectStdioMode(["--prompt", "go"], "agent", schema)).toBe("protocol")
      expect(selectStdioMode([], "agent", json)).toBe("interactive")
      // With no guard in place, a plain write still reaches stdout.
      process.stdout.write("still open")
    } finally {
      process.stdout.write = original
    }
    expect(seen).toBe("still open")
  })
})
