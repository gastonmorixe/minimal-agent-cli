import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { StartupRow } from "@minimal-agent/core/plugin-api"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"
import { isStartupTreeVisible, setStartupTreeVisible } from "../ui/startup/tree.ts"
import { c } from "../ui/style/ansi.ts"
import {
  closeStartupTreeWithToolsAndPluginRows,
  collectStartupRows,
  printStartupPluginRows,
  type StartupRowsHooks,
  startupPluginRowsSeam,
  stripTerminalControls,
} from "./startup-plugin-rows-emit.ts"

const HOOKS_ROW: StartupRow = {
  label: "hooks",
  summary: [{ text: "1 active", tone: "ok" }],
  children: [{ label: "turn.willStart", value: [{ text: "timestamp.sh", tone: "accent" }] }],
}

function fakeHooks(rows: unknown): StartupRowsHooks & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    async emitChain<T>(channel: string, payload: T) {
      calls.push({ channel, payload })
      return { payload: { ...(payload as object), rows } as T }
    },
  }
}

describe("collectStartupRows", () => {
  test("returns the rows the chain appended", async () => {
    const hooks = fakeHooks([HOOKS_ROW])
    const rows = await collectStartupRows(hooks, { cwd: "/w", cols: 100 })
    expect(rows).toEqual([HOOKS_ROW])
    expect(hooks.calls).toEqual([
      { channel: "startup.rows", payload: { cwd: "/w", cols: 100, rows: [] } },
    ])
  })

  test("timeout returns [] within about the budget", async () => {
    const hooks: StartupRowsHooks = { emitChain: () => new Promise(() => undefined) }
    const t0 = performance.now()
    const rows = await collectStartupRows(hooks, { cwd: "/w", cols: 80, budgetMs: 20 })
    expect(rows).toEqual([])
    expect(performance.now() - t0).toBeLessThan(200)
  })

  test("emitChain throwing (sync or async) returns []", async () => {
    const sync: StartupRowsHooks = {
      emitChain: () => {
        throw new Error("boom")
      },
    }
    const async: StartupRowsHooks = { emitChain: () => Promise.reject(new Error("boom")) }
    expect(await collectStartupRows(sync, { cwd: "/w", cols: 80 })).toEqual([])
    expect(await collectStartupRows(async, { cwd: "/w", cols: 80 })).toEqual([])
  })

  test("malformed rows are dropped, valid ones kept", async () => {
    const hooks = fakeHooks([
      null,
      "x",
      { label: 3, summary: [] },
      { label: "nosum" },
      { label: "badsum", summary: "text" },
      { label: "badpart", summary: [{ tone: "ok" }] },
      { ...HOOKS_ROW, children: [{ label: 1, value: [] }, ...(HOOKS_ROW.children ?? [])] },
    ])
    const rows = await collectStartupRows(hooks, { cwd: "/w", cols: 80 })
    expect(rows).toEqual([HOOKS_ROW])
  })

  test("an unknown tone maps to default and does not throw", async () => {
    const hooks = fakeHooks([
      {
        label: "x",
        summary: [{ text: "a", tone: "red" }, { text: "b", tone: 7 }, { text: "c" }],
        children: [{ label: "k", value: [{ text: "v", tone: "blink" }] }],
      },
    ])
    const rows = await collectStartupRows(hooks, { cwd: "/w", cols: 80 })
    expect(rows).toEqual([
      {
        label: "x",
        summary: [{ text: "a", tone: "default" }, { text: "b", tone: "default" }, { text: "c" }],
        children: [{ label: "k", value: [{ text: "v", tone: "default" }] }],
      },
    ])
  })

  test("ESC sequences and controls are stripped from every string", async () => {
    const dirty = "x\x1b[31mRED\ny\x1b]0;title\x07z\t\x00\x7f\x9b2Jq"
    const hooks = fakeHooks([
      {
        label: "l\x1b[1ma\r",
        summary: [{ text: dirty }],
        children: [{ label: "c\nl", value: [{ text: dirty }] }],
      },
    ])
    const [row] = await collectStartupRows(hooks, { cwd: "/w", cols: 80 })
    expect(row?.label).toBe("la ")
    expect(row?.summary[0]?.text).toBe("xRED yz q")
    expect(row?.children?.[0]?.label).toBe("c l")
    expect(row?.children?.[0]?.value[0]?.text).toBe("xRED yz q")
  })

  test("stripTerminalControls keeps plain unicode text", () => {
    expect(stripTerminalControls("Stop → run-tests.sh · 日本")).toBe("Stop → run-tests.sh · 日本")
  })

  test("a non-array rows result returns []", async () => {
    expect(await collectStartupRows(fakeHooks("nope"), { cwd: "/w", cols: 80 })).toEqual([])
  })
})

