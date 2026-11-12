/**
 * Live `--debug` wiring: bus subscription → colored scrollback blocks.
 *
 * Guards the contract the TUI needs: one request produces ONE write (so the
 * compositor repaints once, not once per dump row), the write carries the
 * whole request, and teardown drains a dump that was still in flight when the
 * turn aborted.
 *
 * @module ui/status/debug-dump-live.test
 */

import { describe, expect, it } from "bun:test"
import { createDiagnosticBus, Severity } from "@minimal-agent/core/host/diagnostics"
import { attachRequestDumpRenderer } from "./debug-dump-live.ts"

/** Rows the transport emits for one request, structured as it emits them. */
function emitDump(bus: ReturnType<typeof createDiagnosticBus>, model = "m1"): void {
  const lines = [`--- POST ${model} ---`, "  model: " + model, "  Body:", "    tools: [1 tool(s)]"]
  const last = lines.length - 1
  for (let i = 0; i < lines.length; i++) {
    bus.emit({
      ts: Date.now(),
      severity: Severity.Debug,
      facility: 16,
      source: "transport.request-dump",
      message: lines[i],
      structuredData: { row: i, ...(i === last ? { last: true } : {}) },
    } as never)
  }
}

describe("attachRequestDumpRenderer", () => {
  it("writes ONE block per request", () => {
    const bus = createDiagnosticBus()
    const writes: string[] = []
    const handle = attachRequestDumpRenderer({ bus, write: (t) => writes.push(t) })

    emitDump(bus)
    expect(writes).toHaveLength(1)
    // Strip SGR: "tools:" is split by the color code around the section name.
    const text = writes[0].replace(/\x1b\[[0-9;]*m/g, "")
    expect(text).toContain("POST m1")
    expect(text).toContain("tools:")

    handle.dispose()
  })

  it("ignores other Debug sources and other severities", () => {
    const bus = createDiagnosticBus()
    const writes: string[] = []
    const handle = attachRequestDumpRenderer({ bus, write: (t) => writes.push(t) })

    bus.emit({
      ts: Date.now(),
      severity: Severity.Debug,
      facility: 16,
      source: "auth.login",
      message: "noise",
    } as never)
    bus.emit({
      ts: Date.now(),
      severity: Severity.Warning,
      facility: 16,
      source: "transport.request-dump",
      message: "warning on the same source",
    } as never)

    expect(writes).toEqual([])
    handle.dispose()
  })

  it("shows a dump row that skips the structured contract", () => {
    const bus = createDiagnosticBus()
    const writes: string[] = []
    const handle = attachRequestDumpRenderer({ bus, write: (t) => writes.push(t) })

    bus.emit({
      ts: Date.now(),
      severity: Severity.Debug,
      facility: 16,
      source: "transport.request-dump",
      message: "unstructured debug line",
    } as never)

    expect(writes).toEqual(["unstructured debug line\n"])
    handle.dispose()
  })

  it("drains an in-flight dump on dispose", () => {
    const bus = createDiagnosticBus()
    const writes: string[] = []
    const handle = attachRequestDumpRenderer({ bus, write: (t) => writes.push(t) })

    // No `last` marker: the turn was aborted mid-dump.
    bus.emit({
      ts: Date.now(),
      severity: Severity.Debug,
      facility: 16,
      source: "transport.request-dump",
      message: "--- POST aborted ---",
      structuredData: { row: 0 },
    } as never)
    expect(writes).toHaveLength(0)

    handle.dispose()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain("POST aborted")
  })

  it("stops writing after dispose", () => {
    const bus = createDiagnosticBus()
    const writes: string[] = []
    const handle = attachRequestDumpRenderer({ bus, write: (t) => writes.push(t) })
    handle.dispose()

    emitDump(bus, "after")
    expect(writes).toEqual([])
  })
})

describe("attachRequestDumpRenderer: call-site parity (S14.2 step 0)", () => {
  it("writes the message plus newline for a non-structured row, byte for byte", () => {
    const bus = createDiagnosticBus()
    const writes: string[] = []
    const handle = attachRequestDumpRenderer({ bus, write: (t) => writes.push(t) })
    bus.emit({
      ts: Date.now(),
      severity: Severity.Debug,
      facility: 16,
      source: "transport.request-dump",
      message: "raw line\nwith break",
    } as never)
    expect(writes).toEqual(["raw line\nwith break\n"])
    handle.dispose()
  })

  it("writes only k=v for a typed empty-message row with no renderer", () => {
    const bus = createDiagnosticBus()
    const writes: string[] = []
    const handle = attachRequestDumpRenderer({ bus, write: (t) => writes.push(t) })
    bus.emit({
      ts: Date.now(),
      severity: Severity.Debug,
      facility: 16,
      source: "transport.request-dump",
      message: "",
      diagnostic: { source: "transport.request-dump", level: "debug", attrs: { k: "v" } },
    } as never)
    // The source prefix is not printed on this stream by design. Pinned so a
    // change is seen. This row shape is not reachable today: the only producer
    // (core src/llm/transport/debug.ts:234-237) always sets the dump line as the
    // message and a `row` index in the data, so it takes the structured path.
    expect(writes).toEqual(["k=v\n"])
    handle.dispose()
  })

  it("feeds the message of each structured row to the collector", () => {
    const bus = createDiagnosticBus()
    const writes: string[] = []
    const handle = attachRequestDumpRenderer({ bus, write: (t) => writes.push(t) })
    emitDump(bus, "parity")
    expect(writes).toHaveLength(1)
    const text = writes[0].replace(/\x1b\[[0-9;]*m/g, "")
    expect(text).toContain("POST parity")
    expect(text).toContain("model: parity")
    expect(text.endsWith("\n")).toBe(true)
    handle.dispose()
  })
})
