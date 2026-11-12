import { describe, expect, test } from "bun:test"

import {
  fakeBinary,
  fakeGithub,
  LINUX_X64,
  MemFs,
  makeBuild,
  makeDeps,
  makeRelease,
  memExec,
} from "../test-utils/update-fakes.ts"
import { runUpdate, UPDATE_EXIT, type UpdateOptions } from "./run.ts"

const EXE = "/opt/ma/minimal-agent"
const opts = (over: Partial<UpdateOptions> = {}): UpdateOptions => ({
  check: false,
  channel: "stable",
  rollback: false,
  json: false,
  ...over,
})

describe("install kind", () => {
  test("a run from source says git pull and changes nothing", async () => {
    const deps = makeDeps({ build: makeBuild({ mode: "source" }), standalone: false })
    const out = await runUpdate(opts(), deps)
    expect(out.code).toBe(UPDATE_EXIT.ok)
    expect(out.text).toContain("running from source: git pull in the monorepo")
    expect(out.json.status).toBe("source")
  })

  test("a non-standalone process counts as source even with a release define", async () => {
    const out = await runUpdate(opts(), makeDeps({ standalone: false }))
    expect(out.text).toContain("running from source")
  })

  test("a Homebrew Cellar binary says brew upgrade (through the symlink)", async () => {
    const fs = new MemFs()
    fs.links.set(
      "/opt/homebrew/bin/minimal-agent",
      "/opt/homebrew/Cellar/minimal-agent/0.1.0/bin/minimal-agent",
    )
    const deps = makeDeps({ fs, execPath: "/opt/homebrew/bin/minimal-agent" })
    const out = await runUpdate(opts(), deps)
    expect(out.code).toBe(UPDATE_EXIT.ok)
    expect(out.text).toContain("brew upgrade")
  })
})

describe("token", () => {
  test("no token: exit 3, says private and how to provide one", async () => {
    const out = await runUpdate(opts(), makeDeps({ resolveToken: () => Promise.resolve(null) }))
    expect(out.code).toBe(UPDATE_EXIT.auth)
    expect(out.text).toContain("private repo")
    expect(out.text).toContain("MINIMAL_AGENT_GITHUB_TOKEN")
    expect(out.text).toContain("gh auth login")
  })

  test("the token goes to the API only, never to storage or the output", async () => {
    const r = makeRelease({ tag: "v0.2.0" })
    const seen: { url: string; auth: string | null }[] = []
    const deps = makeDeps({ fetch: fakeGithub({ releases: [r] }, seen) })
    const out = await runUpdate(opts(), deps)
    expect(out.code).toBe(UPDATE_EXIT.ok)
    for (const s of seen) {
      if (s.url.startsWith("https://api.test/")) expect(s.auth).toBe("Bearer tok-secret-123")
      else expect(s.auth).toBeNull()
    }
    expect(seen.some((s) => s.url.startsWith("https://storage.test/"))).toBe(true)
    expect(JSON.stringify(out)).not.toContain("tok-secret-123")
  })

  test("a token that cannot see the repo: exit 3 with the private hint", async () => {
    const deps = makeDeps({ fetch: fakeGithub({ releases: [], repoHidden: true }) })
    const out = await runUpdate(opts({ check: true }), deps)
    expect(out.code).toBe(UPDATE_EXIT.auth)
    expect(out.text).toContain("private repo")
  })

  test("a 401 maps to exit 3", async () => {
    const deps = makeDeps({ fetch: fakeGithub({ releases: [], status: 401 }) })
    const out = await runUpdate(opts({ check: true }), deps)
    expect(out.code).toBe(UPDATE_EXIT.auth)
    expect(out.text).toContain("invalid or expired")
  })
})