describe("printStartupPluginRows", () => {
  test("empty rows print nothing", () => {
    const out: string[] = []
    printStartupPluginRows([], { cols: 80, plain: true, write: (l) => out.push(l) })
    expect(out).toEqual([])
  })
})

describe("closeStartupTreeWithToolsAndPluginRows", () => {
  let lines: string[]
  let raw: string[]
  let prevVisible = false
  const orig = console.error
  const origRender = startupPluginRowsSeam.render
  const origTTY = process.stderr.isTTY
  const origNoColor = process.env.NO_COLOR
  const origTerm = process.env.TERM
  beforeEach(() => {
    lines = []
    raw = []
    prevVisible = isStartupTreeVisible()
    console.error = (...args: unknown[]) => {
      raw.push(args.map(String).join(" "))
      lines.push(stripAnsi(args.map(String).join(" ")))
    }
    setStartupTreeVisible(true)
  })
  afterEach(() => {
    console.error = orig
    startupPluginRowsSeam.render = origRender
    setTTY(origTTY)
    restoreEnv("NO_COLOR", origNoColor)
    restoreEnv("TERM", origTerm)
    setStartupTreeVisible(prevVisible)
  })

  function setTTY(v: boolean | undefined): void {
    Object.defineProperty(process.stderr, "isTTY", { value: v, configurable: true, writable: true })
  }
  function restoreEnv(key: string, v: string | undefined): void {
    if (v === undefined) delete process.env[key]
    else process.env[key] = v
  }

  const tools = [{ name: "Bash" }]

  test("tools then hooks, the hooks group closes the tree", async () => {
    await closeStartupTreeWithToolsAndPluginRows(
      { hooks: () => fakeHooks([HOOKS_ROW]) },
      tools,
      null,
      { cwd: "/w" },
    )
    expect(lines.length).toBe(3)
    expect(lines[0]).toMatch(/^ {2}│ tools {6}.*Bash/)
    expect(lines[1]).toBe("  ╰ hooks      1 active")
    expect(lines[2]).toBe("      └ turn.willStart  timestamp.sh")
  })

  test("no plugin rows keeps tools as the closer", async () => {
    await closeStartupTreeWithToolsAndPluginRows({ hooks: () => fakeHooks([]) }, tools, null, {
      cwd: "/w",
    })
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatch(/^ {2}╰ tools {6}.*Bash/)
  })

  test("unknown tone in color mode renders as default, no throw", async () => {
    setTTY(true)
    delete process.env.NO_COLOR
    process.env.TERM = "xterm-256color"
    const row = {
      label: "x",
      summary: [
        { text: "r", tone: "red" },
        { text: "w", tone: "warn" },
      ],
    }
    await closeStartupTreeWithToolsAndPluginRows({ hooks: () => fakeHooks([row]) }, tools, null, {
      cwd: "/w",
    })
    expect(lines[1]).toBe("  ╰ x          r · w")
    expect(raw[1]).toContain(`  r${c.dim(" · ")}${c.yellow("w")}`)
  })

  test("ANSI and newlines in plugin text are stripped in plain mode", async () => {
    setTTY(false)
    const row = {
      label: "h\x1b[31m",
      summary: [{ text: "a\x1b[31mRED\nb" }],
      children: [{ label: "k", value: [{ text: "v\x1b]0;t\x07\r" }] }],
    }
    await closeStartupTreeWithToolsAndPluginRows({ hooks: () => fakeHooks([row]) }, tools, null, {
      cwd: "/w",
    })
    expect(raw.slice(1)).toEqual(["  ╰ h          aRED b", "      └ k  v "])
    for (const line of raw.slice(1)) expect(line.includes("\x1b")).toBe(false)
  })

  test("empty tools: the plugin group still closes the tree", async () => {
    await closeStartupTreeWithToolsAndPluginRows(
      { hooks: () => fakeHooks([HOOKS_ROW]) },
      [],
      null,
      {
        cwd: "/w",
      },
    )
    expect(lines).toEqual(["  ╰ hooks      1 active", "      └ turn.willStart  timestamp.sh"])
  })

  test("a throwing renderer falls back to the old closer, printed once", async () => {
    startupPluginRowsSeam.render = () => {
      throw new Error("boom")
    }
    await closeStartupTreeWithToolsAndPluginRows(
      { hooks: () => fakeHooks([HOOKS_ROW]) },
      tools,
      null,
      { cwd: "/w" },
    )
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatch(/^ {2}╰ tools {6}.*Bash/)
  })

  test("a throwing hooks() falls back to the old closer", async () => {
    const loader = {
      hooks(): StartupRowsHooks {
        throw new Error("boom")
      },
    }
    await closeStartupTreeWithToolsAndPluginRows(loader, tools, null, { cwd: "/w" })
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatch(/^ {2}╰ tools {6}.*Bash/)
  })
})
