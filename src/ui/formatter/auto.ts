/**
 * Auto-formatter resolver for mdstream.
 *
 * When no `--formatter` flag is given and `mdstream` is not already on PATH,
 * this module installs a PINNED mdstream release into the managed bin dir
 * (`~/.minimal-agent/bin/mdstream`) through the core binary store, the same
 * store that provisions plugin binaries (download, sha256 verify, atomic
 * install, `.binaries.json` record, audit log).
 *
 * **Resolution order (no `--formatter` flag)**:
 * 1. `mdstream` found on PATH → use it.
 * 2. Managed copy at `~/.minimal-agent/bin/mdstream`:
 *    - recorded by the store at the pinned version or newer → use it;
 *    - an older or unrecorded copy (installed by the previous auto-installer,
 *      which used `releases/latest` and no checksum) → use it as is when its
 *      `--version` is the pinned version or newer, else upgrade to the pin.
 *      A failed upgrade keeps the old copy, so an offline start never loses a
 *      working formatter.
 * 3. Nothing installed → install the pinned release for this OS + arch. No
 *    release for this platform, or any failure → a warning, no formatter
 *    (plain output). Never fatal.
 *
 * Network: one anonymous GET of a public `github.com/.../releases/download`
 * URL, only when an install or upgrade is needed. No `api.github.com` call,
 * so no rate limit. Subprocesses: only `mdstream --version`. The archive is
 * extracted in-process with `Bun.Archive` (no `tar`, `find`, `cp`, `rm`).
 *
 * To move to a newer mdstream, bump {@link MDSTREAM_PIN}: version, then the
 * asset sha256 per target. `gh release view <tag> -R gastonmorixe/mdstream`
 * with `--json assets` prints each asset's `digest`.
 *
 * @module ui/formatter/auto
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

import type { BinarySpec, BinaryStore, InstallProgress } from "@minimal-agent/core/host/binaries"
import { resolveAgentHome } from "@minimal-agent/core/plugin-api/utils/agent-paths"
import { ansiStyle as A } from "../../terminal-kit/ansi.ts"

import { startStartupProgressSpinner } from "../startup/progress-spinner.ts"

/** Public repo that publishes mdstream release tarballs. */
const MDSTREAM_REPO = "gastonmorixe/mdstream"

/**
 * The mdstream release this CLI installs. One entry per published target,
 * keyed by `${process.platform}-${process.arch}`. sha256 is of the tarball.
 */
export const MDSTREAM_PIN = {
  version: "0.3.7",
  assets: {
    "linux-arm64": {
      asset: "mdstream-linux-aarch64.tar.gz",
      sha256: "bf17cde5e94fba9bb3dc7ade13fdd8956c98a2a08941680592010a580ae092a1",
    },
    "linux-x64": {
      asset: "mdstream-linux-x86_64.tar.gz",
      sha256: "413d8968e67e04d808f294c9ca7de38807fe481b9b63c6e369a04dd46475f7e8",
    },
    "darwin-arm64": {
      asset: "mdstream-macos-aarch64.tar.gz",
      sha256: "a5eab1911cf4e768771bec2d3953d909a8ce252fa666fc0543d9ccba5bd4a3c3",
    },
  } as Record<string, { asset: string; sha256: string }>,
} as const

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
 * The pinned store spec for a platform key, or null when mdstream publishes
 * no build for it. Pure.
 */
export function mdstreamSpecFor(platformKey: string): BinarySpec | null {
  const entry = MDSTREAM_PIN.assets[platformKey]
  if (!entry) return null
  return {
    name: "mdstream",
    version: MDSTREAM_PIN.version,
    source: {
      kind: "url",
      url: `https://github.com/${MDSTREAM_REPO}/releases/download/v${MDSTREAM_PIN.version}/${entry.asset}`,
      archive: true,
    },
    sha256: entry.sha256,
    archiveMember: "mdstream",
  }
}