describe("release selection", () => {
  const stable1 = makeRelease({ tag: "v0.1.0", published: "2026-11-01T00:00:00Z" })
  const stable2 = makeRelease({ tag: "v0.2.0", published: "2026-11-05T00:00:00Z" })
  const n1 = makeRelease({ tag: "v0.2.0-nightly.20261110T061700Z" })
  const n2 = makeRelease({ tag: "v0.2.0-nightly.20261112T061700Z" })
  const nDraft = makeRelease({ tag: "v0.2.0-nightly.20261113T061700Z", draft: true })
  const releases = [nDraft, n2, stable2, n1, stable1]

  test("no release at all: exit 4 with a clear message", async () => {
    const out = await runUpdate(opts({ check: true }), makeDeps())
    expect(out.code).toBe(UPDATE_EXIT.notFound)
    expect(out.text).toContain("no stable release found")
    expect(out.json.status).toBe("no-release")
  })

  test("stable: /releases/latest", async () => {
    const deps = makeDeps({ fetch: fakeGithub({ releases }) })
    const out = await runUpdate(opts({ check: true }), deps)
    expect(out.code).toBe(UPDATE_EXIT.updateAvailable)
    expect(out.text).toContain("-> 0.2.0")
  })

  test("nightly: newest published nightly by stamp, drafts skipped", async () => {
    const deps = makeDeps({ fetch: fakeGithub({ releases }) })
    const out = await runUpdate(opts({ check: true, channel: "nightly" }), deps)
    expect(out.code).toBe(UPDATE_EXIT.updateAvailable)
    expect((out.json.latest as { tag: string }).tag).toBe("v0.2.0-nightly.20261112T061700Z")
  })

  test("--to: one exact tag, with or without v", async () => {
    const deps = makeDeps({ fetch: fakeGithub({ releases }) })
    const out = await runUpdate(opts({ check: true, to: "0.2.0-nightly.20261110T061700Z" }), deps)
    expect((out.json.latest as { tag: string }).tag).toBe("v0.2.0-nightly.20261110T061700Z")
    const missing = await runUpdate(opts({ check: true, to: "9.9.9" }), deps)
    expect(missing.code).toBe(UPDATE_EXIT.notFound)
    expect(missing.text).toContain("release v9.9.9")
  })

  test("--check: up to date is exit 0 (same commits as build-info.json)", async () => {
    const build = makeBuild({ version: "0.2.0", cliSha: "b".repeat(40) })
    const deps = makeDeps({ build, fetch: fakeGithub({ releases }) })
    const out = await runUpdate(opts({ check: true }), deps)
    expect(out.code).toBe(UPDATE_EXIT.ok)
    expect(out.text).toContain("up to date")
  })

  test("--check: a newer binary is exit 0, not a downgrade offer", async () => {
    const build = makeBuild({ version: "0.3.0" })
    const out = await runUpdate(
      opts({ check: true }),
      makeDeps({ build, fetch: fakeGithub({ releases }) }),
    )
    expect(out.code).toBe(UPDATE_EXIT.ok)
    expect(out.json.status).toBe("ahead")
  })
})

