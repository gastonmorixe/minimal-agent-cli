/**
 * Unit tests for the build identity accessor (plan 2.1, 2.2).
 *
 * @module cli/build-info.test
 */

import { describe, expect, test } from "bun:test"

import {
  buildInfo,
  formatVersionLine,
  normalizeBuildInfo,
  recordedAgentVersion,
  shortSha,
} from "./build-info.ts"

const SHA = "0123456789abcdef0123456789abcdef01234567"

describe("buildInfo from source (no define)", () => {
  test("dev SHAs, source mode, the package version", () => {
    const info = buildInfo()
    expect(info.mode).toBe("source")
    expect(info.cliSha).toBe("dev")
    expect(info.coreSha).toBe("dev")
    expect(info.pluginsSha).toBe("dev")
    expect(info.dirty).toBe(false)
    expect(info.bunVersion).toBe(Bun.version)
    expect(info.target).toBe(`${process.platform}-${process.arch}`)
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe("normalizeBuildInfo", () => {
  test("keeps a full define", () => {
    const raw = {
      version: "1.2.3",
      cliSha: SHA,
      coreSha: SHA,
      pluginsSha: SHA,
      dirty: true,
      bunVersion: "1.4.4",
      target: "linux-x64",
      mode: "release" as const,
      builtAt: "2026-11-12T00:00:00.000Z",
    }
    expect(normalizeBuildInfo(raw)).toEqual(raw)
  })

  test("bad fields get defaults", () => {
    const info = normalizeBuildInfo({ cliSha: "", mode: "weird" as "dev" })
    expect(info.cliSha).toBe("dev")
    expect(info.mode).toBe("source")
  })
})

describe("formatVersionLine", () => {
  test("one line with short SHAs", () => {
    const info = normalizeBuildInfo({
      version: "0.1.0",
      cliSha: SHA,
      coreSha: SHA,
      pluginsSha: "dev",
      bunVersion: "1.4.4",
      target: "linux-arm64",
      mode: "dev",
      builtAt: "2026-11-12T00:00:00.000Z",
    })
    expect(formatVersionLine(info)).toBe(
      "minimal-agent 0.1.0 (cli 0123456, core 0123456, plugins dev) bun 1.4.4 linux-arm64 dev built 2026-11-12T00:00:00.000Z",
    )
  })

  test("a dirty build says so", () => {
    expect(formatVersionLine(normalizeBuildInfo({ mode: "dev", dirty: true }))).toContain(
      " dev+dirty ",
    )
  })
})

describe("shortSha and recordedAgentVersion", () => {
  test("shortSha", () => {
    expect(shortSha(SHA)).toBe("0123456")
    expect(shortSha("dev")).toBe("dev")
  })

  test("source keeps the plain semver, a binary adds build metadata", () => {
    expect(recordedAgentVersion("0.1.0", normalizeBuildInfo(undefined))).toBe("0.1.0")
    expect(
      recordedAgentVersion("0.1.0", normalizeBuildInfo({ cliSha: SHA, mode: "release" })),
    ).toBe("0.1.0+0123456.release")
    expect(
      recordedAgentVersion("0.1.0", normalizeBuildInfo({ cliSha: SHA, mode: "dev", dirty: true })),
    ).toBe("0.1.0+0123456.dev.dirty")
  })
})
