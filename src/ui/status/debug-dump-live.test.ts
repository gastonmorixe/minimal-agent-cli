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
import { type FixtureRow, fakeOrigins, VERBOSE_ROWS } from "./debug-dump.fixtures.ts"
import {
  attachLiveAreaRequestDump,
  attachRequestDumpRenderer,
  liveDumpWrapWidth,
} from "./debug-dump-live.ts"

/** Strip SGR so assertions can look for text, not escapes. */
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

/** Emit fixture rows with their verbose data, as the transport would. */
function emitRows(bus: ReturnType<typeof createDiagnosticBus>, rows: readonly FixtureRow[]): void {
  for (let i = 0; i < rows.length; i++) {
    const [message, data] = rows[i]
    bus.emit({
      ts: Date.now(),
      severity: Severity.Debug,
      facility: 16,
      source: "transport.request-dump",
      message,
      structuredData: { row: i, ...data, ...(i === rows.length - 1 ? { last: true } : {}) },
    } as never)
  }
}

describe("liveDumpWrapWidth", () => {
  it("reads $COLUMNS when stdout has no width, and undefined when neither has one", () => {
    const saved = { cols: process.env.COLUMNS, tty: process.stdout.columns }
    try {
      Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true })
      process.env.COLUMNS = "77"
      expect(liveDumpWrapWidth()).toBe(77)
      process.env.COLUMNS = ""
      expect(liveDumpWrapWidth()).toBeUndefined()
      Object.defineProperty(process.stdout, "columns", { value: 91, configurable: true })
      expect(liveDumpWrapWidth()).toBe(91)
    } finally {
      Object.defineProperty(process.stdout, "columns", { value: saved.tty, configurable: true })
      if (saved.cols === undefined) delete process.env.COLUMNS
      else process.env.COLUMNS = saved.cols
    }
  })
})

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

  it("origins reach the renderer", () => {
    const bus = createDiagnosticBus()
    const writes: string[] = []
    const handle = attachRequestDumpRenderer({
      bus,
      write: (t) => writes.push(t),
      origins: fakeOrigins(),
    })
    emitRows(bus, VERBOSE_ROWS)
    expect(writes).toHaveLength(1)
    const text = strip(writes[0])
    expect(text).toContain('↳ ma-skills-plugin · <ma::sys::tool name="Skill">')
    expect(text).toContain("↳ core · sessionContext")
    expect(text).toContain("↳ tool_result · from tool_use Bash #a1")
    handle.dispose()
  })

  it("the live-area attach takes origins, an injected describer and a wrap width", async () => {
    const bus = createDiagnosticBus()
    const writes: string[] = []
    const { describeSystemBlock, ...rest } = fakeOrigins()
    let asked = 0
    const origins = {
      ...rest,
      getPromptBlocksAsync: async () => {
        asked++
        return { afterInstructions: null, sessionContext: null }
      },
    }
    const handle = attachLiveAreaRequestDump(
      { writeStream: (t) => writes.push(t) },
      { bus, origins, describeSystemBlock, wrapWidth: () => 40, verbose: () => true },
    )
    await Promise.resolve()
    emitRows(bus, VERBOSE_ROWS)
    emitRows(bus, VERBOSE_ROWS)
    expect(asked).toBe(1)
    const text = strip(writes[0])
    expect(text).toContain("↳ core · sessionContext")
    for (const l of text.split("\n").filter((x) => x.includes(" │ "))) {
      expect(l.length).toBeLessThanOrEqual(40)
    }
    handle.dispose()
  })

  it("stops writing after dispose", () => {
    const bus = createDiagnosticBus()
    const writes: string[] = []
    const handle = attachRequestDumpRenderer({ bus, write: (t) => writes.push(t) })
    handle.dispose()

    emitDump(bus, "after")
    expect(writes).toEqual([])
  })

  // Regression: `getPromptBlocksAsync` was guarded by `typeof` only, so a
  // throwing or non-thenable return escaped attach and aborted TUI startup.
  it("survives a getPromptBlocksAsync that throws synchronously", () => {
    const bus = createDiagnosticBus()
    const writes: string[] = []
    const origins = {
      loadedPackages: () => [],
      getPromptBlocksAsync: () => {
        throw new Error("boom")
      },
    }
    let handle: ReturnType<typeof attachLiveAreaRequestDump> | undefined
    expect(() => {
      handle = attachLiveAreaRequestDump(
        { writeStream: (t) => writes.push(t) },
        { bus, origins, verbose: () => true },
      )
    }).not.toThrow()
    emitRows(bus, VERBOSE_ROWS)
    expect(strip(writes[0] ?? "")).toContain("↳")
    handle?.dispose()
  })

  it("survives a getPromptBlocksAsync that returns a non-thenable", () => {
    const bus = createDiagnosticBus()
    const writes: string[] = []
    const origins = {
      loadedPackages: () => [],
      // A loader that lies about the contract: the cast is the point.
      getPromptBlocksAsync: () => "not a promise" as never,
    }
    let handle: ReturnType<typeof attachLiveAreaRequestDump> | undefined
    expect(() => {
      handle = attachLiveAreaRequestDump(
        { writeStream: (t) => writes.push(t) },
        { bus, origins, verbose: () => true },
      )
    }).not.toThrow()
    emitRows(bus, VERBOSE_ROWS)
    expect(strip(writes[0] ?? "")).toContain("↳")
    handle?.dispose()
  })

  // Regression: `base?.loadedPackages()` guarded the receiver only, so a
  // loader without the method threw inside the closure at render time.
  it("does not call loadedPackages when the loader has none", () => {
    const bus = createDiagnosticBus()
    const writes: string[] = []
    let handle: ReturnType<typeof attachLiveAreaRequestDump> | undefined
    expect(() => {
      handle = attachLiveAreaRequestDump(
        { writeStream: (t) => writes.push(t) },
        {
          bus,
          origins: {} as never,
          describeSystemBlock: () => [{ slot: "identity", start: 0, end: 1, overridden: false }],
          verbose: () => true,
        },
      )
    }).not.toThrow()
    emitRows(bus, VERBOSE_ROWS)
    expect(strip(writes[0] ?? "")).toContain("↳ core · identity")
    handle?.dispose()
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
