/**
 * Auto-formatter resolver for mdstream.
 *
 * When no `--formatter` flag is given and `mdstream` is not already on PATH,
 * this module keeps the LATEST mdstream release installed in the managed bin
 * dir (`~/.minimal-agent/bin/mdstream`). No version pin, no checksum.
 *
 * **Resolution order (no `--formatter` flag)**:
 * 1. `mdstream` found on PATH → use it (user-managed, never touched).
 * 2. Ask GitHub for the latest release tag (the `releases/latest` redirect,
 *    short timeout). Managed copy at `~/.minimal-agent/bin/mdstream`:
 *    - its `--version` is the latest or newer → use it;
 *    - older, unknown version, or the lookup failed → see 3 / keep the copy.
 * 3. Download the latest release tarball for this OS + arch, extract it
 *    in-process, and atomically replace the managed copy. Any failure keeps
 *    an existing copy (an offline start never loses a working formatter), or
 *    falls back to plain output with a warning. Never fatal.
 *
 * Network: an anonymous request to `github.com/<repo>/releases/latest` (the
 * redirect names the tag; no `api.github.com`, so no rate limit), plus one
 * `releases/download` GET only when an install or upgrade is needed.
 * Subprocesses: only `mdstream --version`. The archive is extracted with
 * `Bun.Archive` (no `tar`, `find`, `cp`, `rm`).
 *
 * @module ui/formatter/auto
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { findMember } from "@minimal-agent/core/host/binaries"
import { resolveAgentHome } from "@minimal-agent/core/plugin-api/utils/agent-paths"
import { ansiStyle as A } from "../../terminal-kit/ansi.ts"

import { startStartupProgressSpinner } from "../startup/progress-spinner.ts"

/** Public repo that publishes mdstream release tarballs. */
export const MDSTREAM_REPO = "gastonmorixe/mdstream"

/** Release asset per `${process.platform}-${process.arch}`. */
export const MDSTREAM_ASSETS: Record<string, string> = {
  "linux-arm64": "mdstream-linux-aarch64.tar.gz",
  "linux-x64": "mdstream-linux-x86_64.tar.gz",
  "darwin-arm64": "mdstream-macos-aarch64.tar.gz",
}

/** How long the startup "what is latest" lookup may take before we skip it. */
const LATEST_LOOKUP_TIMEOUT_MS = 2500

/** Result of {@link resolveFormatter}. */
export type FormatterResolution =
  | {
      /** argv to pass to `Formatter` / `runRepl`. */
      cmd: string[]
      /** Human-readable label for the startup row. */
      label: string
      warn?: never
    }
  | {
      cmd: undefined
      label?: never
      /** Warning to print to stderr when auto-install wasn't possible. */
      warn: string
    }

/**
 * Download URL for a platform. With a tag, that exact release; without one,
 * GitHub's `releases/latest/download` alias. Null when mdstream publishes no
 * build for the platform. Pure.
 */
export function mdstreamUrlFor(platformKey: string, tag?: string | null): string | null {
  const asset = MDSTREAM_ASSETS[platformKey]
  if (!asset) return null
  const base = `https://github.com/${MDSTREAM_REPO}/releases`
  return tag ? `${base}/download/${tag}/${asset}` : `${base}/latest/download/${asset}`
}

/**
 * Latest release tag (e.g. `"v0.3.9"`) from the `releases/latest` redirect,
 * or null on any failure / timeout.
 */
