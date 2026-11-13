import { describe, expect, test } from "bun:test"
import { applyFormatterDefaults, isMdstream } from "./defaults.ts"

describe("isMdstream", () => {
  test("matches bare name, paths, and .exe", () => {
    expect(isMdstream("mdstream")).toBe(true)
    expect(isMdstream("/home/u/.minimal-agent/bin/mdstream")).toBe(true)
    expect(isMdstream("C:\\bin\\mdstream.exe")).toBe(true)
  })

  test("rejects other formatters", () => {
    expect(isMdstream("glow")).toBe(false)
    expect(isMdstream("/usr/bin/mdstream-old")).toBe(false)
    expect(isMdstream(undefined)).toBe(false)
  })
})

describe("applyFormatterDefaults", () => {
  test("adds --table-fit to mdstream when nothing is set", () => {
    const r = applyFormatterDefaults(["mdstream"], [], {})
    expect(r.cmd).toEqual(["mdstream", "--table-fit"])
    expect(r.defaulted).toEqual(["--table-fit"])
  })

  test("keeps user extra args before the default", () => {
    const r = applyFormatterDefaults(["/x/mdstream"], ["--padding", "2"], {})
    expect(r.cmd).toEqual(["/x/mdstream", "--padding", "2", "--table-fit"])
  })

  test("respects --table-fit in extra args", () => {
    const r = applyFormatterDefaults(["mdstream"], ["--table-fit=false"], {})
    expect(r.cmd).toEqual(["mdstream", "--table-fit=false"])
    expect(r.defaulted).toEqual([])
  })

  test("respects --table-fit in the explicit formatter command", () => {
    const r = applyFormatterDefaults(["mdstream", "--table-fit", "false"], [], {})
    expect(r.cmd).toEqual(["mdstream", "--table-fit", "false"])
    expect(r.defaulted).toEqual([])
  })

  test("respects MDSTREAM_TABLE_FIT, even when empty", () => {
    expect(
      applyFormatterDefaults(["mdstream"], [], { MDSTREAM_TABLE_FIT: "false" }).defaulted,
    ).toEqual([])
    expect(applyFormatterDefaults(["mdstream"], [], { MDSTREAM_TABLE_FIT: "" }).defaulted).toEqual(
      [],
    )
  })

  test("leaves other formatters alone", () => {
    const r = applyFormatterDefaults(["glow", "-"], ["-s", "dark"], {})
    expect(r.cmd).toEqual(["glow", "-", "-s", "dark"])
    expect(r.defaulted).toEqual([])
  })
})
