/**
 * Test fakes for `src/update`: an in-memory filesystem, a fake binary exec,
 * a fake GitHub API, and a tarball builder. Used by the update tests only.
 *
 * A fake "binary" is the JSON text of its build info, and the fake exec
 * answers `<bin> version --json` by printing that text. So a test can tell
 * which binary sits at a path, and a smoke test passes or fails on content.
 *
 * @module test-utils/update-fakes
 */

import { dirname } from "node:path"

import type { BuildInfo } from "../cli/build-info.ts"
import { sha256Hex } from "../update/archive.ts"
import type { Release, ReleaseAsset } from "../update/github.ts"
import type { ExecFn, UpdateFs } from "../update/io.ts"
import type { UpdateDeps } from "../update/run.ts"
import type { HostFacts } from "../update/target.ts"

/** A build info with defaults. */
export function makeBuild(over: Partial<BuildInfo> = {}): BuildInfo {
  return {
    version: "0.1.0",
    cliSha: "a".repeat(40),
    coreSha: "c".repeat(40),
    pluginsSha: "p".repeat(40),
    dirty: false,
    bunVersion: "1.4.4",
    target: "linux-x64",
    mode: "release",
    builtAt: "2026-11-01T00:00:00.000Z",
    ...over,
  }
}

/** The bytes of a fake binary: its build info as JSON. */
export function fakeBinary(info: Partial<BuildInfo>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(info))
}

/** In-memory files. */
export class MemFs implements UpdateFs {
  readonly files = new Map<string, { data: Uint8Array; mode: number }>()
  readonly readOnlyDirs = new Set<string>()
  readonly links = new Map<string, string>()
  /** Paths whose write throws. */
  readonly failWrite = new Set<string>()

  exists(path: string): boolean {
    return this.files.has(path)
  }
  canWrite(dir: string): boolean {
    return !this.readOnlyDirs.has(dir)
  }
  writeFile(path: string, data: Uint8Array, mode: number): void {
    if (this.failWrite.has(path) || this.readOnlyDirs.has(dirname(path))) {
      throw new Error(`EACCES: ${path}`)
    }
    this.files.set(path, { data, mode })
  }
  rename(from: string, to: string): void {
    const f = this.files.get(from)
    if (f === undefined) throw new Error(`ENOENT: ${from}`)
    this.files.set(to, f)
    this.files.delete(from)
  }
  rm(path: string): void {
    this.files.delete(path)
  }
  linkOrCopy(from: string, to: string): void {
    const f = this.files.get(from)
    if (f === undefined) throw new Error(`ENOENT: ${from}`)
    if (this.files.has(to)) throw new Error(`EEXIST: ${to}`)
    this.files.set(to, { data: f.data, mode: f.mode })
  }
  realpath(path: string): string {
    return this.links.get(path) ?? path
  }
  /** The parsed build info of the fake binary at `path`. */
  infoAt(path: string): Partial<BuildInfo> | undefined {
    const f = this.files.get(path)
    return f === undefined ? undefined : JSON.parse(new TextDecoder().decode(f.data))
  }
}

/** A fake exec over a {@link MemFs}: `<bin> version --json` prints the bin's bytes. */
export function memExec(fs: MemFs, calls: string[][] = []): ExecFn {
  return (argv) => {
    calls.push([...argv])
    const f = fs.files.get(argv[0] ?? "")
    if (f === undefined) return Promise.resolve({ exitCode: 127, stdout: "", stderr: "not found" })
    const text = new TextDecoder().decode(f.data)
    if (text.startsWith("CRASH")) {
      return Promise.resolve({ exitCode: 139, stdout: "", stderr: "Illegal instruction" })
    }
    return Promise.resolve({ exitCode: 0, stdout: text, stderr: "" })
  }
}