export async function fetchLatestTag(fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchFn(`https://github.com/${MDSTREAM_REPO}/releases/latest`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(LATEST_LOOKUP_TIMEOUT_MS),
    })
    const loc = res.headers.get("location") ?? res.url
    const m = loc?.match(/\/releases\/tag\/([^/?#]+)/)
    return m ? decodeURIComponent(m[1]!) : null
  } catch {
    return null
  }
}

/**
 * Extract a `.tar.gz` in-process with `Bun.Archive`. `Bun.Archive` confines
 * entries to `destDir` (`../` and absolute member paths are rewritten under it).
 */
export async function extractWithBunArchive(archivePath: string, destDir: string): Promise<void> {
  const archive = new Bun.Archive(await Bun.file(archivePath).arrayBuffer())
  await archive.extract(destDir)
}

/**
 * Download `url` (a tarball holding `mdstream`), extract it, and atomically
 * install the binary at `dest`. Throws on any failure; `dest` is untouched
 * unless the final rename succeeds.
 */
async function downloadAndInstall(url: string, dest: string, fetchFn: typeof fetch): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "ma-mdstream-"))
  try {
    const res = await fetchFn(url)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    const archivePath = join(work, "mdstream.tar.gz")
    await Bun.write(archivePath, await res.arrayBuffer())
    const extractDir = join(work, "x")
    mkdirSync(extractDir, { recursive: true })
    await extractWithBunArchive(archivePath, extractDir)
    const found = findMember(extractDir, "mdstream")
    if (!found) throw new Error(`"mdstream" not found in ${url}`)
    // Stage next to dest (same filesystem), then rename into place.
    const binDir = join(dest, "..")
    mkdirSync(binDir, { recursive: true })
    const staged = join(binDir, `.mdstream.${process.pid}.staged`)
    try {
      await Bun.write(staged, Bun.file(found))
      chmodSync(staged, 0o755)
      renameSync(staged, dest)
    } catch (err) {
      rmSync(staged, { force: true })
      throw err
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Run `<cmd> --version` and extract the version string (e.g. `"v0.2.1"`).
 * Returns `null` on any error so callers can degrade gracefully.
 */
async function queryMdstreamVersion(cmd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([cmd, "--version"], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
    if (proc.exitCode !== 0) return null
    const out = (await new Response(proc.stdout).text()).trim()
    // Expected format: "mdstream 0.2.1"
    const match = out.match(/\S+\s+(\S+)/)
    if (!match) return null
    const ver = match[1]!
    return ver.startsWith("v") ? ver : `v${ver}`
  } catch {
    return null
  }
}

/** Seams for tests. Every field defaults to the real implementation. */
export interface ResolveFormatterDeps {
  /** PATH lookup. Default `Bun.which`. */
  which?: (cmd: string) => string | null
  /** `<cmd> --version` → `"vX.Y.Z"` or null. */
  queryVersion?: (cmd: string) => Promise<string | null>
  /** `${platform}-${arch}`. Default: this process. */
  platformKey?: string
  /** Managed bin dir. Default `<agent-home>/bin`. */
  binDir?: string
  /** Fetch used for the latest lookup and the download. Default global `fetch`. */
  fetchFn?: typeof fetch
}

/** `"v0.3.7"` → `[0, 3, 7]`, or null. */
function parseSemver(v: string | null): number[] | null {
  const m = v?.match(/^v?(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** True when `have` is the same as or newer than `want`. Unknown → false. */
function atLeast(have: string | null, want: string): boolean {
  const a = parseSemver(have)
  const b = parseSemver(want)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!
  }
  return true
}

/**
 * Resolve the formatter command, installing or upgrading to the latest
 * mdstream release if needed.
 *
 * @param explicitCmd - Parsed argv when `--formatter <cmd>` was supplied.
 *   When present the function returns immediately with that command (no
 *   download attempted).
 * @param deps - Test seams. Production passes nothing.
 */
export async function resolveFormatter(
  explicitCmd?: string[],
  deps: ResolveFormatterDeps = {},
): Promise<FormatterResolution> {
  // Explicit --formatter flag: trust the user and use as-is.
  if (explicitCmd && explicitCmd.length > 0) {
    return { cmd: explicitCmd, label: explicitCmd.join(" ") }
  }
  const which = deps.which ?? ((cmd: string) => Bun.which(cmd))
  const queryVersion = deps.queryVersion ?? queryMdstreamVersion
  const fetchFn = deps.fetchFn ?? fetch

  // 1. mdstream on PATH
  if (which("mdstream")) {
    const ver = await queryVersion("mdstream")
    const verLabel = ver ? ` ${A.sky(ver)}` : ""
    return { cmd: ["mdstream"], label: `mdstream${verLabel}` }
  }

  // 2. Managed copy (same dir as the core store's defaultBinDir, honoring
  //    MINIMAL_AGENT_HOME through the shared resolver).
  const binDir = deps.binDir ?? join(resolveAgentHome(), "bin")
  const cachedBin = join(binDir, "mdstream")
  const platformKey = deps.platformKey ?? `${process.platform}-${process.arch}`
  const supported = mdstreamUrlFor(platformKey) !== null
  const cachedLabel = (ver: string | null): string =>
    `mdstream${ver ? ` ${A.sky(ver)}` : ""} ${A.dim("(cached)")}`

  const hasCopy = existsSync(cachedBin)
  const cachedVer = hasCopy ? await queryVersion(cachedBin) : null

  if (!supported) {
    if (hasCopy) return { cmd: [cachedBin], label: cachedLabel(cachedVer) }
    return {
      cmd: undefined,
      warn:
        `no mdstream release for ${process.platform}/${process.arch}. ` +
        `Install it manually or use ${A.bold("--formatter <cmd>")} to specify a formatter.`,
    }
  }

  const latest = await fetchLatestTag(fetchFn)
  if (hasCopy && (!latest || atLeast(cachedVer, latest))) {
    // Current, or we cannot tell what is latest (offline): keep the copy.
    return { cmd: [cachedBin], label: cachedLabel(cachedVer) }
  }

  // 3. Install (or upgrade an older copy) to the latest release.
  const url = mdstreamUrlFor(platformKey, latest)!
  const platformLabel = A.dim(platformKey.replace("-", " · "))
  const versionLabel = A.sky(latest ?? "latest")
  const verb = hasCopy ? "updating" : "downloading"
  const spinner = startStartupProgressSpinner(
    `${A.dim(verb)}  ${A.bold("mdstream")} ${versionLabel}  ${platformLabel}`,
  )

  let detail: string
  try {
    await downloadAndInstall(url, cachedBin, fetchFn)
    const ver = latest ?? (await queryVersion(cachedBin))
    spinner.done(
      `${A.bold("mdstream")} ${A.sky(ver ?? "latest")}  ${A.dim(hasCopy ? "updated" : "installed")}  ${A.faintWhite("→")}  ${A.dim(cachedBin)}`,
    )
    return {
      cmd: [cachedBin],
      label: `mdstream${ver ? ` ${ver}` : ""} ${A.dim("(auto-downloaded)")}`,
    }
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err)
  }

  // Failure. An older working copy beats plain output.
  if (hasCopy) {
    spinner.fail(`update failed, keeping ${cachedVer ?? "the installed copy"}: ${A.dim(detail)}`)
    return { cmd: [cachedBin], label: cachedLabel(cachedVer) }
  }
  spinner.fail(`install failed: ${A.dim(detail)}`)
  return {
    cmd: undefined,
    warn:
      `could not install mdstream: ${detail}. ` +
      `Use ${A.bold("--formatter <cmd>")} to specify a formatter.`,
  }
}
