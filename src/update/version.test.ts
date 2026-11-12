import { describe, expect, test } from "bun:test"

import { compareSemver, compareVersions, parseLabel, parseStamp, tagOf } from "./version.ts"

const L = (s: string) => {
  const l = parseLabel(s)
  if (l === undefined) throw new Error(`bad label ${s}`)
  return l
}

describe("parseLabel", () => {
  test("stable, nightly, tag forms, build metadata", () => {
    expect(L("v0.2.0")).toMatchObject({ label: "0.2.0", major: 0, minor: 2, patch: 0, pre: [] })
    expect(L("0.2.0").channel).toBe("stable")
    const n = L("v0.1.0-nightly.20261112T200000Z")
    expect(n.channel).toBe("nightly")
    expect(n.label).toBe("0.1.0-nightly.20261112T200000Z")
    expect(n.stamp?.toISOString()).toBe("2026-11-12T20:00:00.000Z")
    expect(L("0.1.0+abc1234.release").label).toBe("0.1.0")
    expect(L("0.1.0-rc.1").channel).toBe("other")
  })

  test("rejects non-labels", () => {
    expect(parseLabel("latest")).toBeUndefined()
    expect(parseLabel("1.2")).toBeUndefined()
    expect(parseLabel("")).toBeUndefined()
  })

  test("parseStamp and tagOf", () => {
    expect(parseStamp("20261301T000000Z")).toBeUndefined()
    expect(parseStamp("nope")).toBeUndefined()
    expect(tagOf("0.1.0")).toBe("v0.1.0")
    expect(tagOf("v0.1.0")).toBe("v0.1.0")
  })
})

describe("compareSemver", () => {
  test("numbers, then stable above pre-release, nightly stamps by time", () => {
    expect(compareSemver(L("0.10.0"), L("0.9.9"))).toBe(1)
    expect(compareSemver(L("0.1.0"), L("0.1.0-nightly.20261112T200000Z"))).toBe(1)
    expect(
      compareSemver(L("0.1.0-nightly.20261113T000000Z"), L("0.1.0-nightly.20261112T235959Z")),
    ).toBe(1)
    expect(compareSemver(L("1.0.0"), L("1.0.0"))).toBe(0)
  })
})

describe("compareVersions (update order)", () => {
  const nightly = (stamp: string) => ({ label: L(`0.1.0-nightly.${stamp}`) })

  test("x.y.z wins first", () => {
    expect(compareVersions({ label: L("0.2.0") }, nightly("20991231T000000Z"))).toBe(1)
    expect(compareVersions(nightly("20200101T000000Z"), { label: L("0.0.9") })).toBe(1)
  })

  test("a nightly cut after stable 0.1.0 is newer than it (unlike semver)", () => {
    const stable = { label: L("0.1.0"), time: new Date("2026-11-01T00:00:00Z") }
    expect(compareVersions(nightly("20261112T200000Z"), stable)).toBe(1)
    expect(compareVersions(stable, nightly("20261112T200000Z"))).toBe(-1)
  })

  test("the running binary: x.y.z plus builtAt against a nightly stamp", () => {
    const running = { label: L("0.1.0"), time: new Date("2026-11-12T20:00:01Z") }
    // Same nightly (stamp and build time a second apart).
    expect(compareVersions(nightly("20261112T200000Z"), running)).toBe(0)
    // The next day's nightly.
    expect(compareVersions(nightly("20261113T061700Z"), running)).toBe(1)
    // An older nightly.
    expect(compareVersions(nightly("20261110T061700Z"), running)).toBe(-1)
  })

  test("no time: equal labels are the same, else semver", () => {
    expect(compareVersions({ label: L("0.1.0") }, { label: L("0.1.0") })).toBe(0)
    expect(compareVersions({ label: L("0.1.0") }, { label: L("0.1.0-rc.1") })).toBe(1)
  })
})
