/**
 * `scripts/install.sh` against a fake GitHub API on 127.0.0.1.
 *
 * The fake serves the release JSON in GitHub's key order, answers an asset
 * API URL with a 302 to a storage URL on the same server (like GitHub's
 * signed storage redirect), and records the Authorization header of every
 * request. The "binary" in the tarball is a tiny sh script that answers
 * `version` and `version --json`. Runs under curl and wget when present.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeTarGz } from "../test-utils/update-fakes.ts"
import { sha256Hex } from "./archive.ts"

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "install.sh")
const TOKEN = "tok-install-secret"

/** The host's release target id, as install.sh detects it on this machine. */
function hostTarget(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  if (process.platform === "darwin") return `darwin-${arch}`
  let musl = false
  try {
    musl = readdirSync("/lib").some((n) => n.startsWith("ld-musl-"))
  } catch {
    musl = false
  }
  if (musl) return `linux-${arch}-musl`
  if (arch === "arm64") return "linux-arm64"
  const cpu = existsSync("/proc/cpuinfo") ? readFileSync("/proc/cpuinfo", "utf8") : ""
  return /^flags.*\bavx2\b/mu.test(cpu) || !/^flags/mu.test(cpu)
    ? "linux-x64"
    : "linux-x64-baseline"
}

function fakeBinary(version: string): Uint8Array {
  return new TextEncoder().encode(
    `#!/bin/sh\nif [ "$2" = "--json" ]; then echo '{"version":"${version}"}'; else echo "minimal-agent ${version} fake"; fi\n`,
  )
}

interface Served {
  readonly tag: string
  readonly prerelease: boolean
  readonly draft?: boolean
  readonly assets: { id: number; name: string; data: Uint8Array }[]
}

let nextId = 100

function release(
  tag: string,
  opts: { prerelease?: boolean; draft?: boolean; badSum?: boolean } = {},
): Served {
  const label = tag.slice(1)
  const tgz = makeTarGz(fakeBinary(label.replace(/-.*$/u, "")))
  const name = `minimal-agent-${label}-${hostTarget()}.tar.gz`
  const sums = `${opts.badSum ? "0".repeat(64) : sha256Hex(tgz)}  ${name}\n`
  return {
    tag,
    prerelease: opts.prerelease ?? false,
    ...(opts.draft ? { draft: true } : {}),
    assets: [
      { id: nextId++, name, data: tgz },
      { id: nextId++, name: "SHA256SUMS", data: new TextEncoder().encode(sums) },
    ],
  }
}

let releases: Served[] = []
const seen: { path: string; auth: string | null }[] = []
let server: ReturnType<typeof Bun.serve>
let base = ""