/**
 * Extract a `.tar.gz` in-process with `Bun.Archive`. Replaces the store's
 * default `tar` subprocess. `Bun.Archive` confines entries to `destDir`
 * (`../` and absolute member paths are rewritten under it).
 */
export async function extractWithBunArchive(archivePath: string, destDir: string): Promise<void> {
  const archive = new Bun.Archive(await Bun.file(archivePath).arrayBuffer())
  await archive.extract(destDir)
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
  /** Store factory (receives the progress sink). Default: the core `BinaryStore`. */
  makeStore?: (binDir: string, onProgress: (p: InstallProgress) => void) => Promise<BinaryStore>
}

async function defaultMakeStore(
  binDir: string,
  onProgress: (p: InstallProgress) => void,
): Promise<BinaryStore> {
  const { BinaryStore } = await import("@minimal-agent/core/host/binaries")
  const { getDiagnosticBus, Facility, Severity } = await import(
    "@minimal-agent/core/host/diagnostics"
  )
  const severity = {
    info: Severity.Info,
    notice: Severity.Notice,
    warn: Severity.Warning,
    error: Severity.Error,
  } as const
  return new BinaryStore(binDir, {
    onProgress,
    extractFn: extractWithBunArchive,
    // Same audit trail as plugin binaries (`ma.log`).
    log: (level, source, message, structuredData) => {
      getDiagnosticBus().emit({
        ts: Date.now(),
        severity: severity[level],
        facility: Facility.User,
        source,
        message,
        structuredData,
      })
    },
  })
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
 * Resolve the formatter command, installing the pinned mdstream if needed.
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
  const spec = mdstreamSpecFor(platformKey)
  const cachedLabel = (ver: string | null): string =>
    `mdstream${ver ? ` ${A.sky(ver)}` : ""} ${A.dim("(cached)")}`

  const hasCopy = existsSync(cachedBin)
  let cachedVer: string | null = null
  if (hasCopy) {
    cachedVer = await queryVersion(cachedBin)
    // No pin for this platform, or the copy is already current: no network.
    if (!spec || atLeast(cachedVer, MDSTREAM_PIN.version)) {
      return { cmd: [cachedBin], label: cachedLabel(cachedVer) }
    }
  }

  if (!spec) {
    return {
      cmd: undefined,
      warn:
        `no mdstream release for ${process.platform}/${process.arch}. ` +
        `Install it manually or use ${A.bold("--formatter <cmd>")} to specify a formatter.`,
    }
  }

  // 3. Install (or upgrade an older copy) through the binary store.
  const platformLabel = A.dim(platformKey.replace("-", " · "))
  const versionLabel = A.sky(`v${MDSTREAM_PIN.version}`)
  const verb = hasCopy ? "updating" : "downloading"
  const spinner = startStartupProgressSpinner(
    `${A.dim(verb)}  ${A.bold("mdstream")} ${versionLabel}  ${platformLabel}`,
  )
  const phaseWord: Partial<Record<InstallProgress["phase"], string>> = {
    verifying: "verifying",
    extracting: "extracting",
    installing: "installing",
  }
  let lastPhase: InstallProgress["phase"] | null = null
  const onProgress = (p: InstallProgress): void => {
    if (p.phase === lastPhase) return
    lastPhase = p.phase
    const word = phaseWord[p.phase]
    if (word) {
      spinner.setPhase(`${A.dim(word)}  ${A.bold("mdstream")} ${versionLabel}  ${platformLabel}`)
    }
  }

  let detail: string
  try {
    const store = await (deps.makeStore ?? defaultMakeStore)(binDir, onProgress)
    const outcome = await store.install(spec)
    if (outcome.ok) {
      spinner.done(
        `${A.bold("mdstream")} ${versionLabel}  ${A.dim(hasCopy ? "updated" : "installed")}  ${A.faintWhite("→")}  ${A.dim(outcome.installed.path)}`,
      )
      return {
        cmd: [outcome.installed.path],
        label: `mdstream v${MDSTREAM_PIN.version} ${A.dim("(auto-downloaded)")}`,
      }
    }
    detail = outcome.detail
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
