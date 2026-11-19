/**
 * The `--debug` request dump subscriber of the startup sinks.
 *
 * - The plan adds it only with `--debug`, in every stdio mode.
 * - ZERO COST: without `--debug`, nothing subscribes to core's process
 *   request channel, so core builds no `llm.requestWillSend` event.
 *
 * Most tests call `attachRequestDumpSink` (the step that
 * `attachStartupDiagnosticSinks` runs). The tests of the full
 * `attachStartupDiagnosticSinks` inject a private bus and a private request
 * channel, so the file and global log sinks (no detach) never attach to the
 * process bus and do not leak into the other test files of the run.
 *
 * @module startup/diagnostic-sinks.request-dump.test
 */

import { describe, expect, it } from "bun:test"
import { createDiagnosticBus } from "@minimal-agent/core/host/diagnostics"
import {
  createRequestInspector,
  processRequestInspector,
  type RequestDiagnostics,
  type RequestWillSendEvent,
} from "@minimal-agent/core/host/request-inspector"

import { REQUEST_DUMP_SOURCE } from "../logging/request-dump-log.ts"
import {
  attachRequestDumpSink,
  attachStartupDiagnosticSinks,
  planDiagnosticSinks,
} from "./diagnostic-sinks.ts"

const MODES = ["interactive", "print", "protocol"] as const

describe("request dump sink plan", () => {
  it("requestDumpLog is true only with --debug, in every mode", () => {
    for (const mode of MODES) {
      const env = {}
      expect(
        planDiagnosticSinks({ showHeader: false, env, mode, debug: true }).requestDumpLog,
      ).toBe(true)
      expect(planDiagnosticSinks({ showHeader: false, env, mode }).requestDumpLog).toBe(false)
      expect(
        planDiagnosticSinks({ showHeader: false, env, mode, debug: false }).requestDumpLog,
      ).toBe(false)
    }
  })

  it("MINIMAL_AGENT_LOG_STDERR=1 alone adds no request dump", () => {
    const env = { MINIMAL_AGENT_LOG_STDERR: "1" }
    for (const mode of MODES) {
      expect(planDiagnosticSinks({ showHeader: false, env, mode }).requestDumpLog).toBe(false)
    }
  })
})

describe("attachRequestDumpSink", () => {
  it("ZERO COST: without --debug nothing subscribes to the process channel", async () => {
    expect(processRequestInspector().hasSubscribers()).toBe(false)
    const envs = [{}, { VERBOSE: "1" }, { MINIMAL_AGENT_LOG_STDERR: "1" }, { DEBUG: "" }]
    for (const mode of MODES) {
      for (const env of envs) {
        const off = await attachRequestDumpSink({ showHeader: false, env, mode })
        expect(off).toBeNull()
        expect(processRequestInspector().hasSubscribers()).toBe(false)
      }
    }
  })

  it("with --debug it subscribes to the process channel by default", async () => {
    const off = await attachRequestDumpSink({ showHeader: false, env: {}, debug: true })
    try {
      expect(off).toBeFunction()
      expect(processRequestInspector().hasSubscribers()).toBe(true)
    } finally {
      off?.()
    }
    expect(processRequestInspector().hasSubscribers()).toBe(false)
  })

  it("with --debug it subscribes to an injected channel", async () => {
    const inspector = createRequestInspector()
    const off = await attachRequestDumpSink(
      { showHeader: false, env: {}, mode: "protocol", debug: true },
      inspector,
    )
    expect(inspector.hasSubscribers()).toBe(true)
    expect(processRequestInspector().hasSubscribers()).toBe(false)
    off?.()
    expect(inspector.hasSubscribers()).toBe(false)
  })
})

/** One request event whose handle records the `debug` rows. */
function recordingEvent(): { event: RequestWillSendEvent; sources: string[] } {
  const sources: string[] = []
  const diagnostics: RequestDiagnostics = {
    sessionId: "s1",
    emit: () => {},
    debug: (source) => {
      sources.push(source)
    },
    warn: () => {},
  }
  const event: RequestWillSendEvent = {
    sessionId: "s1",
    ts: 0,
    request: {
      model: "test-model",
      stream: true,
      requestType: "conversation",
      tools: [],
      system: [],
      messages: [{ role: "user", content: "hello" }],
      cache: { system: [], messages: [] },
    },
    diagnostics,
  }
  return { event, sources }
}

describe("attachStartupDiagnosticSinks request dump", () => {
  it("debug:true attaches the request dump sink to the channel", async () => {
    const inspector = createRequestInspector()
    await attachStartupDiagnosticSinks({
      showHeader: false,
      env: {},
      mode: "protocol",
      debug: true,
      bus: createDiagnosticBus(),
      requestInspector: inspector,
    })
    expect(inspector.hasSubscribers()).toBe(true)
    expect(processRequestInspector().hasSubscribers()).toBe(false)
    // The subscriber is the plain-text dump: one event gives dump rows.
    const { event, sources } = recordingEvent()
    inspector.publish(() => event)
    expect(sources.length).toBeGreaterThan(0)
    expect(new Set(sources)).toEqual(new Set([REQUEST_DUMP_SOURCE]))
  })

  it("debug:false (or omitted) does not subscribe", async () => {
    for (const debug of [false, undefined]) {
      const inspector = createRequestInspector()
      await attachStartupDiagnosticSinks({
        showHeader: false,
        env: { VERBOSE: "1", DEBUG: "true" },
        mode: "protocol",
        ...(debug === undefined ? {} : { debug }),
        bus: createDiagnosticBus(),
        requestInspector: inspector,
      })
      expect(inspector.hasSubscribers()).toBe(false)
    }
    expect(processRequestInspector().hasSubscribers()).toBe(false)
  })
})
