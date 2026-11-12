/**
 * Small helpers shared by the release scripts. Bun and `node:*` only.
 *
 * @module scripts/release/lib
 */

import { readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** A release script failure with a message for the user. */
export class ReleaseError extends Error {}

/** Throw a {@link ReleaseError}. The script's main block prints it and exits 1. */
export function fail(msg: string): never {
  throw new ReleaseError(msg)
}

/** Parsed flags: a value flag maps to its string, a boolean flag to `"true"`. */
export type Flags = Partial<Record<string, string>>

/**
 * Parse `--name value` and `--flag` arguments. An unknown or repeated
 * argument fails, so a typo in the workflow never goes unnoticed.
 *
 * @param argv - the arguments after the script path
 * @param values - the flags that take a value, without the dashes
 * @param booleans - the flags that take no value, without the dashes
 * @returns the parsed flags
 */
export function parseFlags(
  argv: readonly string[],
  values: readonly string[],
  booleans: readonly string[] = [],
): Flags {
  const out: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ""
    const name = arg.replace(/^--/, "")
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`)
    if (out[name] !== undefined) fail(`${arg} given twice`)
    if (values.includes(name)) {
      const v = argv[++i]
      if (v === undefined || v.startsWith("--")) fail(`${arg} needs a value`)
      out[name] = v
    } else if (booleans.includes(name)) {
      out[name] = "true"
    } else {
      fail(`unknown argument: ${arg}`)
    }
  }
  return out
}

/** A required flag, or a failure that names it. */
export function required(flags: Flags, name: string): string {
  const v = flags[name]
  if (v === undefined || v === "") fail(`--${name} is required`)
  return v
}

/** Release version labels: `0.1.0` or `0.1.0-nightly.20261112T190000Z`. */
export const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** The tarball name of one target: `minimal-agent-<version>-<id>.tar.gz`. */
export function assetName(version: string, id: string): string {
  return `minimal-agent-${version}-${id}.tar.gz`
}

/** The sourcemaps tarball name: `minimal-agent-<version>-sourcemaps.tar.gz`. */
export function sourcemapsAssetName(version: string): string {
  return `minimal-agent-${version}-sourcemaps.tar.gz`
}

/** Hex sha256 of a file. Reads it whole (a binary is ~110 MB, fine on a runner). */
export function sha256File(path: string): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(readFileSync(path))
  return hasher.digest("hex")
}

/** Write pretty JSON with a trailing newline. */
export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Run a command, fail with its stderr on a non-zero exit. */
export function run(cmd: readonly string[], cwd?: string): string {
  const r = Bun.spawnSync([...cmd], { cwd, stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) {
    fail(`${cmd.join(" ")} failed (exit ${r.exitCode}): ${r.stderr.toString().trim()}`)
  }
  return r.stdout.toString()
}

/** True when `tar` is GNU tar (Linux runners). macOS ships bsdtar. */
function isGnuTar(): boolean {
  const r = Bun.spawnSync(["tar", "--version"], { stdout: "pipe", stderr: "pipe" })
  return r.stdout.toString().includes("GNU tar")
}

/**
 * Write a reproducible gzip tarball `out` of `names` (paths relative to
 * `dir`, files or dirs): sorted entries, owner 0, every mtime set to
 * `mtime` (epoch seconds), no gzip name or timestamp. GNU tar and bsdtar
 * spell the owner flags differently, and bsdtar has no `--mtime`, so the
 * files themselves get the time stamp first.
 */
export function writeTarGz(
  dir: string,
  names: readonly string[],
  out: string,
  mtime: number,
): void {
  const sorted = [...names].sort()
  for (const name of sorted) utimesSync(join(dir, name), mtime, mtime)
  const owner = isGnuTar()
    ? ["--owner=0", "--group=0", "--numeric-owner", "--sort=name", `--mtime=@${mtime}`]
    : ["--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root"]
  const tarPath = out.replace(/\.gz$/, "")
  if (tarPath === out) fail(`${out} must end in .gz`)
  rmSync(tarPath, { force: true })
  rmSync(out, { force: true })
  run(["tar", ...owner, "--format", "ustar", "-cf", tarPath, "-C", dir, ...sorted])
  run(["gzip", "-n", "-9", tarPath])
}

/** `SOURCE_DATE_EPOCH` when set to a positive integer, else `fallback`. */
export function sourceDateEpoch(fallback: number): number {
  const epoch = Number(process.env.SOURCE_DATE_EPOCH)
  return Number.isInteger(epoch) && epoch > 0 ? epoch : Math.floor(fallback)
}

/** Run `main`, print a {@link ReleaseError} as `<tag>: <message>`, exit 1. */
export async function runMain(tag: string, main: () => void | Promise<void>): Promise<void> {
  try {
    await main()
  } catch (e) {
    if (!(e instanceof ReleaseError)) throw e
    console.error(`${tag}: ${e.message}`)
    process.exit(1)
  }
}
