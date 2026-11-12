/**
 * Which release asset fits this host, for `minimal-agent update`.
 *
 * The asset ids are those of `scripts/release/targets.ts`:
 * `<os>-<arch>[-baseline|-musl]`, and the tarball of one id is
 * `minimal-agent-<label>-<id>.tar.gz` (`scripts/release/lib.ts`). This
 * module keeps its own copy of the id rules, because `src/` must not import
 * `scripts/` (the scripts are not in the binary).
 *
 * Detection (Linux only, macOS has neither variant):
 * - musl: a `/lib/ld-musl-*` loader exists, else `ldd --version` mentions
 *   musl. `ldd` is optional: a host without it counts as glibc.
 * - baseline: x64 only, when `/proc/cpuinfo` has a `flags` line with no
 *   `avx2`. An unreadable cpuinfo counts as AVX2 (the common case).
 *
 * The probes are injected, so tests run on any host.
 *
 * @module update/target
 */

import { readdirSync, readFileSync } from "node:fs"

/** The facts the picker needs about the host. */
export interface HostFacts {
  /** `process.platform`. */
  readonly platform: string
  /** `process.arch`. */
  readonly arch: string
  /** True on a musl libc host (Alpine). */
  readonly musl: boolean
  /** False on an x64 CPU without AVX2. */
  readonly avx2: boolean
}

/** Host probes. Each returns raw data, the pure functions decide. */
export interface HostProbes {
  readonly platform: string
  readonly arch: string
  /** Names in `/lib` (empty on error). */
  readonly libEntries: () => readonly string[]
  /** `ldd --version` stdout + stderr, or undefined when `ldd` is missing. */
  readonly lddVersion: () => string | undefined
  /** `/proc/cpuinfo` text, or undefined when unreadable. */
  readonly cpuinfo: () => string | undefined
}

/** The real probes. */
export function realHostProbes(): HostProbes {
  return {
    platform: process.platform,
    arch: process.arch,
    libEntries: () => {
      try {
        return readdirSync("/lib")
      } catch {
        return []
      }
    },
    lddVersion: () => {
      if (!Bun.which("ldd")) return undefined
      try {
        const r = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" })
        return `${r.stdout.toString()}${r.stderr.toString()}`
      } catch {
        return undefined
      }
    },
    cpuinfo: () => {
      try {
        return readFileSync("/proc/cpuinfo", "utf8")
      } catch {
        return undefined
      }
    },
  }
}

/** True when `/lib` names a musl loader or `ldd --version` says musl. */
export function detectMusl(probes: Pick<HostProbes, "libEntries" | "lddVersion">): boolean {
  if (probes.libEntries().some((name) => name.startsWith("ld-musl-"))) return true
  return /musl/iu.test(probes.lddVersion() ?? "")
}

/**
 * False only when cpuinfo has a `flags` line and none of them lists `avx2`.
 * Unknown (no cpuinfo, no flags line) counts as AVX2.
 */
export function detectAvx2(cpuinfo: string | undefined): boolean {
  if (cpuinfo === undefined) return true
  const flagLines = cpuinfo.split("\n").filter((line) => /^flags\s*:/u.test(line))
  if (flagLines.length === 0) return true
  return flagLines.some((line) => /\bavx2\b/u.test(line))
}

/** Collect the host facts through `probes`. Linux-only probes run only on Linux. */
export function detectHost(probes: HostProbes = realHostProbes()): HostFacts {
  const linux = probes.platform === "linux"
  return {
    platform: probes.platform,
    arch: probes.arch,
    musl: linux && detectMusl(probes),
    avx2: !(linux && probes.arch === "x64") || detectAvx2(probes.cpuinfo()),
  }
}

/** The error for a host with no release target. */
export class UnsupportedHostError extends Error {}

/**
 * The asset ids that run on this host, best first. A later id is a
 * fallback when the release lacks the first (a baseline x64 binary runs on
 * any x64 CPU, so it backs up `linux-x64`). An x64 host without AVX2 gets
 * only `linux-x64-baseline`: the default binary would die on an illegal
 * instruction.
 *
 * @throws UnsupportedHostError for Windows or an unknown os or arch
 */
export function candidateTargetIds(host: HostFacts): string[] {
  const arch = host.arch === "arm64" || host.arch === "aarch64" ? "arm64" : host.arch
  if (arch !== "x64" && arch !== "arm64") {
    throw new UnsupportedHostError(`no release build for arch ${host.arch}`)
  }
  if (host.platform === "darwin") return [`darwin-${arch}`]
  if (host.platform !== "linux") {
    throw new UnsupportedHostError(`no release build for ${host.platform} (macOS and Linux only)`)
  }
  // musl x64 has no baseline build in the target table: ship the plain musl one.
  if (host.musl) return [`linux-${arch}-musl`]
  if (arch === "arm64") return ["linux-arm64"]
  return host.avx2 ? ["linux-x64", "linux-x64-baseline"] : ["linux-x64-baseline"]
}

/** The tarball name of one target: `minimal-agent-<label>-<id>.tar.gz`. */
export function assetName(label: string, id: string): string {
  return `minimal-agent-${label}-${id}.tar.gz`
}

/** The asset that the picker chose. */
export interface PickedAsset<A> {
  readonly id: string
  readonly asset: A
  /** True when a fallback id was used (the release lacks the best one). */
  readonly fallback: boolean
}

/**
 * Pick the release asset for `host` among `assets` (by name).
 *
 * @returns the pick, or undefined when the release has no asset for the host
 */
export function pickAsset<A extends { readonly name: string }>(
  label: string,
  host: HostFacts,
  assets: readonly A[],
): PickedAsset<A> | undefined {
  const ids = candidateTargetIds(host)
  for (const [i, id] of ids.entries()) {
    const asset = assets.find((a) => a.name === assetName(label, id))
    if (asset !== undefined) return { id, asset, fallback: i > 0 }
  }
  return undefined
}
