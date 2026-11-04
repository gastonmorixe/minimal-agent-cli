import { describe, expect, test } from "bun:test"

import {
  DEFAULT_HELP_WIDTH,
  MIN_HELP_WIDTH,
  resolveHelpColor,
  resolveHelpPolicy,
  resolveHelpWidth,
} from "./policy.ts"

describe("resolveHelpWidth (SPEC-HELP R-28)", () => {
  test("explicit wins over every other source", () => {
    expect(resolveHelpWidth({ COLUMNS: "100" }, { explicit: 60, output: 90, stdout: 110 })).toBe(60)
  })

  test("output.columns wins over COLUMNS and stdout", () => {
    expect(resolveHelpWidth({ COLUMNS: "100" }, { output: 90, stdout: 110 })).toBe(90)
  })

  test("COLUMNS wins over stdout.columns", () => {
    expect(resolveHelpWidth({ COLUMNS: "100" }, { stdout: 110 })).toBe(100)
  })

  test("stdout.columns is used when nothing else is set", () => {
    expect(resolveHelpWidth({}, { stdout: 110 })).toBe(110)
  })

  test("falls back to 80", () => {
    expect(resolveHelpWidth({})).toBe(DEFAULT_HELP_WIDTH)
    expect(DEFAULT_HELP_WIDTH).toBe(80)
  })

  test("skips invalid values", () => {
    expect(resolveHelpWidth({ COLUMNS: "abc" }, { explicit: 0, output: -5, stdout: 70 })).toBe(70)
    expect(resolveHelpWidth({ COLUMNS: "" })).toBe(80)
    expect(resolveHelpWidth({ COLUMNS: "12px" })).toBe(80)
    expect(resolveHelpWidth({}, { explicit: Number.NaN })).toBe(80)
  })

  test("raises a tiny width to the minimum and floors fractions", () => {
    expect(resolveHelpWidth({ COLUMNS: "5" })).toBe(MIN_HELP_WIDTH)
    expect(resolveHelpWidth({}, { explicit: 99.7 })).toBe(99)
  })
})

describe("resolveHelpColor (SPEC-HELP R-29)", () => {
  test("color on a TTY with a clean env", () => {
    expect(resolveHelpColor({}, true)).toBe(true)
    expect(resolveHelpColor({ TERM: "xterm-256color" }, true)).toBe(true)
  })

  test("no color when the stream is not a TTY", () => {
    expect(resolveHelpColor({}, false)).toBe(false)
    expect(resolveHelpColor({}, undefined)).toBe(false)
  })

  test("NO_COLOR set and not empty disables color, for any value", () => {
    for (const value of ["1", "0", "false", "yes", " "]) {
      expect(resolveHelpColor({ NO_COLOR: value }, true)).toBe(false)
    }
  })

  test("an empty NO_COLOR is ignored (https://no-color.org/)", () => {
    expect(resolveHelpColor({ NO_COLOR: "" }, true)).toBe(true)
  })

  test("TERM=dumb disables color", () => {
    expect(resolveHelpColor({ TERM: "dumb" }, true)).toBe(false)
  })

  test("--no-color disables color", () => {
    expect(resolveHelpColor({}, true, true)).toBe(false)
  })
})

describe("resolveHelpPolicy", () => {
  test("combines width and color for one stream", () => {
    expect(
      resolveHelpPolicy({
        env: { COLUMNS: "120" },
        isTTY: true,
        columns: { stdout: 90 },
      }),
    ).toEqual({ width: 120, color: true })
  })

  test("the flag turns color off on a TTY", () => {
    expect(resolveHelpPolicy({ env: {}, isTTY: true, flags: { noColor: true } })).toEqual({
      width: 80,
      color: false,
    })
  })

  test("decides per stream: the same env gives color on a TTY only", () => {
    const env = { TERM: "xterm" }
    expect(resolveHelpPolicy({ env, isTTY: true }).color).toBe(true)
    expect(resolveHelpPolicy({ env, isTTY: false }).color).toBe(false)
  })
})
