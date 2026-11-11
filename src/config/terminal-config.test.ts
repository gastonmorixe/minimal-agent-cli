/**
 * The CLI terminal config reader. These keys are terminal presentation, so
 * the CLI owns them (S41 follow-up). Core `loadUserConfig` no longer knows
 * them. The parse rules and the cases below moved from core
 * `src/config/config.test.ts` without change.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadUserConfig } from "@minimal-agent/core/host/config"

import { loadCliUserConfig, loadTerminalConfig } from "./terminal-config.ts"

describe("loadTerminalConfig", () => {
  let dir: string
  let path: string
  const prevEnv = process.env.MINIMAL_AGENT_CONFIG

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-terminal-cfg-"))
    path = join(dir, "config.json")
    process.env.MINIMAL_AGENT_CONFIG = path
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = prevEnv
  })

  const write = (obj: unknown) => writeFileSync(path, JSON.stringify(obj))

  it("returns {} when the file does not exist, is malformed, or is not an object", () => {
    expect(loadTerminalConfig()).toEqual({})
    writeFileSync(path, "{not json")
    expect(loadTerminalConfig()).toEqual({})
    write(["a", "b"])
    expect(loadTerminalConfig()).toEqual({})
  })

  it("reads only the terminal keys and ignores the runtime keys", () => {
    write({ model: "m", effort: "high", spinner: "dots", header: false, banana: 1 })
    expect(loadTerminalConfig()).toEqual({ spinner: "dots", header: false })
  })

  it("accepts JSONC syntax", () => {
    writeFileSync(path, `{\n  // c\n  "spinner": "dots", /* b */\n  "autoAsk": false,\n}`)
    expect(loadTerminalConfig()).toEqual({ spinner: "dots", autoAsk: false })
  })

  it("drops empty-string spinner/formatter", () => {
    write({ spinner: "", formatter: "" })
    expect(loadTerminalConfig()).toEqual({})
  })

  it("parses formatter as a string", () => {
    write({ formatter: "bat --paging=never" })
    expect(loadTerminalConfig()).toEqual({ formatter: "bat --paging=never" })
  })

  it("parses formatterArgs as a string array", () => {
    write({ formatterArgs: ["--table-fit", "--foo"] })
    expect(loadTerminalConfig()).toEqual({ formatterArgs: ["--table-fit", "--foo"] })
  })

  it("parses formatterArgs as a shell-style string", () => {
    write({ formatterArgs: "--table-fit --title 'My Doc'" })
    expect(loadTerminalConfig()).toEqual({ formatterArgs: ["--table-fit", "--title", "My Doc"] })
  })

  it("filters non-string / empty entries from formatterArgs array", () => {
    write({ formatterArgs: ["--table-fit", "", 42, null, "--ok"] })
    expect(loadTerminalConfig()).toEqual({ formatterArgs: ["--table-fit", "--ok"] })
  })

  it("drops empty/invalid formatterArgs", () => {
    for (const formatterArgs of [[], "", 42]) {
      write({ formatterArgs })
      expect(loadTerminalConfig()).toEqual({})
    }
  })

  it("accepts boolean header/autoAsk/skipQuota and drops other types", () => {
    write({ header: true, autoAsk: false, skipQuota: true })
    expect(loadTerminalConfig()).toEqual({ header: true, autoAsk: false, skipQuota: true })
    write({ header: "yes", autoAsk: 1, skipQuota: null })
    expect(loadTerminalConfig()).toEqual({})
  })

  it("parses nerdGlyphCells: 1 | 2 | 'auto'", () => {
    for (const nerdGlyphCells of [1, 2, "auto"] as const) {
      write({ nerdGlyphCells })
      expect(loadTerminalConfig()).toEqual({ nerdGlyphCells })
    }
  })

  it("rejects unsupported nerdGlyphCells shapes (strings '1'/'2', 0, 3, null)", () => {
    for (const nerdGlyphCells of ["1", "2", 0, 3, null]) {
      write({ nerdGlyphCells })
      expect(loadTerminalConfig()).toEqual({})
    }
  })

  it("parses scrollback.submittedAt", () => {
    for (const submittedAt of ["inline-locale", "off", false] as const) {
      write({ scrollback: { submittedAt } })
      expect(loadTerminalConfig()).toEqual({ scrollback: { submittedAt } })
    }
  })

  it("drops invalid scrollback.submittedAt", () => {
    for (const scrollback of [{ submittedAt: true }, { submittedAt: "brackets" }, {}]) {
      write({ scrollback })
      expect(loadTerminalConfig()).toEqual({})
    }
  })

  it("core loadUserConfig no longer returns any terminal key (the split)", () => {
    write({
      model: "m",
      spinner: "dots",
      formatter: "bat",
      formatterArgs: ["--x"],
      header: true,
      autoAsk: false,
      skipQuota: true,
      nerdGlyphCells: 2,
      scrollback: { submittedAt: "off" },
      statusBar: { segments: ["quota"] },
    })
    expect(loadUserConfig()).toEqual({ model: "m" })
  })

  it("loadCliUserConfig merges the core runtime keys and the terminal keys", () => {
    write({ model: "m", spinner: "dots", nerdGlyphCells: 2 })
    expect(loadCliUserConfig()).toEqual({ model: "m", spinner: "dots", nerdGlyphCells: 2 })
  })
})
