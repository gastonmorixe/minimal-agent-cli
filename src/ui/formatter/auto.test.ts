import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  extractWithBunArchive,
  fetchLatestTag,
  MDSTREAM_ASSETS,
  mdstreamUrlFor,
  type ResolveFormatterDeps,
  resolveFormatter,
} from "./auto.ts"

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

const REL = "https://github.com/gastonmorixe/mdstream/releases"

/** A real `.tar.gz` holding `mdstream` (nested, like some release layouts). */
async function tarball(
  body = "#!/bin/sh\necho mdstream 0.3.9\n",
): Promise<Uint8Array<ArrayBuffer>> {
  const blob = await new Bun.Archive({ "pkg/mdstream": body }, { compress: "gzip" }).blob()
  return new Uint8Array(await blob.arrayBuffer())
}

describe("mdstream urls", () => {
  test("tagged and latest-alias download URLs, never the API", () => {
    for (const key of Object.keys(MDSTREAM_ASSETS)) {
      const asset = MDSTREAM_ASSETS[key]
      expect(mdstreamUrlFor(key, "v0.3.9")).toBe(`${REL}/download/v0.3.9/${asset}`)
      expect(mdstreamUrlFor(key)).toBe(`${REL}/latest/download/${asset}`)
    }
    expect(mdstreamUrlFor("freebsd-x64")).toBeNull()
  })

  test("fetchLatestTag reads the releases/latest redirect", async () => {
    const f = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: `${REL}/tag/v0.3.9` },
      })) as unknown as typeof fetch
    expect(await fetchLatestTag(f)).toBe("v0.3.9")
    const offline = (async () => {
      throw new TypeError("offline")
    }) as unknown as typeof fetch
    expect(await fetchLatestTag(offline)).toBeNull()
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

  /**
   * Deps with no PATH mdstream. `latest` is the tag the redirect names (null:
   * lookup fails); `bytes` is what a download serves (null: offline).
   */
  function deps(
    bytes: Uint8Array<ArrayBuffer> | null,
    latest: string | null,
    over: Partial<ResolveFormatterDeps> = {},
    versions: Record<string, string | null> = {},
  ): ResolveFormatterDeps {
    return {
      which: () => null,
      queryVersion: async (cmd) => versions[cmd] ?? null,
      platformKey: "linux-x64",
      binDir,
      fetchFn: (async (url: string | URL | Request) => {
        const u = String(url)
        fetched.push(u)
        if (u.endsWith("/releases/latest")) {
          if (!latest) throw new TypeError("fetch failed: offline")
          return new Response(null, { status: 302, headers: { location: `${REL}/tag/${latest}` } })
        }
        if (!bytes) throw new TypeError("fetch failed: offline")
        return new Response(bytes)
      }) as unknown as typeof fetch,
      ...over,
    }
  }

  test("an explicit --formatter wins with no lookup", async () => {
    const r = await resolveFormatter(["cat"], deps(null, null))
    expect(r).toEqual({ cmd: ["cat"], label: "cat" })
    expect(fetched).toEqual([])
  })

  test("mdstream on PATH wins", async () => {
    const r = await resolveFormatter(
      undefined,
      deps(null, "v0.3.9", { which: () => "/usr/bin/mdstream" }),
    )
    expect(r.cmd).toEqual(["mdstream"])
    expect(fetched).toEqual([])
  })

  test("a copy at the latest version is used with no download", async () => {
    const bin = join(binDir, "mdstream")
    writeFileSync(bin, "current copy")
    const r = await resolveFormatter(undefined, deps(null, "v0.3.9", {}, { [bin]: "v0.3.9" }))
    expect(r.cmd).toEqual([bin])
    expect(strip(r.label ?? "")).toBe("mdstream v0.3.9 (cached)")
    expect(fetched).toEqual([`${REL}/latest`])
  })

  test("fresh install downloads the latest release, no checksum", async () => {
    const r = await resolveFormatter(undefined, deps(await tarball(), "v0.3.9"))
    const bin = join(binDir, "mdstream")
    expect(r.cmd).toEqual([bin])
    expect(fetched).toEqual([
      `${REL}/latest`,
      `${REL}/download/v0.3.9/${MDSTREAM_ASSETS["linux-x64"]}`,
    ])
    expect(readFileSync(bin, "utf8")).toContain("mdstream 0.3.9")
    expect(statSync(bin).mode & 0o111).not.toBe(0)
    expect(strip(r.label ?? "")).toBe("mdstream v0.3.9 (auto-downloaded)")
  })

  test("an older copy is upgraded to the latest", async () => {
    const bin = join(binDir, "mdstream")
    writeFileSync(bin, "v0.3.7 copy")
    const r = await resolveFormatter(
      undefined,
      deps(await tarball(), "v0.3.9", {}, { [bin]: "v0.3.7" }),
    )
    expect(r.cmd).toEqual([bin])
    expect(readFileSync(bin, "utf8")).toContain("mdstream 0.3.9")
  })

  test("an older copy is kept when the upgrade download fails", async () => {
    const bin = join(binDir, "mdstream")
    writeFileSync(bin, "v0.3.7 copy")
    const r = await resolveFormatter(undefined, deps(null, "v0.3.9", {}, { [bin]: "v0.3.7" }))
    expect(fetched).toHaveLength(2)
    expect(r.cmd).toEqual([bin])
    expect(readFileSync(bin, "utf8")).toBe("v0.3.7 copy")
  })

  test("offline with a copy: keep it, no download", async () => {
    const bin = join(binDir, "mdstream")
    writeFileSync(bin, "v0.3.7 copy")
    const r = await resolveFormatter(undefined, deps(null, null, {}, { [bin]: "v0.3.7" }))
    expect(r.cmd).toEqual([bin])
    expect(fetched).toEqual([`${REL}/latest`])
  })

  test("lookup fails with nothing installed: falls back to the latest alias", async () => {
    const r = await resolveFormatter(undefined, deps(await tarball(), null))
    expect(r.cmd).toEqual([join(binDir, "mdstream")])
    expect(fetched[1]).toBe(`${REL}/latest/download/${MDSTREAM_ASSETS["linux-x64"]}`)
  })

  test("offline with nothing installed: plain output with a warning, never a throw", async () => {
    const r = await resolveFormatter(undefined, deps(null, null))
    expect(r.cmd).toBeUndefined()
    expect(strip(r.warn ?? "")).toContain("could not install mdstream")
  })

  test("a bad archive installs nothing and warns", async () => {
    const r = await resolveFormatter(
      undefined,
      deps(new Uint8Array(new TextEncoder().encode("not a tarball")), "v0.3.9"),
    )
    expect(r.cmd).toBeUndefined()
    expect(existsSync(join(binDir, "mdstream"))).toBe(false)
  })

  test("an unsupported platform with no copy warns", async () => {
    const r = await resolveFormatter(
      undefined,
      deps(null, "v0.3.9", { platformKey: "freebsd-x64" }),
    )
    expect(r.cmd).toBeUndefined()
    expect(strip(r.warn ?? "")).toContain("no mdstream release")
    expect(fetched).toEqual([])
  })

  test("an unsupported platform still uses an existing copy", async () => {
    const bin = join(binDir, "mdstream")
    writeFileSync(bin, "x")
    const r = await resolveFormatter(
      undefined,
      deps(null, "v0.3.9", { platformKey: "freebsd-x64" }),
    )
    expect(r.cmd).toEqual([bin])
  })
})