function releaseJson(r: Served): unknown {
  // GitHub's key order: url, ..., author, tag_name, name, draft, prerelease, ..., assets.
  return {
    url: `${base}/repos/gastonmorixe/minimal-agent-cli/releases/1`,
    assets_url: `${base}/repos/gastonmorixe/minimal-agent-cli/releases/1/assets`,
    id: 1,
    author: { login: "x", url: `${base}/users/x` },
    tag_name: r.tag,
    name: `minimal-agent ${r.tag}, built`,
    draft: r.draft ?? false,
    prerelease: r.prerelease,
    assets: r.assets.map((a) => ({
      url: `${base}/repos/gastonmorixe/minimal-agent-cli/releases/assets/${a.id}`,
      id: a.id,
      name: a.name,
      uploader: { login: "x", url: `${base}/users/x` },
      size: a.data.length,
    })),
    body: "notes, with commas",
  }
}

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      seen.push({ path: url.pathname, auth: req.headers.get("authorization") })
      const p = url.pathname
      const repo = "/repos/gastonmorixe/minimal-agent-cli"
      if (p.startsWith("/storage/")) {
        if (req.headers.get("authorization")) return new Response("token leaked", { status: 400 })
        const id = Number(p.slice("/storage/".length))
        const a = releases.flatMap((r) => r.assets).find((x) => x.id === id)
        return a
          ? new Response(a.data as Uint8Array<ArrayBuffer>)
          : new Response("", { status: 404 })
      }
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
        return Response.json({ message: "Bad credentials" }, { status: 401 })
      }
      const pub = releases.filter((r) => !r.draft)
      if (p === repo) return Response.json({ full_name: "gastonmorixe/minimal-agent-cli" })
      if (p === `${repo}/releases/latest`) {
        const r = pub.find((x) => !x.prerelease)
        return r
          ? Response.json(releaseJson(r))
          : Response.json({ message: "Not Found" }, { status: 404 })
      }
      if (p === `${repo}/releases`) return Response.json(releases.map(releaseJson))
      if (p.startsWith(`${repo}/releases/tags/`)) {
        const r = pub.find(
          (x) => x.tag === decodeURIComponent(p.slice(`${repo}/releases/tags/`.length)),
        )
        return r
          ? Response.json(releaseJson(r))
          : Response.json({ message: "Not Found" }, { status: 404 })
      }
      const m = /\/releases\/assets\/(\d+)$/u.exec(p)
      if (m && req.headers.get("accept") === "application/octet-stream") {
        return new Response(null, { status: 302, headers: { location: `${base}/storage/${m[1]}` } })
      }
      return Response.json({ message: "unrouted" }, { status: 500 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(async () => {
  await server.stop(true)
})

interface RunResult {
  readonly code: number
  readonly out: string
  readonly home: string
}

async function run(
  args: string[],
  http: string,
  env: Record<string, string> = {},
): Promise<RunResult> {
  const home = mkdtempSync(join(tmpdir(), "ma-install-sh-"))
  const fakeBin = join(home, "fakebin")
  mkdirSync(fakeBin)
  // A gh that is logged out, so the token chain ends at env.
  writeFileSync(join(fakeBin, "gh"), "#!/bin/sh\nexit 1\n")
  chmodSync(join(fakeBin, "gh"), 0o755)
  // Async spawn: a sync one would block the event loop that serves the fake API.
  const proc = Bun.spawn(["sh", SCRIPT, ...args], {
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      GITHUB_TOKEN: TOKEN,
      MINIMAL_AGENT_INSTALL_API: base,
      MINIMAL_AGENT_INSTALL_HTTP: http,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, out: `${out}${err}`, home }
}

const clients = ["curl", "wget"].filter((c) => Bun.which(c) !== null)
const enabled = process.platform !== "win32" && Bun.which("tar") !== null && clients.length > 0

describe.skipIf(!enabled)("install.sh", () => {
  for (const http of clients) {
    test(`${http}: stable install into ~/.local/bin, token never reaches storage`, async () => {
      releases = [
        release("v0.2.0"),
        release("v0.2.0-nightly.20261112T061700Z", { prerelease: true }),
      ]
      seen.length = 0
      const r = await run([], http)
      try {
        expect(r.out).toContain("minimal-agent 0.2.0 fake")
        expect(r.code).toBe(0)
        const dest = join(r.home, ".local", "bin", "minimal-agent")
        expect(existsSync(dest)).toBe(true)
        expect(seen.filter((s) => s.path.startsWith("/storage/")).length).toBe(2)
        expect(
          seen.filter((s) => s.path.startsWith("/storage/")).every((s) => s.auth === null),
        ).toBe(true)
        expect(r.out).not.toContain(TOKEN)
      } finally {
        rmSync(r.home, { recursive: true, force: true })
      }
    })

    test(`${http}: nightly channel picks the newest published nightly`, async () => {
      releases = [
        release("v0.2.0-nightly.20261113T061700Z", { prerelease: true, draft: true }),
        release("v0.2.0-nightly.20261110T061700Z", { prerelease: true }),
        release("v0.2.0-nightly.20261112T061700Z", { prerelease: true }),
        release("v0.1.0"),
      ]
      const r = await run(["--channel", "nightly"], http)
      try {
        expect(r.out).toContain("minimal-agent 0.2.0-nightly.20261112T061700Z")
        expect(r.code).toBe(0)
      } finally {
        rmSync(r.home, { recursive: true, force: true })
      }
    })
  }

  test("--version and --dir; a second install keeps minimal-agent.old", async () => {
    releases = [release("v0.1.0"), release("v0.2.0")]
    const dir = mkdtempSync(join(tmpdir(), "ma-install-dir-"))
    try {
      const a = await run(["--version", "0.1.0", "--dir", dir], clients[0] ?? "curl")
      expect(a.code).toBe(0)
      const b = await run(["--version=v0.2.0", `--dir=${dir}`], clients[0] ?? "curl")
      expect(b.code).toBe(0)
      expect(readFileSync(join(dir, "minimal-agent.old"), "utf8")).toContain("0.1.0")
      expect(readFileSync(join(dir, "minimal-agent"), "utf8")).toContain("0.2.0")
      rmSync(a.home, { recursive: true, force: true })
      rmSync(b.home, { recursive: true, force: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("checksum mismatch: exit 1, nothing installed", async () => {
    releases = [release("v0.2.0", { badSum: true })]
    const r = await run([], clients[0] ?? "curl")
    try {
      expect(r.code).toBe(1)
      expect(r.out).toContain("checksum mismatch")
      expect(existsSync(join(r.home, ".local", "bin", "minimal-agent"))).toBe(false)
    } finally {
      rmSync(r.home, { recursive: true, force: true })
    }
  })

  test("no token: exit 3 with the private-repo message", async () => {
    releases = [release("v0.2.0")]
    const r = await run([], clients[0] ?? "curl", { GITHUB_TOKEN: "" })
    try {
      expect(r.code).toBe(3)
      expect(r.out).toContain("private repo")
    } finally {
      rmSync(r.home, { recursive: true, force: true })
    }
  })

  test("bad token: exit 3; no release: exit 4; bad args: exit 2", async () => {
    releases = []
    const bad = await run([], clients[0] ?? "curl", { GITHUB_TOKEN: "wrong" })
    expect(bad.code).toBe(3)
    const none = await run([], clients[0] ?? "curl")
    expect(none.code).toBe(4)
    expect(none.out).toContain("no stable release found")
    const args = await run(["--channel", "beta"], clients[0] ?? "curl")
    expect(args.code).toBe(2)
    for (const r of [bad, none, args]) rmSync(r.home, { recursive: true, force: true })
  })
})
