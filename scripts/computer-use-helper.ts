/**
 * Build the computer-use helper of `ma-computer-use-plugin` for a darwin
 * compile target, so `scripts/compile.ts` can embed it as a plugin file.
 * The plugin extracts it at run time with
 * `pluginPackageFor(ctx.packageDir).execPath(HELPER_KEY)` (core writes it
 * with mode 0o755).
 *
 * One Mach-O file for each target, from the sorted `native/Sources/*.swift`.
 * {@link swiftcCommand} gives the `xcrun swiftc` command line, with
 * `-target ARCH-apple-macos14` and `-Xlinker -adhoc_codesign`. The output is
 * `tmp/cu-helper/TARGET_ID/ComputerUseHelper` in `compile.ts`.
 *
 * The arch comes from the compile target, never from `process.arch`: a
 * darwin-x64 release cross-compiles on an arm64 runner. `ld` signs an arm64
 * output ad hoc by default, but not an x86_64 output, so the command adds
 * `-adhoc_codesign`. Then `codesign --verify --strict` must pass, and
 * `--selftest` runs when the host can run the arch (an x86_64 helper on an
 * arm64 host only when Rosetta is installed).
 *
 * A release has the plugins from `git archive`, so `native/build` is absent
 * there and the build always starts from `native/Sources`.
 *
 * @module scripts/computer-use-helper
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

import { findReleaseTarget } from "./release/targets.ts"

/** The plugin package that gets the helper. */
export const HELPER_PACKAGE = "ma-computer-use-plugin"
/** The package key of the helper. The plugin reads this exact key. */
export const HELPER_KEY = "native/build/ComputerUseHelper"
/** The swiftc module name and the output file name (`pgrep -f ComputerUseHelper`). */
const MODULE_NAME = "ComputerUseHelper"
/** The lowest macOS that the helper supports (the Swift sources gate at 14.0). */
const MIN_MACOS = "14"
/** This file exists only when Rosetta 2 is installed. A file check shows no dialog. */
const ROSETTA_RUNTIME = "/Library/Apple/usr/libexec/oah/libRosettaRuntime"
/** Time limits: one swiftc run (about 20 s on an M1 Max), and each other command. */
const SWIFTC_TIMEOUT_MS = 600_000
const TOOL_TIMEOUT_MS = 60_000

/** A helper build failure. `compile.ts` prints it and writes no binary. */
export class HelperBuildError extends Error {}

/** The swiftc arch name of a darwin target. */
export type SwiftArch = "arm64" | "x86_64"

/**
 * The swiftc arch for a compile target.
 *
 * @param target - a release target id (`darwin-x64`) or its Bun string (`bun-darwin-x64`)
 * @returns `arm64` or `x86_64` for a darwin target, else undefined
 */
export function swiftArchOf(target: string): SwiftArch | undefined {
  const t = findReleaseTarget(target)
  if (t === undefined || t.os !== "darwin") return undefined
  return t.arch === "x64" ? "x86_64" : "arm64"
}

/** The build host: `process.platform` and `process.arch`. */
export interface BuildHost {
  readonly platform: string
  readonly arch: string
}

/**
 * True when a helper for `arch` can run on the host.
 *
 * @param arch - the helper arch
 * @param host - the build host
 * @param rosetta - true when Rosetta 2 is installed on the host
 */
export function canRunOnHost(arch: SwiftArch, host: BuildHost, rosetta: boolean): boolean {
  if (host.platform !== "darwin") return false
  if (arch === "arm64") return host.arch === "arm64"
  return host.arch === "x64" || (host.arch === "arm64" && rosetta)
}

/** The helper source dir in a plugins tree. */
export function helperSourceDir(pluginsDir: string): string {
  return join(pluginsDir, HELPER_PACKAGE, "native", "Sources")
}

/**
 * Every `.swift` file in the helper source dir, sorted by name, as full
 * paths. Empty when the dir is absent.
 */
export function helperSources(pluginsDir: string): string[] {
  const dir = helperSourceDir(pluginsDir)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith(".swift") && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => join(dir, name))
}

/** The swiftc command line that builds the helper for `arch` into `out`. */
export function swiftcCommand(arch: SwiftArch, sources: readonly string[], out: string): string[] {
  return [
    "xcrun",
    "swiftc",
    "-O",
    "-target",
    `${arch}-apple-macos${MIN_MACOS}`,
    "-module-name",
    MODULE_NAME,
    "-Xlinker",
    "-adhoc_codesign",
    ...sources,
    "-o",
    out,
  ]
}

/** The `flags=0x...(...)` value of `codesign -dv` output, or undefined. */
export function codesignFlags(out: string): string | undefined {
  return /\bflags=(0x[0-9a-f]+\([^)]*\))/.exec(out)?.[1]
}

/** The `selftest: N/N passed` line of `--selftest` output when all checks pass, or undefined. */
export function selftestSummary(out: string): string | undefined {
  const m = /selftest: (\d+)\/(\d+) passed/.exec(out)
  return m !== null && m[1] === m[2] ? m[0] : undefined
}

/** Run one command to completion. `exitCode` is null on a timeout. `out` is stdout and stderr. */
export type Runner = (
  cmd: string[],
  timeoutMs: number,
) => Promise<{ exitCode: number | null; out: string }>