describe("install", () => {
  test("happy path: verify, smoke, swap, keep .old", async () => {
    const r = makeRelease({ tag: "v0.2.0" })
    const calls: string[][] = []
    const fs = new MemFs()
    const deps = makeDeps({ fs, fetch: fakeGithub({ releases: [r] }), exec: memExec(fs, calls) })
    const out = await runUpdate(opts(), deps)
    expect(out.code).toBe(UPDATE_EXIT.ok)
    expect(out.text).toContain("updated /opt/ma/minimal-agent: 0.1.0")
    expect(out.text).toContain("-> 0.2.0 (linux-x64)")
    expect(out.text).toContain("does not touch ~/.minimal-agent/plugins")
    expect(fs.infoAt(EXE)?.version).toBe("0.2.0")
    expect(fs.infoAt(`${EXE}.old`)?.version).toBe("0.1.0")
    expect(fs.exists(`${EXE}.new`)).toBe(false)
    expect(fs.files.get(EXE)?.mode).toBe(0o755)
    expect(calls).toContainEqual([`${EXE}.new`, "version", "--json"])
  })

  test("refuses a downgrade without --to, allows it with --to", async () => {
    const r = makeRelease({ tag: "v0.1.0" })
    const fs = new MemFs()
    const build = makeBuild({ version: "0.2.0" })
    const deps = makeDeps({ fs, build, fetch: fakeGithub({ releases: [r] }) })
    const refused = await runUpdate(opts(), deps)
    expect(refused.code).toBe(UPDATE_EXIT.ok)
    expect(refused.text).toContain("not downgrading")
    expect(fs.infoAt(EXE)?.version).toBe("0.2.0")
    const forced = await runUpdate(opts({ to: "v0.1.0" }), deps)
    expect(forced.code).toBe(UPDATE_EXIT.ok)
    expect(fs.infoAt(EXE)?.version).toBe("0.1.0")
  })

  test("sha mismatch aborts and leaves the old binary", async () => {
    const r = makeRelease({ tag: "v0.2.0", badSumFor: "linux-x64" })
    const fs = new MemFs()
    const deps = makeDeps({ fs, fetch: fakeGithub({ releases: [r] }) })
    const out = await runUpdate(opts(), deps)
    expect(out.code).toBe(UPDATE_EXIT.error)
    expect(out.text).toContain("checksum mismatch")
    expect(fs.infoAt(EXE)?.version).toBe("0.1.0")
    expect(fs.exists(`${EXE}.new`)).toBe(false)
    expect(fs.exists(`${EXE}.old`)).toBe(false)
  })

  test("a binary that crashes in the smoke test is removed, the old one stays", async () => {
    const r = makeRelease({ tag: "v0.2.0", binary: "CRASH" })
    const fs = new MemFs()
    const out = await runUpdate(opts(), makeDeps({ fs, fetch: fakeGithub({ releases: [r] }) }))
    expect(out.code).toBe(UPDATE_EXIT.error)
    expect(out.text).toContain("does not run")
    expect(fs.infoAt(EXE)?.version).toBe("0.1.0")
    expect(fs.exists(`${EXE}.new`)).toBe(false)
  })

  test("a binary that reports the wrong version fails the smoke test", async () => {
    const r = makeRelease({ tag: "v0.2.0", binary: { version: "0.1.9" } })
    const fs = new MemFs()
    const out = await runUpdate(opts(), makeDeps({ fs, fetch: fakeGithub({ releases: [r] }) }))
    expect(out.code).toBe(UPDATE_EXIT.error)
    expect(out.text).toContain("reports version 0.1.9, expected 0.2.0")
    expect(fs.infoAt(EXE)?.version).toBe("0.1.0")
  })

  test("unwritable dir: exit 5 with the manual commands, nothing downloaded", async () => {
    const r = makeRelease({ tag: "v0.2.0" })
    const fs = new MemFs()
    fs.readOnlyDirs.add("/opt/ma")
    const seen: { url: string; auth: string | null }[] = []
    const out = await runUpdate(
      opts(),
      makeDeps({ fs, fetch: fakeGithub({ releases: [r] }, seen) }),
    )
    expect(out.code).toBe(UPDATE_EXIT.notWritable)
    expect(out.text).toContain("/opt/ma is not writable")
    expect(out.text).toContain("sudo -E /opt/ma/minimal-agent update")
    expect(out.text).toContain("gh release download v0.2.0")
    expect(
      seen.some(
        (s) => s.url.includes("storage.test") && s.url.endsWith(String(r.release.assets[0]?.id)),
      ),
    ).toBe(false)
    expect(fs.infoAt(EXE)?.version).toBe("0.1.0")
  })

  test("musl host gets the musl asset; no asset for the host is exit 4", async () => {
    const r = makeRelease({ tag: "v0.2.0", targets: ["linux-x64", "linux-x64-musl"] })
    const fs = new MemFs()
    const musl = { ...LINUX_X64, musl: true }
    const out = await runUpdate(
      opts(),
      makeDeps({ fs, host: musl, fetch: fakeGithub({ releases: [r] }) }),
    )
    expect(out.code).toBe(UPDATE_EXIT.ok)
    expect(out.text).toContain("(linux-x64-musl)")

    const onlyGlibc = makeRelease({ tag: "v0.2.0", targets: ["linux-x64"] })
    const none = await runUpdate(
      opts(),
      makeDeps({
        host: { ...LINUX_X64, avx2: false },
        fetch: fakeGithub({ releases: [onlyGlibc] }),
      }),
    )
    expect(none.code).toBe(UPDATE_EXIT.notFound)
    expect(none.text).toContain("no build for this host (wanted linux-x64-baseline)")
  })

  test("x64 baseline fallback is noted", async () => {
    const r = makeRelease({ tag: "v0.2.0", targets: ["linux-x64-baseline"] })
    const out = await runUpdate(opts(), makeDeps({ fetch: fakeGithub({ releases: [r] }) }))
    expect(out.code).toBe(UPDATE_EXIT.ok)
    expect(out.text).toContain("installed the linux-x64-baseline build")
  })

  test("macOS: the ad-hoc signing note", async () => {
    const r = makeRelease({ tag: "v0.2.0", targets: ["darwin-arm64"] })
    const mac = { platform: "darwin", arch: "arm64", musl: false, avx2: true }
    const out = await runUpdate(
      opts(),
      makeDeps({ host: mac, fetch: fakeGithub({ releases: [r] }) }),
    )
    expect(out.code).toBe(UPDATE_EXIT.ok)
    expect(out.text).toContain("ad-hoc signed only")
  })

  test("a release with no SHA256SUMS is refused", async () => {
    const r = makeRelease({ tag: "v0.2.0", noSums: true })
    const out = await runUpdate(opts(), makeDeps({ fetch: fakeGithub({ releases: [r] }) }))
    expect(out.code).toBe(UPDATE_EXIT.error)
    expect(out.text).toContain("no SHA256SUMS")
  })
})

