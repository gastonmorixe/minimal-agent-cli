import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeTar, makeTarGz } from "../test-utils/update-fakes.ts"
import { ArchiveError, extractFromTarGz, parseSha256Sums, readTar, sha256Hex } from "./archive.ts"

describe("parseSha256Sums", () => {
  test("text and binary mode lines, junk skipped", () => {
    const a = "a".repeat(64)
    const b = "B".repeat(64)
    const sums = parseSha256Sums(`${a}  one.tar.gz\n${b} *build-info.json\nnot a line\n`)
    expect(sums.get("one.tar.gz")).toBe(a)
    expect(sums.get("build-info.json")).toBe("b".repeat(64))
    expect(sums.size).toBe(2)
  })
})

describe("tar reader", () => {
  test("reads our own ustar writer", () => {
    const bin = new Uint8Array(1300).fill(7)
    const entries = readTar(makeTar({ a: new Uint8Array([1]), "minimal-agent": bin }))
    expect(entries.map((e) => e.name)).toEqual(["a", "minimal-agent"])
    expect(entries[1]?.data).toEqual(bin)
    expect(entries[1]?.mode).toBe(0o755)
  })

  test("extracts the binary from a gzipped tarball", () => {
    const bin = new TextEncoder().encode("hello binary")
    expect(extractFromTarGz(makeTarGz(bin), "minimal-agent")).toEqual(bin)
  })

  test("missing member, not gzip, truncated", () => {
    const tgz = Bun.gzipSync(makeTar({ other: new Uint8Array([1]) }) as Uint8Array<ArrayBuffer>)
    expect(() => extractFromTarGz(tgz, "minimal-agent")).toThrow(ArchiveError)
    expect(() => extractFromTarGz(new Uint8Array([1, 2, 3]), "minimal-agent")).toThrow(ArchiveError)
    const tar = makeTar({ big: new Uint8Array(2000) })
    expect(() => readTar(tar.subarray(0, 1024))).toThrow(ArchiveError)
  })

  test("reads a tarball written by the system tar (the release format)", () => {
    if (!Bun.which("tar")) return
    const dir = mkdtempSync(join(tmpdir(), "ma-update-tar-"))
    try {
      const data = new Uint8Array(70_000).map((_, i) => i % 251)
      writeFileSync(join(dir, "minimal-agent"), data)
      writeFileSync(join(dir, "LICENSE"), "x")
      const out = join(dir, "t.tar.gz")
      const r = Bun.spawnSync(
        ["tar", "--format", "ustar", "-czf", out, "-C", dir, "LICENSE", "minimal-agent"],
        { stderr: "pipe" },
      )
      expect(r.exitCode).toBe(0)
      const got = extractFromTarGz(new Uint8Array(readFileSync(out)), "minimal-agent")
      expect(sha256Hex(got)).toBe(sha256Hex(data))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
