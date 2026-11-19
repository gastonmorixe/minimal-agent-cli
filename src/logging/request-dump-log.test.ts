/**
 * The headless request dump: one `llm.requestWillSend` event becomes N Debug
 * rows on the request's own diagnostics handle.
 *
 * @module logging/request-dump-log.test
 */

import { describe, expect, it } from "bun:test"
import {
  createDiagnosticBus,
  type DiagnosticBus,
  Facility,
  type LogEvent,
  Severity,
} from "@minimal-agent/core/host/diagnostics"
import {
  createRequestInspector,
  type RequestDiagnostics,
  type RequestSnapshot,
  type RequestWillSendEvent,
} from "@minimal-agent/core/host/request-inspector"

import { StderrMirrorSink } from "./log-stderr.ts"
import { attachRequestDumpLog, REQUEST_DUMP_SOURCE } from "./request-dump-log.ts"

const TS = Date.UTC(2026, 10, 19, 12, 0, 0)

/**
 * A session-scoped handle over a bus, like core's `createDiagnostics`: it
 * stamps `sessionId` and `Facility.User` on each event.
 */
function sessionHandle(bus: DiagnosticBus, sessionId: string | undefined): RequestDiagnostics {
  const at =
    (severity: Severity) =>
    (source: string, message: string, data?: LogEvent["structuredData"]): void => {
      bus.emit({
        ts: TS,
        severity,
        facility: Facility.User,
        source,
        message,
        ...(data ? { structuredData: data } : {}),
        ...(sessionId === undefined ? {} : { sessionId }),
      })
    }
  return {
    sessionId,
    emit: (e) => bus.emit(sessionId === undefined ? e : { ...e, sessionId }),
    debug: at(Severity.Debug),
    warn: at(Severity.Warning),
  }
}

const REQUEST: RequestSnapshot = {
  model: "test-model",
  stream: true,
  requestType: "conversation",
  tools: [],
  system: [{ type: "text", text: "system text", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "hello" }],
  cache: { system: [0], messages: [] },
}

function event(diagnostics: RequestDiagnostics): RequestWillSendEvent {
  return { sessionId: diagnostics.sessionId, ts: TS, request: REQUEST, diagnostics }
}

/** Collect every event of a fresh bus. */
function collect(): { bus: DiagnosticBus; events: LogEvent[] } {
  const bus = createDiagnosticBus()
  const events: LogEvent[] = []
  bus.on("*", (e) => events.push(e))
  return { bus, events }
}

describe("attachRequestDumpLog", () => {
  it("re-emits each row as a Debug diagnostic on the request's handle", () => {
    const inspector = createRequestInspector()
    const { bus, events } = collect()
    const off = attachRequestDumpLog({ inspector, verbose: () => false })
    const diagnostics = sessionHandle(bus, "sess-1")
    inspector.publish(() => event(diagnostics))
    off()

    expect(events.map((e) => e.message)).toEqual([
      "--- POST test-model ---",
      "  model: test-model",
      "  stream: true",
      "  request_type: conversation",
      "  Body:",
      "    system: [1 block(s)]",
      "      block 0 [cached]: system text",
      "    messages: [1 message(s)]",
      "      user: hello",
    ])
    expect(events.every((e) => e.severity === Severity.Debug)).toBe(true)
    expect(events.every((e) => e.source === REQUEST_DUMP_SOURCE)).toBe(true)
    expect(REQUEST_DUMP_SOURCE).toBe("transport.request-dump")
    expect(events.every((e) => e.sessionId === "sess-1")).toBe(true)
    expect(events.map((e) => e.structuredData?.row)).toEqual(events.map((_, i) => i))
    expect(events.filter((e) => e.structuredData?.last === true)).toHaveLength(1)
    expect(events.at(-1)?.structuredData).toEqual({ row: events.length - 1, last: true })
  })

  it("non-verbose data is only row and last", () => {
    const inspector = createRequestInspector()
    const { bus, events } = collect()
    const off = attachRequestDumpLog({ inspector, verbose: () => false })
    inspector.publish(() => event(sessionHandle(bus, undefined)))
    off()
    const keys = new Set(events.flatMap((e) => Object.keys(e.structuredData ?? {})))
    expect([...keys].sort()).toEqual(["last", "row"])
    expect(events.every((e) => e.sessionId === undefined)).toBe(true)
  })

  it("verbose adds the typed row data, read at each event", () => {
    const inspector = createRequestInspector()
    const { bus, events } = collect()
    let verbose = false
    const off = attachRequestDumpLog({ inspector, verbose: () => verbose })
    verbose = true
    inspector.publish(() => event(sessionHandle(bus, "s")))
    off()
    const line = events.find(
      (e) => e.structuredData?.kind === "line" && e.structuredData.section === "messages",
    )
    expect(line?.message).toBe("hello")
    expect(line?.structuredData).toEqual({
      row: events.indexOf(line as LogEvent),
      section: "messages",
      part: 0,
      block: 0,
      kind: "line",
      line: 1,
      // The message line is the final row of this dump.
      last: true,
    })
    expect(events[0].structuredData).toEqual({ row: 0 })
    const sysPart = events.find((e) => e.structuredData?.kind === "part")
    expect(sysPart?.structuredData).toEqual({
      row: events.indexOf(sysPart as LogEvent),
      kind: "part",
      section: "system",
      part: 0,
    })
  })

  it("unsubscribes, and the channel then has no subscriber", () => {
    const inspector = createRequestInspector()
    const off = attachRequestDumpLog({ inspector, verbose: () => false })
    expect(inspector.hasSubscribers()).toBe(true)
    off()
    off()
    expect(inspector.hasSubscribers()).toBe(false)
    let built = 0
    inspector.publish(() => {
      built++
      return event(sessionHandle(createDiagnosticBus(), undefined))
    })
    expect(built).toBe(0)
  })

  it("the stderr mirror prints a row the same as before", () => {
    const inspector = createRequestInspector()
    const bus = createDiagnosticBus()
    const written: string[] = []
    const sink = new StderrMirrorSink({ write: (s) => written.push(s) })
    sink.attach(bus)
    const off = attachRequestDumpLog({ inspector, verbose: () => false })
    inspector.publish(() => event(sessionHandle(bus, "s")))
    off()
    sink.detach()
    expect(written[0]).toBe('[DEBUG] transport.request-dump: --- POST test-model --- row="0"\n')
    expect(written.at(-1)).toBe(
      '[DEBUG] transport.request-dump:       user: hello row="8" last="true"\n',
    )
  })
})