/** Build an uncompressed ustar archive of `files` (name to bytes). */
export function makeTar(files: Record<string, Uint8Array>): Uint8Array {
  const chunks: Uint8Array[] = []
  const enc = new TextEncoder()
  const field = (h: Uint8Array, off: number, len: number, text: string): void => {
    h.set(enc.encode(text).subarray(0, len), off)
  }
  for (const [name, data] of Object.entries(files)) {
    const h = new Uint8Array(512)
    field(h, 0, 100, name)
    field(h, 100, 8, "0000755\0")
    field(h, 108, 8, "0000000\0")
    field(h, 116, 8, "0000000\0")
    field(h, 124, 12, `${data.length.toString(8).padStart(11, "0")}\0`)
    field(h, 136, 12, "00000000000\0")
    field(h, 148, 8, "        ")
    h[156] = "0".charCodeAt(0)
    field(h, 257, 6, "ustar\0")
    field(h, 263, 2, "00")
    let sum = 0
    for (const b of h) sum += b
    field(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
    chunks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512))
  }
  chunks.push(new Uint8Array(1024))
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** A release tarball holding `minimal-agent` with `binary` bytes. */
export function makeTarGz(binary: Uint8Array): Uint8Array {
  return Bun.gzipSync(
    makeTar({
      LICENSE: new TextEncoder().encode("license"),
      "README.md": new TextEncoder().encode("readme"),
      "minimal-agent": binary,
    }) as Uint8Array<ArrayBuffer>,
  )
}

/** One fake release: its metadata plus the bytes of each asset. */
export interface FakeRelease {
  readonly release: Release
  readonly bytes: Map<number, Uint8Array>
}

let nextAssetId = 1

/** Options of {@link makeRelease}. */
export interface MakeReleaseOptions {
  readonly tag: string
  readonly prerelease?: boolean
  readonly draft?: boolean
  readonly published?: string
  /** Target ids to ship. Default `["linux-x64"]`. */
  readonly targets?: readonly string[]
  /** The binary build info inside every tarball. Default version from the tag. */
  readonly binary?: Partial<BuildInfo> | "CRASH"
  /** Release build-info sources. Default cli `b...`. */
  readonly cliSha?: string
  /** Corrupt the SHA256SUMS line of this asset id. */
  readonly badSumFor?: string
  readonly noSums?: boolean
}

/** Build a fake release with tarballs, SHA256SUMS, and build-info.json. */
export function makeRelease(opts: MakeReleaseOptions): FakeRelease {
  const label = opts.tag.replace(/^v/u, "")
  const version = label.replace(/-.*$/u, "")
  const cliSha = opts.cliSha ?? "b".repeat(40)
  const bin =
    opts.binary === "CRASH"
      ? new TextEncoder().encode("CRASH")
      : fakeBinary({ version, cliSha, mode: "release", ...opts.binary })
  const bytes = new Map<number, Uint8Array>()
  const assets: ReleaseAsset[] = []
  const add = (name: string, data: Uint8Array): void => {
    const id = nextAssetId++
    bytes.set(id, data)
    assets.push({
      id,
      name,
      size: data.length,
      url: `https://api.test/repos/gastonmorixe/minimal-agent-cli/releases/assets/${id}`,
    })
  }
  const targets = opts.targets ?? ["linux-x64"]
  const sums: string[] = []
  for (const id of targets) {
    const name = `minimal-agent-${label}-${id}.tar.gz`
    const tgz = makeTarGz(bin)
    add(name, tgz)
    sums.push(`${opts.badSumFor === id ? "0".repeat(64) : sha256Hex(tgz)}  ${name}`)
  }
  const info = new TextEncoder().encode(
    JSON.stringify({
      schema: 1,
      version: label,
      sources: {
        cli: { sha: cliSha },
        core: { sha: "c".repeat(40) },
        plugins: { sha: "p".repeat(40) },
      },
      targets: targets.map((id) => ({
        id,
        binarySha256: sha256Hex(bin),
        signed: id.startsWith("darwin") ? "adhoc" : "none",
        notarized: false,
        smoked: true,
      })),
    }),
  )
  add("build-info.json", info)
  sums.push(`${sha256Hex(info)}  build-info.json`)
  if (!opts.noSums) add("SHA256SUMS", new TextEncoder().encode(`${sums.join("\n")}\n`))
  return {
    release: {
      tag_name: opts.tag,
      draft: opts.draft ?? false,
      prerelease: opts.prerelease ?? /-/u.test(label),
      published_at: opts.published ?? "2026-11-10T00:00:00Z",
      html_url: `https://github.com/gastonmorixe/minimal-agent-cli/releases/tag/${opts.tag}`,
      assets,
    },
    bytes,
  }
}

