import { describe, expect, test } from "bun:test"

import {
  assetName,
  candidateTargetIds,
  detectAvx2,
  detectHost,
  detectMusl,
  type HostProbes,
  pickAsset,
  UnsupportedHostError,
} from "./target.ts"

const probes = (over: Partial<HostProbes>): HostProbes => ({
  platform: "linux",
  arch: "x64",
  libEntries: () => [],
  lddVersion: () => "ldd (GNU libc) 2.41",
  cpuinfo: () => "processor : 0\nflags : fpu sse4_2 avx avx2 bmi2\n",
  ...over,
})

describe("detection", () => {
  test("musl from /lib/ld-musl-* or ldd, glibc without ldd", () => {
    expect(detectMusl(probes({ libEntries: () => ["ld-musl-x86_64.so.1"] }))).toBe(true)
    expect(detectMusl(probes({ lddVersion: () => "musl libc (x86_64)\nVersion 1.2.5" }))).toBe(true)
    expect(detectMusl(probes({ lddVersion: () => undefined }))).toBe(false)
    expect(detectMusl(probes({}))).toBe(false)
  })

  test("avx2 from cpuinfo flags, unknown counts as present", () => {
    expect(detectAvx2("flags : fpu sse4_2 avx avx2\nflags : fpu avx2\n")).toBe(true)
    expect(detectAvx2("flags : fpu sse4_2 avx\n")).toBe(false)
    expect(detectAvx2(undefined)).toBe(true)
    expect(detectAvx2("Features : fp asimd\n")).toBe(true)
  })

  test("detectHost reads cpuinfo only on linux x64", () => {
    let read = 0
    const cpuinfo = () => {
      read++
      return "flags : fpu\n"
    }
    expect(detectHost(probes({ cpuinfo })).avx2).toBe(false)
    expect(detectHost(probes({ arch: "arm64", cpuinfo })).avx2).toBe(true)
    expect(detectHost(probes({ platform: "darwin", cpuinfo })).musl).toBe(false)
    expect(read).toBe(1)
  })
})

describe("candidateTargetIds", () => {
  const host = (over: object) => ({
    platform: "linux",
    arch: "x64",
    musl: false,
    avx2: true,
    ...over,
  })
  test("every release target", () => {
    expect(candidateTargetIds(host({}))).toEqual(["linux-x64", "linux-x64-baseline"])
    expect(candidateTargetIds(host({ avx2: false }))).toEqual(["linux-x64-baseline"])
    expect(candidateTargetIds(host({ musl: true }))).toEqual(["linux-x64-musl"])
    expect(candidateTargetIds(host({ arch: "arm64" }))).toEqual(["linux-arm64"])
    expect(candidateTargetIds(host({ arch: "arm64", musl: true }))).toEqual(["linux-arm64-musl"])
    expect(candidateTargetIds(host({ platform: "darwin", arch: "arm64" }))).toEqual([
      "darwin-arm64",
    ])
    expect(candidateTargetIds(host({ platform: "darwin" }))).toEqual(["darwin-x64"])
  })

  test("windows and odd arches are refused", () => {
    expect(() => candidateTargetIds(host({ platform: "win32" }))).toThrow(UnsupportedHostError)
    expect(() => candidateTargetIds(host({ arch: "ia32" }))).toThrow(UnsupportedHostError)
  })
})

describe("pickAsset", () => {
  const label = "0.1.0-nightly.20261112T200000Z"
  const assets = (ids: string[]) => ids.map((id) => ({ name: assetName(label, id) }))
  const host = { platform: "linux", arch: "x64", musl: false, avx2: true }

  test("the best id, else the baseline fallback", () => {
    expect(pickAsset(label, host, assets(["linux-x64", "linux-x64-baseline"]))).toMatchObject({
      id: "linux-x64",
      fallback: false,
    })
    expect(pickAsset(label, host, assets(["linux-x64-baseline"]))).toMatchObject({
      id: "linux-x64-baseline",
      fallback: true,
    })
  })

  test("no AVX2 never gets the default x64 build; musl never gets glibc", () => {
    expect(pickAsset(label, { ...host, avx2: false }, assets(["linux-x64"]))).toBeUndefined()
    expect(pickAsset(label, { ...host, musl: true }, assets(["linux-x64"]))).toBeUndefined()
    expect(
      pickAsset(label, { ...host, musl: true }, assets(["linux-x64", "linux-x64-musl"]))?.id,
    ).toBe("linux-x64-musl")
  })

  test("asset names match scripts/release/lib.ts", () => {
    expect(assetName("0.1.0", "darwin-arm64")).toBe("minimal-agent-0.1.0-darwin-arm64.tar.gz")
  })
})