describe("rollback", () => {
  test("swaps .old back in, and a second rollback undoes the first", async () => {
    const fs = new MemFs()
    fs.files.set(`${EXE}.old`, {
      data: fakeBinary({ version: "0.0.9", cliSha: "9".repeat(40) }),
      mode: 0o755,
    })
    const deps = makeDeps({ fs })
    const out = await runUpdate(opts({ rollback: true }), deps)
    expect(out.code).toBe(UPDATE_EXIT.ok)
    expect(out.text).toContain("rolled back /opt/ma/minimal-agent to 0.0.9")
    expect(fs.infoAt(EXE)?.version).toBe("0.0.9")
    expect(fs.infoAt(`${EXE}.old`)?.version).toBe("0.1.0")
    expect(fs.exists(`${EXE}.prev`)).toBe(false)
    await runUpdate(opts({ rollback: true }), deps)
    expect(fs.infoAt(EXE)?.version).toBe("0.1.0")
  })

  test("no .old: exit 4; a broken .old is not swapped in; no token needed", async () => {
    const fs = new MemFs()
    const deps = makeDeps({ fs, resolveToken: () => Promise.reject(new Error("must not run")) })
    const none = await runUpdate(opts({ rollback: true }), deps)
    expect(none.code).toBe(UPDATE_EXIT.notFound)
    fs.files.set(`${EXE}.old`, { data: new TextEncoder().encode("CRASH"), mode: 0o755 })
    const broken = await runUpdate(opts({ rollback: true }), deps)
    expect(broken.code).toBe(UPDATE_EXIT.error)
    expect(fs.infoAt(EXE)?.version).toBe("0.1.0")
  })

  test("update then rollback round-trips", async () => {
    const r = makeRelease({ tag: "v0.2.0" })
    const fs = new MemFs()
    const deps = makeDeps({ fs, fetch: fakeGithub({ releases: [r] }) })
    expect((await runUpdate(opts(), deps)).code).toBe(0)
    expect((await runUpdate(opts({ rollback: true }), deps)).code).toBe(0)
    expect(fs.infoAt(EXE)?.version).toBe("0.1.0")
    expect(fs.infoAt(`${EXE}.old`)?.version).toBe("0.2.0")
  })
})
