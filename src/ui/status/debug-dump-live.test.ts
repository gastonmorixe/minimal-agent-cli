/**
 * Live `--debug` wiring: `llm.requestWillSend` subscription → colored
 * scrollback blocks.
 *
 * Guards the contract the TUI needs: one request produces ONE write (so the
 * compositor repaints once), the write carries the whole request, dispose
 * unsubscribes, and without `--debug` nothing subscribes (zero cost in core).
 *
 * @module ui/status/debug-dump-live.test
 */

import { describe, expect, it } from "bun:test"
import {
  createDiagnosticBus,
  Facility,
  type LogEvent,
  Severity,
} from "@minimal-agent/core/host/diagnostics"
import {
  createRequestInspector,
  processRequestInspector,
  type RequestDiagnostics,
  type RequestInspector,
} from "@minimal-agent/core/host/request-inspector"
import { attachRequestDumpLog } from "../../logging/request-dump-log.ts"
import { fakeOrigins, type SnapInput, snapOf, VERBOSE_REQUEST } from "./debug-dump.fixtures.ts"
import {
  attachLiveAreaRequestDump,
  attachLiveAreaRequestDumpIfWanted,
  attachRequestDumpRenderer,
  liveDumpVerbose,
  liveDumpWidth,
  liveDumpWrapWidth,
} from "./debug-dump-live.ts"
import { ScrollbackDiagnosticSink } from "./scrollback.ts"

/** Strip SGR so assertions can look for text, not escapes. */
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

/** A diagnostics handle that drops everything. */
const NO_DIAG: RequestDiagnostics = {
  sessionId: undefined,
  emit: () => {},
  debug: () => {},
  warn: () => {},
}

/** Publish one request on a channel, as core's send path does. */
function publish(
  inspector: RequestInspector,
  input: SnapInput,
  diagnostics: RequestDiagnostics = NO_DIAG,
): void {
  inspector.publish(() => ({
    sessionId: diagnostics.sessionId,
    ts: Date.now(),
    request: snapOf(input),
    diagnostics,
  }))
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

describe("live dump VERBOSE gate (injectable env)", () => {
  it("liveDumpVerbose and liveDumpWidth read VERBOSE from the given env", () => {
    expect(liveDumpVerbose({})).toBe(false)
    expect(liveDumpVerbose({ VERBOSE: "" })).toBe(false)
    expect(liveDumpVerbose({ VERBOSE: "1" })).toBe(true)
    expect(liveDumpWidth({ VERBOSE: "1" })).toBeUndefined()
  })

  it("attachLiveAreaRequestDump uses the injected env for the verbose form", () => {
    const inspector = createRequestInspector()
    const writes: string[] = []
    const handle = attachLiveAreaRequestDump(
      { writeStream: (t) => writes.push(t) },
      { inspector, env: { VERBOSE: "1" }, wrapWidth: () => undefined },
    )
    publish(inspector, VERBOSE_REQUEST)
    handle.dispose()
    const verbose = writes[0] ?? ""
    const compactInspector = createRequestInspector()
    const compactWrites: string[] = []
    const compact = attachLiveAreaRequestDump(
      { writeStream: (t) => compactWrites.push(t) },
      { inspector: compactInspector, env: {}, wrapWidth: () => undefined },
    )
    publish(compactInspector, VERBOSE_REQUEST)
    compact.dispose()
    expect(verbose).not.toBe(compactWrites[0] ?? "")
  })
})

describe("attachRequestDumpRenderer", () => {
  it("writes ONE block per request", () => {
    const inspector = createRequestInspector()
    const writes: string[] = []
    const handle = attachRequestDumpRenderer({ inspector, write: (t) => writes.push(t) })

    publish(inspector, { model: "m1", tools: [{ name: "T", description: "d" }] })
    expect(writes).toHaveLength(1)
    const text = strip(writes[0])
    expect(text).toContain("POST m1")
    expect(text).toContain("tools: [1 tool(s)]")
    expect(text.endsWith("\n")).toBe(true)

    handle.dispose()
  })

  it("renders the compact form unless the verbose gate is on", () => {
    const inspector = createRequestInspector()
    const writes: string[] = []
    let verbose = false
    const handle = attachRequestDumpRenderer({
      inspector,
      write: (t) => writes.push(t),
      verbose: () => verbose,
    })
    publish(inspector, VERBOSE_REQUEST)
    verbose = true
    publish(inspector, VERBOSE_REQUEST)
    expect(strip(writes[0])).not.toContain(" │ ")
    expect(strip(writes[0])).toContain("      #1 user: fix this: ⏎ indented line")
    expect(strip(writes[1])).toContain("         1 │ fix this:")
    handle.dispose()
  })

  it("origins reach the renderer", () => {
    const inspector = createRequestInspector()
    const writes: string[] = []
    const handle = attachRequestDumpRenderer({
      inspector,
      write: (t) => writes.push(t),
      verbose: () => true,
      origins: fakeOrigins(),
    })
    publish(inspector, VERBOSE_REQUEST)
    expect(writes).toHaveLength(1)
    const text = strip(writes[0])
    expect(text).toContain('↳ ma-skills-plugin · <ma::sys::tool name="Skill">')
    expect(text).toContain("↳ core · sessionContext")
    expect(text).toContain("↳ tool_result · from tool_use Bash #a1")
    handle.dispose()
  })

  it("the live-area attach takes origins, an injected describer and a wrap width", async () => {
    const inspector = createRequestInspector()
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
      { inspector, origins, describeSystemBlock, wrapWidth: () => 40, verbose: () => true },
    )
    await Promise.resolve()
    publish(inspector, VERBOSE_REQUEST)
    publish(inspector, VERBOSE_REQUEST)
    expect(asked).toBe(1)
    expect(writes).toHaveLength(2)
    const text = strip(writes[0])
    expect(text).toContain("↳ core · sessionContext")
    for (const l of text.split("\n").filter((x) => x.includes(" │ "))) {
      expect(l.length).toBeLessThanOrEqual(40)
    }
    handle.dispose()
  })

  it("stops writing after dispose, and leaves no subscriber", () => {
    const inspector = createRequestInspector()
    const writes: string[] = []
    const handle = attachRequestDumpRenderer({ inspector, write: (t) => writes.push(t) })
    expect(inspector.hasSubscribers()).toBe(true)
    handle.dispose()
    handle.dispose()
    expect(inspector.hasSubscribers()).toBe(false)

    publish(inspector, { model: "after" })
    expect(writes).toEqual([])
  })

  // Regression: `getPromptBlocksAsync` was guarded by `typeof` only, so a
  // throwing or non-thenable return escaped attach and aborted TUI startup.
  it("survives a getPromptBlocksAsync that throws synchronously", () => {
    const inspector = createRequestInspector()
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
        { inspector, origins, verbose: () => true },
      )
    }).not.toThrow()
    publish(inspector, VERBOSE_REQUEST)
    expect(strip(writes[0] ?? "")).toContain("↳")
    handle?.dispose()
  })

  it("survives a getPromptBlocksAsync that returns a non-thenable", () => {
    const inspector = createRequestInspector()
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
        { inspector, origins, verbose: () => true },
      )
    }).not.toThrow()
    publish(inspector, VERBOSE_REQUEST)
    expect(strip(writes[0] ?? "")).toContain("↳")
    handle?.dispose()
  })

  // Regression: `base?.loadedPackages()` guarded the receiver only, so a
  // loader without the method threw inside the closure at render time.
  it("does not call loadedPackages when the loader has none", () => {
    const inspector = createRequestInspector()
    const writes: string[] = []
    let handle: ReturnType<typeof attachLiveAreaRequestDump> | undefined
    expect(() => {
      handle = attachLiveAreaRequestDump(
        { writeStream: (t) => writes.push(t) },
        {
          inspector,
          origins: {} as never,
          describeSystemBlock: () => [{ slot: "identity", start: 0, end: 1, overridden: false }],
          verbose: () => true,
        },
      )
    }).not.toThrow()
    publish(inspector, VERBOSE_REQUEST)
    expect(strip(writes[0] ?? "")).toContain("↳ core · identity")
    handle?.dispose()
  })
})

