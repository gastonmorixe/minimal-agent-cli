/**
 * Build identity of this CLI (plan phase 2, tasks 2.1 and 2.2).
 *
 * `scripts/compile.ts` passes `define: { MA_BUILD_INFO: <json> }` to
 * `Bun.build`, so a compiled binary carries its commit SHAs, build mode,
 * target, and build date as a literal. A run from source has no define:
 * {@link buildInfo} then returns `dev` SHAs and mode `source`. It never runs
 * git at runtime (slow, and a binary host may have no git).
 *
 * Pure apart from reading the define, `Bun.version`, and `process`. No I/O.
 *
 * @module cli/build-info
 */

import pkg from "../../package.json" with { type: "json" }

/** The shape `scripts/compile.ts` writes into `MA_BUILD_INFO`. */
export interface BuildInfo {
  /** CLI semver, from the CLI `package.json`. */
  readonly version: string
  /** Full CLI commit SHA, or `dev` when unknown. */
  readonly cliSha: string
  /** Full core commit SHA (the pinned or working-tree commit), or `dev`. */
  readonly coreSha: string
  /** Full plugins commit SHA, or `dev` when unknown. */
  readonly pluginsSha: string
  /** True when a source tree had uncommitted tracked changes at build time. */
  readonly dirty: boolean
  /** The Bun version that built (and runs) the binary. */
  readonly bunVersion: string
  /** `<os>-<arch>[-<variant>]`, for example `linux-arm64`. */
  readonly target: string
  /** `dev` or `release` for a compiled binary, `source` for a run from source. */
  readonly mode: "dev" | "release" | "source"
  /** ISO 8601 build time, or `unknown` from source. */
  readonly builtAt: string
}

// Replaced by an object literal at build time. Absent from source.
declare const MA_BUILD_INFO: Partial<BuildInfo> | undefined

/** The placeholder for an unknown SHA. */
export const UNKNOWN_SHA = "dev"

/** The `version` field of the CLI package.json, or `0.0.0`. */
function packageVersion(): string {
  const version: unknown = (pkg as { version?: unknown }).version
  return typeof version === "string" ? version : "0.0.0"
}

/** The raw define, or undefined from source. Read once, through `typeof`. */
function rawDefine(): Partial<BuildInfo> | undefined {
  const raw = typeof MA_BUILD_INFO === "undefined" ? undefined : MA_BUILD_INFO
  return raw !== null && typeof raw === "object" ? raw : undefined
}

/** A non-empty string field, else `fallback`. */
function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

/**
 * Normalize a raw define into a full {@link BuildInfo}. Missing or bad
 * fields get the source defaults. Exported for tests.
 */
export function normalizeBuildInfo(raw: Partial<BuildInfo> | undefined): BuildInfo {
  const mode = raw?.mode === "dev" || raw?.mode === "release" ? raw.mode : "source"
  return {
    version: str(raw?.version, packageVersion()),
    cliSha: str(raw?.cliSha, UNKNOWN_SHA),
    coreSha: str(raw?.coreSha, UNKNOWN_SHA),
    pluginsSha: str(raw?.pluginsSha, UNKNOWN_SHA),
    dirty: raw?.dirty === true,
    bunVersion: str(raw?.bunVersion, Bun.version),
    target: str(raw?.target, `${process.platform}-${process.arch}`),
    mode,
    builtAt: str(raw?.builtAt, "unknown"),
  }
}

let cached: BuildInfo | undefined

/** This process's build identity. Same object on every call. */
export function buildInfo(): BuildInfo {
  cached ??= normalizeBuildInfo(rawDefine())
  return cached
}

/** The first 7 chars of a SHA, or the placeholder unchanged. */
export function shortSha(sha: string): string {
  return /^[0-9a-f]{8,}$/.test(sha) ? sha.slice(0, 7) : sha
}

/**
 * The one-line version text:
 * `minimal-agent <semver> (cli <sha7>, core <sha7>, plugins <sha7>) bun <ver> <os>-<arch> <mode> built <date>`.
 * A dirty build shows its mode as `<mode>+dirty`.
 */
export function formatVersionLine(info: BuildInfo, program = "minimal-agent"): string {
  const mode = info.dirty ? `${info.mode}+dirty` : info.mode
  return (
    `${program} ${info.version} ` +
    `(cli ${shortSha(info.cliSha)}, core ${shortSha(info.coreSha)}, plugins ${shortSha(info.pluginsSha)}) ` +
    `bun ${info.bunVersion} ${info.target} ${mode} built ${info.builtAt}`
  )
}

/**
 * The agent version string for durable records (the session meta
 * `agentVersion`). From source it is the plain semver. A compiled binary
 * adds semver build metadata: `0.1.0+<cli sha7>.<mode>[.dirty]`.
 */
export function recordedAgentVersion(semver: string, info: BuildInfo = buildInfo()): string {
  if (info.mode === "source") return semver
  const parts = [shortSha(info.cliSha), info.mode, ...(info.dirty ? ["dirty"] : [])]
  return `${semver}+${parts.join(".")}`
}
