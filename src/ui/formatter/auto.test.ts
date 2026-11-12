import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BinaryStore } from "@minimal-agent/core/host/binaries"

import {
  extractWithBunArchive,
  MDSTREAM_PIN,
  mdstreamSpecFor,
  type ResolveFormatterDeps,
  resolveFormatter,
} from "./auto.ts"

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

/** A real `.tar.gz` holding `mdstream` (nested, like some release layouts). */
async function tarball(
  body = "#!/bin/sh\necho mdstream 0.3.7\n",
): Promise<Uint8Array<ArrayBuffer>> {
  const blob = await new Bun.Archive({ "pkg/mdstream": body }, { compress: "gzip" }).blob()
  return new Uint8Array(await blob.arrayBuffer())
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

describe("mdstream pin", () => {
  test("every target pins a v-tag download URL and a sha256", () => {
    for (const key of Object.keys(MDSTREAM_PIN.assets)) {
      const spec = mdstreamSpecFor(key)
      expect(spec?.sha256).toMatch(/^[0-9a-f]{64}$/)
      const url = spec?.source.kind === "url" ? spec.source.url : ""
      expect(url).toStartWith(
        `https://github.com/gastonmorixe/mdstream/releases/download/v${MDSTREAM_PIN.version}/`,
      )
      expect(url).not.toContain("api.github.com")
    }
    expect(mdstreamSpecFor("freebsd-x64")).toBeNull()
  })
})

describe("extractWithBunArchive", () => {
  test("extracts without tar and keeps members inside the destination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mdstream-x-"))
    try {
      const blob = await new Bun.Archive(
        { "a/mdstream": "bin", "../escape.txt": "nope" },
        { compress: "gzip" },
      ).blob()
      const archive = join(dir, "in.tar.gz")
      await Bun.write(archive, blob)
      await extractWithBunArchive(archive, join(dir, "out"))
      expect(readFileSync(join(dir, "out/a/mdstream"), "utf8")).toBe("bin")
      expect(existsSync(join(dir, "escape.txt"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("resolveFormatter", () => {
  let binDir: string
  let fetched: string[]

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "mdstream-bin-"))
    fetched = []
  })
  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true })
  })

  /** Deps with no PATH mdstream and a store whose fetch serves `bytes`. */
  function deps(
    bytes: Uint8Array<ArrayBuffer> | null,
    over: Partial<ResolveFormatterDeps> = {},
    versions: Record<string, string | null> = {},
  ): ResolveFormatterDeps {
    return {
      which: () => null,
      queryVersion: async (cmd) => versions[cmd] ?? null,
      platformKey: "linux-x64",
      binDir,
      makeStore: async (dir, onProgress) =>
        new BinaryStore(dir, {
          onProgress,
          extractFn: extractWithBunArchive,
          fetchFn: (async (url: string | URL | Request) => {
            fetched.push(String(url))
            if (!bytes) throw new TypeError("fetch failed: offline")
            return new Response(bytes)
          }) as unknown as typeof fetch,
        }),
      ...over,
    }
  }

  test("an explicit --formatter wins with no lookup", async () => {
    const r = await resolveFormatter(["cat"], deps(null))
    expect(r).toEqual({ cmd: ["cat"], label: "cat" })
    expect(fetched).toEqual([])
  })

  test("mdstream on PATH wins", async () => {
    const r = await resolveFormatter(undefined, deps(null, { which: () => "/usr/bin/mdstream" }))
    expect(r.cmd).toEqual(["mdstream"])
    expect(fetched).toEqual([])
  })

  test("a current managed copy is used with no network", async () => {
    const bin = join(binDir, "mdstream")
    writeFileSync(bin, "old installer copy")
    const r = await resolveFormatter(undefined, deps(null, {}, { [bin]: "v0.3.7" }))
    expect(r.cmd).toEqual([bin])
    expect(strip(r.label ?? "")).toBe("mdstream v0.3.7 (cached)")
    expect(fetched).toEqual([])
  })

  test("fresh install verifies the pinned sha256 and records it in the store", async () => {
    const bytes = await tarball()
    // Pin this test's tarball so the store's sha256 check passes.
    const prev = MDSTREAM_PIN.assets["linux-x64"]!
    MDSTREAM_PIN.assets["linux-x64"] = { asset: prev.asset, sha256: sha256(bytes) }
    try {
      const r = await resolveFormatter(undefined, deps(bytes))
      const bin = join(binDir, "mdstream")
      expect(r.cmd).toEqual([bin])
      expect(fetched).toEqual([
        `https://github.com/gastonmorixe/mdstream/releases/download/v${MDSTREAM_PIN.version}/${prev.asset}`,
      ])
      expect(statSync(bin).mode & 0o111).not.toBe(0)
      const manifest = JSON.parse(readFileSync(join(binDir, ".binaries.json"), "utf8"))
      expect(manifest.entries[0]).toMatchObject({ name: "mdstream", version: MDSTREAM_PIN.version })
    } finally {
      MDSTREAM_PIN.assets["linux-x64"] = prev
    }
  })

  test("a sha256 mismatch installs nothing and warns", async () => {
    const r = await resolveFormatter(undefined, deps(await tarball("tampered")))
    expect(r.cmd).toBeUndefined()
    expect(strip(r.warn ?? "")).toContain("sha256 mismatch")
    expect(existsSync(join(binDir, "mdstream"))).toBe(false)
  })

  test("offline with nothing installed: plain output with a warning, never a throw", async () => {
    const r = await resolveFormatter(undefined, deps(null))
    expect(r.cmd).toBeUndefined()
    expect(strip(r.warn ?? "")).toContain("could not install mdstream")
  })

  test("an older copy is upgraded, and kept when the upgrade fails", async () => {
    const bin = join(binDir, "mdstream")
    writeFileSync(bin, "v0.3.6 copy")
    const r = await resolveFormatter(undefined, deps(null, {}, { [bin]: "v0.3.6" }))
    expect(fetched).toHaveLength(1)
    expect(r.cmd).toEqual([bin])
    expect(readFileSync(bin, "utf8")).toBe("v0.3.6 copy")
  })

  test("an unsupported platform with no copy warns", async () => {
    const r = await resolveFormatter(undefined, deps(null, { platformKey: "freebsd-x64" }))
    expect(r.cmd).toBeUndefined()
    expect(strip(r.warn ?? "")).toContain("no mdstream release")
    expect(fetched).toEqual([])
  })

  test("an unsupported platform still uses an existing copy", async () => {
    const bin = join(binDir, "mdstream")
    writeFileSync(bin, "x")
    const r = await resolveFormatter(undefined, deps(null, { platformKey: "freebsd-x64" }))
    expect(r.cmd).toEqual([bin])
  })
})