describe("live dump gate (zero cost)", () => {
  it("no --debug: no subscription on the process channel", () => {
    const inspector = processRequestInspector()
    const before = inspector.hasSubscribers()
    const handle = attachLiveAreaRequestDumpIfWanted({ writeStream: () => {} }, false, {
      env: { VERBOSE: "1" },
    })
    expect(handle).toBeNull()
    expect(inspector.hasSubscribers()).toBe(before)
    expect(inspector.hasSubscribers()).toBe(false)
  })

  it("--debug: one subscription, removed on dispose", () => {
    const inspector = createRequestInspector()
    const handle = attachLiveAreaRequestDumpIfWanted({ writeStream: () => {} }, true, {
      inspector,
    })
    expect(handle).not.toBeNull()
    expect(inspector.hasSubscribers()).toBe(true)
    handle?.dispose()
    expect(inspector.hasSubscribers()).toBe(false)
  })
})

describe("no double render in the REPL", () => {
  it("the log sink's text rows reach no TUI scrollback; the block paints once", () => {
    const inspector = createRequestInspector()
    const bus = createDiagnosticBus()
    const events: LogEvent[] = []
    bus.on("*", (e) => events.push(e))
    const diagnostics: RequestDiagnostics = {
      sessionId: "s1",
      emit: (e) => bus.emit(e),
      debug: (source, message, data) =>
        bus.emit({
          ts: 0,
          severity: Severity.Debug,
          facility: Facility.User,
          source,
          message,
          ...(data ? { structuredData: data } : {}),
        }),
      warn: () => {},
    }
    // The scrollback sink as the REPL wires it, on the same bus.
    const scrolled: string[] = []
    const scrollback = new ScrollbackDiagnosticSink()
    scrollback.bindWriter((t) => scrolled.push(t))
    scrollback.attach(bus)
    // Both `--debug` subscribers: the log sink and the TUI renderer.
    const offLog = attachRequestDumpLog({ inspector, verbose: () => false })
    const painted: string[] = []
    const tui = attachRequestDumpRenderer({ inspector, write: (t) => painted.push(t) })

    publish(inspector, VERBOSE_REQUEST, diagnostics)

    // The log sink emitted its plain rows (file log material) ...
    expect(events.some((e) => e.source === "transport.request-dump")).toBe(true)
    // ... but the TUI drew the request once, and scrollback drew no row.
    expect(painted).toHaveLength(1)
    expect(scrolled).toEqual([])

    tui.dispose()
    offLog()
    scrollback.detach()
  })
})
