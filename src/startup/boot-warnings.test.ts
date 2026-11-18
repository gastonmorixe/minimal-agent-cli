/**
 * The formatter and spinner boot warnings go to the diagnostic bus, with their
 * plain text, and write nothing to `process.stderr` or `console.error`.
 *
 * `resolveFormatter` and `resolveSpinnerPreset` are the real producers of the
 * text, so these tests feed their real output through the helpers.
 *
 * @module startup/boot-warnings.test
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { getDiagnosticBus, type LogEvent, Severity } from "@minimal-agent/core/host/diagnostics"

import { resolveFormatter } from "../ui/formatter/auto.ts"
import { resolveSpinnerPreset } from "../ui/spinner/named-presets.ts"
import { warnFormatterUnavailable, warnUnknownSpinnerPreset } from "./boot-warnings.ts"

const ESC = String.fromCodePoint(0x1b)

describe("boot warnings go to the diagnostic bus", () => {
  let events: LogEvent[] = []
  let unsubscribe: (() => void) | undefined
  let stderrWrite: ReturnType<typeof spyOn<typeof process.stderr, "write">>
  let consoleError: ReturnType<typeof spyOn<typeof console, "error">>

  beforeEach(() => {
    events = []
    unsubscribe = getDiagnosticBus().on("*", (e) => events.push(e))
    stderrWrite = spyOn(process.stderr, "write").mockImplementation(() => true)
    consoleError = spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    consoleError.mockRestore()
    stderrWrite.mockRestore()
    unsubscribe?.()
    unsubscribe = undefined
  })

  const bySource = (source: string): LogEvent[] => events.filter((e) => e.source === source)

  it("formatter.unavailable: a Warning with the plain reason, from a real resolveFormatter warn", async () => {
    // Offline, nothing installed, a platform with no release: the real `warn` text.
    const resolution = await resolveFormatter(undefined, {
      which: () => null,
      queryVersion: async () => null,
      platformKey: "freebsd-x64",
      binDir: "/nonexistent/ma-test-bin-dir",
      fetchFn: (async () => {
        throw new TypeError("offline")
      }) as unknown as typeof fetch,
    })
    expect(resolution.cmd).toBeUndefined()
    const warn = resolution.warn ?? ""

    warnFormatterUnavailable(warn)

    const got = bySource("formatter.unavailable")
    expect(got).toHaveLength(1)
    expect(got[0]?.severity).toBe(Severity.Warning)
    expect(got[0]?.message).toBe("markdown formatter unavailable; output stays plain")
    const reason = got[0]?.structuredData?.reason
    expect(typeof reason).toBe("string")
    expect(String(reason)).toContain("no mdstream release")
    expect(String(reason)).toContain("--formatter <cmd>")
    expect(String(reason)).not.toContain(ESC)
    expect(String(reason)).not.toContain("\n")
    expect(stderrWrite).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it("formatter.unavailable: strips escapes a hostile reason could carry", () => {
    warnFormatterUnavailable(
      `${ESC}]0;pwned\x07could not install mdstream: ${ESC}[31mboom${ESC}[0m\n`,
    )
    const reason = bySource("formatter.unavailable")[0]?.structuredData?.reason
    expect(reason).toBe("could not install mdstream: boom")
  })

  it("spinner.unknown-preset: a Warning with the plain line, from a real resolveSpinnerPreset", () => {
    const spinner = resolveSpinnerPreset("no-such-spinner", warnUnknownSpinnerPreset)
    expect(spinner).toBeUndefined()

    const got = bySource("spinner.unknown-preset")
    expect(got).toHaveLength(1)
    expect(got[0]?.severity).toBe(Severity.Warning)
    expect(got[0]?.message).toBe(
      'unknown spinner preset "no-such-spinner". Run with --list-spinners to see available ids.',
    )
    expect(got[0]?.message).not.toContain(ESC)
    expect(stderrWrite).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it("spinner.unknown-preset: a known preset and no preset emit nothing", () => {
    expect(resolveSpinnerPreset(undefined, warnUnknownSpinnerPreset)).toBeUndefined()
    expect(resolveSpinnerPreset("default", warnUnknownSpinnerPreset)).toBeDefined()
    expect(bySource("spinner.unknown-preset")).toEqual([])
  })

  it("main.ts hands both warnings to these helpers (no console.error left for them)", () => {
    // `main()` cannot run in a unit test, so pin its wiring in the source.
    const main = readFileSync(join(import.meta.dir, "..", "main.ts"), "utf8")
    expect(main).toContain("warnFormatterUnavailable(formatterResolution.warn)")
    expect(main).toContain("resolveSpinnerPreset(spinnerName, warnUnknownSpinnerPreset)")
    expect(main).not.toMatch(/console\.error\([^)]*formatterResolution/)
    expect(main).not.toMatch(/resolveSpinnerPreset\([^)]*console\.error/)
  })
})
