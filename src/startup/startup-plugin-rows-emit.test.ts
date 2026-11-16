import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { StartupRow } from "@minimal-agent/core/plugin-api"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { setStartupTreeVisible } from "../ui/startup/tree.ts"
import {
  closeStartupTreeWithToolsAndPluginRows,
  collectStartupRows,
  printStartupPluginRows,
  type StartupRowsHooks,
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
  const orig = console.error
  beforeEach(() => {
    lines = []
    console.error = (...args: unknown[]) => {
      lines.push(stripAnsi(args.map(String).join(" ")))
    }
    setStartupTreeVisible(true)
  })
  afterEach(() => {
    console.error = orig
    setStartupTreeVisible(false)
  })

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
})