/** Options of {@link fakeGithub}. */
export interface FakeGithubOptions {
  readonly releases: readonly FakeRelease[]
  /** The repo endpoint answers 404 (the token cannot see the repo). */
  readonly repoHidden?: boolean
  /** Every call answers this status. */
  readonly status?: number
}

/** A fake GitHub API `fetch` over `releases`. Records each URL and auth header. */
export function fakeGithub(
  opts: FakeGithubOptions,
  seen: { url: string; auth: string | null }[] = [],
): UpdateDeps["fetch"] {
  const base = "https://api.test/repos/gastonmorixe/minimal-agent-cli"
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  return (input, init) => {
    const url = input
    const headers = new Headers(init?.headers)
    seen.push({ url, auth: headers.get("authorization") })
    if (opts.status !== undefined) return Promise.resolve(json({ message: "nope" }, opts.status))
    const published = opts.releases.map((r) => r.release).filter((r) => !r.draft)
    if (url === base) {
      return Promise.resolve(opts.repoHidden ? json({ message: "Not Found" }, 404) : json({}))
    }
    if (url === `${base}/releases/latest`) {
      const latest = published.find((r) => !r.prerelease)
      return Promise.resolve(latest ? json(latest) : json({ message: "Not Found" }, 404))
    }
    if (url.startsWith(`${base}/releases?`)) {
      return Promise.resolve(json(url.includes("page=1") ? published : []))
    }
    if (url.startsWith(`${base}/releases/tags/`)) {
      const tag = decodeURIComponent(url.slice(`${base}/releases/tags/`.length))
      const r = published.find((x) => x.tag_name === tag)
      return Promise.resolve(r ? json(r) : json({ message: "Not Found" }, 404))
    }
    const asset = /\/releases\/assets\/(\d+)$/u.exec(url)
    if (asset) {
      // Like GitHub: a 302 to signed storage. The storage URL must not get the token.
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: `https://storage.test/blob/${asset[1]}` },
        }),
      )
    }
    const blob = /^https:\/\/storage\.test\/blob\/(\d+)$/u.exec(url)
    if (blob) {
      const id = Number(blob[1])
      for (const r of opts.releases) {
        const data = r.bytes.get(id)
        if (data) return Promise.resolve(new Response(data as Uint8Array<ArrayBuffer>))
      }
    }
    return Promise.resolve(json({ message: `unrouted ${url}` }, 500))
  }
}

/** A linux-x64 glibc AVX2 host. */
export const LINUX_X64: HostFacts = { platform: "linux", arch: "x64", musl: false, avx2: true }

/** Deps over the fakes. The binary lives at `/opt/ma/minimal-agent`. */
export function makeDeps(over: Partial<UpdateDeps> & { fs?: MemFs } = {}): UpdateDeps & {
  fs: MemFs
  lines: string[]
} {
  const fs = over.fs ?? new MemFs()
  const build = over.build ?? makeBuild()
  if (!fs.exists("/opt/ma/minimal-agent")) {
    fs.files.set("/opt/ma/minimal-agent", { data: fakeBinary(build), mode: 0o755 })
  }
  const lines: string[] = []
  return {
    env: {},
    build,
    standalone: true,
    execPath: "/opt/ma/minimal-agent",
    host: LINUX_X64,
    exec: memExec(fs),
    fetch: fakeGithub({ releases: [] }),
    resolveToken: () => Promise.resolve("tok-secret-123"),
    progress: (line) => lines.push(line),
    apiBase: "https://api.test",
    ...over,
    fs,
    lines,
  }
}