/** The host parts of a helper build, so a test can replace them. */
export interface HelperBuildDeps {
  readonly run: Runner
  /** Why the host cannot run swiftc, or undefined when it can. */
  readonly toolchainGap: () => string | undefined
  readonly host: BuildHost
  /** True when Rosetta 2 is installed. */
  readonly rosetta: () => boolean
}

/** One helper build. */
export interface HelperBuildRequest {
  /** The compile target, a release target id or its Bun string. */
  readonly target: string
  /** A release fails when the helper cannot be built. Dev continues without it. */
  readonly mode: "dev" | "release"
  /** The plugins tree to read `native/Sources` from. */
  readonly pluginsDir: string
  /** The output root. The helper goes to `<outRoot>/<target id>/ComputerUseHelper`. */
  readonly outRoot: string
}

/** The result of {@link buildComputerUseHelper}. */
export type HelperResult =
  | { readonly kind: "not-darwin" }
  | { readonly kind: "missing"; readonly reason: string }
  | {
      readonly kind: "built"
      readonly id: string
      readonly arch: SwiftArch
      readonly path: string
      readonly size: number
      readonly flags: string
      readonly selftest: string
    }

/**
 * Why this host cannot run `xcrun swiftc`, or undefined. It never runs
 * `xcrun`: on a Mac with no developer tools, `xcrun` shows an install
 * dialog. `xcode-select -p` only reads the setting.
 */
export function defaultToolchainGap(): string | undefined {
  if (process.platform !== "darwin")
    return `swiftc needs a macOS host, this host is ${process.platform}`
  if (Bun.which("xcrun") === null) return "xcrun is not on PATH"
  if ((process.env.DEVELOPER_DIR ?? "") !== "") return undefined
  const r = Bun.spawnSync(["xcode-select", "-p"], { stdout: "pipe", stderr: "pipe" })
  return r.exitCode === 0 ? undefined : "no Xcode or Command Line Tools (xcode-select -p failed)"
}

/** True when Rosetta 2 is installed on this host. */
export function hasRosetta(): boolean {
  return existsSync(ROSETTA_RUNTIME)
}

/**
 * Build, verify and selftest the helper for `req.target`.
 *
 * @returns `not-darwin` for a target that gets no helper, `missing` when a
 *   dev build has no sources or no toolchain, else the built file
 * @throws HelperBuildError when a release has no sources or no toolchain,
 *   or when swiftc, the signature check or the selftest fails (all modes)
 */
export async function buildComputerUseHelper(
  req: HelperBuildRequest,
  deps: HelperBuildDeps,
): Promise<HelperResult> {
  const arch = swiftArchOf(req.target)
  const id = findReleaseTarget(req.target)?.id
  if (arch === undefined || id === undefined) return { kind: "not-darwin" }
  const sources = helperSources(req.pluginsDir)
  const gap =
    sources.length === 0
      ? `no Swift sources in ${helperSourceDir(req.pluginsDir)}`
      : deps.toolchainGap()
  if (gap !== undefined) {
    if (req.mode === "release") {
      throw new HelperBuildError(
        `computer-use helper for ${id}: ${gap}. A release must embed the helper.`,
      )
    }
    return { kind: "missing", reason: gap }
  }
  const dir = join(req.outRoot, id)
  const out = join(dir, MODULE_NAME)
  rmSync(out, { force: true })
  mkdirSync(dir, { recursive: true })
  const step = async (label: string, cmd: string[], timeoutMs: number): Promise<string> => {
    const r = await deps.run(cmd, timeoutMs)
    if (r.exitCode !== 0) {
      const why = r.exitCode === null ? `no exit within ${timeoutMs / 1000}s` : `exit ${r.exitCode}`
      const tail = r.out.trim().split("\n").slice(-20).join("\n")
      throw new HelperBuildError(`computer-use helper for ${id}: ${label} failed (${why})\n${tail}`)
    }
    return r.out
  }
  await step("swiftc", swiftcCommand(arch, sources, out), SWIFTC_TIMEOUT_MS)
  if (!existsSync(out)) {
    throw new HelperBuildError(`computer-use helper for ${id}: swiftc wrote no file at ${out}`)
  }
  await step(
    "codesign --verify --strict",
    ["codesign", "--verify", "--strict", out],
    TOOL_TIMEOUT_MS,
  )
  const flags = codesignFlags(await step("codesign -dv", ["codesign", "-dv", out], TOOL_TIMEOUT_MS))
  if (flags === undefined) {
    throw new HelperBuildError(`computer-use helper for ${id}: codesign -dv printed no flags`)
  }
  let selftest: string
  if (canRunOnHost(arch, deps.host, deps.rosetta())) {
    const text = await step("--selftest", [out, "--selftest"], TOOL_TIMEOUT_MS)
    selftest =
      selftestSummary(text) ??
      fail(`computer-use helper for ${id}: --selftest printed no "selftest: N/N passed" line`)
  } else {
    selftest = `selftest skipped (${arch} cannot run on this ${deps.host.platform}-${deps.host.arch} host)`
  }
  return { kind: "built", id, arch, path: out, size: statSync(out).size, flags, selftest }
}

function fail(msg: string): never {
  throw new HelperBuildError(msg)
}
