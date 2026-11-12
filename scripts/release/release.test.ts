import { describe, expect, test } from "bun:test"

import { assetName, parseFlags, ReleaseError, VERSION_RE } from "./lib.ts"
import { NIGHTLY_TAG_RE, planPrune } from "./prune-nightlies.ts"
import { findReleaseTarget, matrixLegs, RELEASE_TARGETS } from "./targets.ts"

const nightly = (stamp: string, version = "0.1.0") => `v${version}-nightly.${stamp}`

describe("planPrune", () => {
  const stamps = Array.from(
    { length: 10 },
    (_, i) => `202611${String(i + 1).padStart(2, "0")}T120000Z`,
  )

  test("keeps the newest N published nightlies and deletes the rest with their tags", () => {
    const releases = stamps.map((s) => ({ tagName: nightly(s), isDraft: false }))
    const plan = planPrune(
      releases,
      releases.map((r) => r.tagName),
      7,
    )
    expect(plan.keep).toEqual(
      stamps
        .slice(3)
        .reverse()
        .map((s) => nightly(s)),
    )
    expect(plan.deleteReleases).toEqual(
      stamps
        .slice(0, 3)
        .reverse()
        .map((s) => nightly(s)),
    )
    expect(plan.deleteTags).toEqual([])
  })

  test("orders by stamp, not by version", () => {
    const releases = [
      { tagName: nightly("20261101T000000Z", "0.2.0"), isDraft: false },
      { tagName: nightly("20261102T000000Z", "0.1.0"), isDraft: false },
    ]
    expect(planPrune(releases, [], 1).deleteReleases).toEqual([
      nightly("20261101T000000Z", "0.2.0"),
    ])
  })

  test("never touches stable releases or other tags", () => {
    const releases = [
      { tagName: "v0.1.0", isDraft: false },
      { tagName: "v0.1.0-rc.1", isDraft: false },
      { tagName: nightly("20261101T000000Z"), isDraft: false },
    ]
    const plan = planPrune(releases, ["v0.1.0", "v0.1.0-rc.1", "latest"], 1)
    expect(plan.deleteReleases).toEqual([])
    expect(plan.deleteTags).toEqual([])
  })

  test("deletes drafts and orphan nightly tags, keeps the current tag", () => {
    const current = nightly("20261110T000000Z")
    const releases = [
      { tagName: nightly("20261105T000000Z"), isDraft: true },
      { tagName: current, isDraft: true },
      { tagName: nightly("20261101T000000Z"), isDraft: false },
    ]
    const orphan = nightly("20261103T000000Z")
    const plan = planPrune(releases, [orphan, nightly("20261101T000000Z")], 7, current)
    expect(plan.deleteReleases).toEqual([nightly("20261105T000000Z")])
    expect(plan.deleteTags).toEqual([orphan])
    expect(plan.keep).toContain(current)
  })

  test("the nightly tag pattern is exact", () => {
    expect(NIGHTLY_TAG_RE.test(nightly("20261112T190000Z"))).toBe(true)
    expect(NIGHTLY_TAG_RE.test("v0.1.0-nightly.20261112")).toBe(false)
    expect(NIGHTLY_TAG_RE.test("0.1.0-nightly.20261112T190000Z")).toBe(false)
  })
})

describe("targets", () => {
  test("seven macOS and Linux targets, no Windows, priority first", () => {
    expect(RELEASE_TARGETS.map((t) => t.id)).toEqual([
      "darwin-arm64",
      "linux-x64",
      "darwin-x64",
      "linux-x64-baseline",
      "linux-x64-musl",
      "linux-arm64",
      "linux-arm64-musl",
    ])
    expect(RELEASE_TARGETS.filter((t) => t.priority).map((t) => t.id)).toEqual([
      "darwin-arm64",
      "linux-x64",
    ])
  })

  test("finds a target by id, by Bun string, and reads aarch64 as arm64", () => {
    expect(findReleaseTarget("linux-x64-musl")?.bun).toBe("bun-linux-x64-musl")
    expect(findReleaseTarget("bun-darwin-arm64")?.id).toBe("darwin-arm64")
    expect(findReleaseTarget("bun-linux-aarch64")?.id).toBe("linux-arm64")
    expect(findReleaseTarget("bun-windows-x64")).toBeUndefined()
  })

  test("matrix legs group by runner and cover every target once", () => {
    const legs = matrixLegs(false)
    expect(legs.map((l) => l.runner)).toEqual(["macos-latest", "ubuntu-latest", "ubuntu-24.04-arm"])
    const ids = legs.flatMap((l) => l.targets.split(" "))
    expect(ids.sort()).toEqual(RELEASE_TARGETS.map((t) => t.id).sort())
    expect(matrixLegs(true).find((l) => l.runner === "macos-15-intel")?.targets).toBe("darwin-x64")
  })
})

describe("lib", () => {
  test("asset names follow minimal-agent-<version>-<id>.tar.gz", () => {
    expect(assetName("0.1.0-nightly.20261112T190000Z", "linux-x64-musl")).toBe(
      "minimal-agent-0.1.0-nightly.20261112T190000Z-linux-x64-musl.tar.gz",
    )
  })

  test("version labels", () => {
    expect(VERSION_RE.test("0.1.0")).toBe(true)
    expect(VERSION_RE.test("0.1.0-nightly.20261112T190000Z")).toBe(true)
    expect(VERSION_RE.test("v0.1.0")).toBe(false)
  })

  test("parseFlags rejects unknown, repeated and valueless flags", () => {
    expect(parseFlags(["--a", "1", "--b"], ["a"], ["b"])).toEqual({ a: "1", b: "true" })
    expect(() => parseFlags(["--x"], ["a"])).toThrow(ReleaseError)
    expect(() => parseFlags(["--a", "1", "--a", "2"], ["a"])).toThrow(ReleaseError)
    expect(() => parseFlags(["--a"], ["a"])).toThrow(ReleaseError)
  })
})
