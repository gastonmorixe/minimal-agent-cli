#!/usr/bin/env bun
/**
 * Package one built binary as a release asset.
 *
 * ```sh
 * bun run scripts/release/package.ts --version 0.1.0 --target linux-x64 \
 *   --binary dist/linux-x64/minimal-agent --out dist/release \
 *   [--smoke e2e|basic|none] [--smoke-note TEXT] \
 *   [--signed developer-id|adhoc|none] [--notarized] [--runner NAME]
 * ```
 *
 * Writes into `--out`:
 *
 *   - `minimal-agent-<version>-<id>.tar.gz`: a flat tarball with the binary
 *     (`minimal-agent`, mode 0755), the CLI `LICENSE`, and a generated
 *     `README.md` stub. Flat, like the mdstream and obscura assets, so one
 *     installer handles all three.
 *   - `<id>.target.json`: this target's row for `build-info.json` (asset
 *     name, sha256, size, smoke and signing status). `assemble.ts` merges
 *     the rows of every build leg.
 *   - `sourcemaps/<id>/minimal-agent.map` when `<binary>.map` exists
 *     (`compile.ts` writes it with `sourcemap: "external"`). `assemble.ts`
 *     tars them into one `minimal-agent-<version>-sourcemaps.tar.gz`.
 *
 * The tarball is reproducible for a given binary (see `writeTarGz`). The
 * mtime is `SOURCE_DATE_EPOCH`, else the binary's mtime.
 *
 * @module scripts/release/package
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  assetName,
  fail,
  parseFlags,
  required,
  runMain,
  sha256File,
  sourceDateEpoch,
  VERSION_RE,
  writeJson,
  writeTarGz,
} from "./lib.ts"
import { findReleaseTarget, RELEASE_TARGET_IDS, type ReleaseTarget } from "./targets.ts"

const CLI_DIR = resolve(import.meta.dir, "..", "..")
/** `e2e`: compile-e2e.sh passed. `basic`: `--help` ran. `none`: never executed. */
const SMOKE_KINDS = ["e2e", "basic", "none"]
const SIGN_KINDS = ["developer-id", "adhoc", "none"]

/** The README stub that ships in every tarball. */
function readmeStub(version: string, t: ReleaseTarget, signed: string): string {
  const lines = [
    `# minimal-agent ${version} (${t.id})`,
    "",
    "A small, inspectable terminal agent harness, as one standalone binary.",
    "",
    "## Install",
    "",
    "```sh",
    `tar -xzf minimal-agent-${version}-${t.id}.tar.gz`,
    "install -m 0755 minimal-agent ~/.local/bin/minimal-agent",
    "minimal-agent --help",
    "```",
    "",
    "Check the download against the release's `SHA256SUMS` first:",
    "`sha256sum -c SHA256SUMS --ignore-missing` (macOS: `shasum -a 256 -c SHA256SUMS --ignore-missing`).",
    "",
  ]
  if (t.os === "darwin" && signed !== "developer-id") {
    lines.push(
      "## macOS",
      "",
      "This build is not signed with a Developer ID. A browser download gets the",
      "quarantine flag and Gatekeeper blocks it. Clear the flag with:",
      "",
      "```sh",
      "xattr -d com.apple.quarantine ./minimal-agent",
      "```",
      "",
    )
  }
  if (t.libc === "musl") {
    lines.push("## musl", "", "Alpine needs `apk add libstdc++ libgcc`.", "")
  }
  if (t.cpu === "baseline") {
    lines.push(
      "## baseline",
      "",
      "For x64 CPUs without AVX2. Use `linux-x64` when the CPU has it.",
      "",
    )
  }
  lines.push(
    "## License",
    "",
    "Proprietary. Copyright Gaston Morixe, all rights reserved. See LICENSE.",
    "",
  )
  return lines.join("\n")
}

/** Entry point. */
function main(): void {
  const flags = parseFlags(
    process.argv.slice(2),
    ["version", "target", "binary", "out", "smoke", "smoke-note", "signed", "runner"],
    ["notarized"],
  )
  const version = required(flags, "version")
  const spec = required(flags, "target")
  const target =
    findReleaseTarget(spec) ??
    fail(`--target ${spec} is not one of ${RELEASE_TARGET_IDS.join(", ")}`)
  const binary = resolve(required(flags, "binary"))
  const out = resolve(required(flags, "out"))
  const smoke = flags.smoke ?? "none"
  const signed = flags.signed ?? (target.os === "darwin" ? "adhoc" : "none")
  if (!SMOKE_KINDS.includes(smoke)) fail(`--smoke ${smoke}: one of ${SMOKE_KINDS.join("|")}`)
  if (!SIGN_KINDS.includes(signed)) fail(`--signed ${signed}: one of ${SIGN_KINDS.join("|")}`)
  if (!VERSION_RE.test(version)) fail(`--version ${version} is not a release version`)
  if (!existsSync(binary) || !statSync(binary).isFile()) fail(`no binary at ${binary}`)

  mkdirSync(out, { recursive: true })
  const stage = mkdtempSync(join(tmpdir(), "ma-package-"))
  try {
    copyFileSync(binary, join(stage, "minimal-agent"))
    chmodSync(join(stage, "minimal-agent"), 0o755)
    copyFileSync(join(CLI_DIR, "LICENSE"), join(stage, "LICENSE"))
    chmodSync(join(stage, "LICENSE"), 0o644)
    writeFileSync(join(stage, "README.md"), readmeStub(version, target, signed), { mode: 0o644 })
    const mtime = sourceDateEpoch(statSync(binary).mtimeMs / 1000)
    const asset = assetName(version, target.id)
    const assetPath = join(out, asset)
    writeTarGz(stage, ["minimal-agent", "LICENSE", "README.md"], assetPath, mtime)

    const map = `${binary}.map`
    const hasMap = existsSync(map)
    if (hasMap) {
      const mapDir = join(out, "sourcemaps", target.id)
      mkdirSync(mapDir, { recursive: true })
      copyFileSync(map, join(mapDir, "minimal-agent.map"))
    }

    const row = {
      id: target.id,
      bunTarget: target.bun,
      os: target.os,
      arch: target.arch,
      libc: target.libc ?? null,
      cpu: target.cpu ?? null,
      priority: target.priority,
      asset,
      sha256: sha256File(assetPath),
      size: statSync(assetPath).size,
      binarySha256: sha256File(binary),
      binarySize: statSync(binary).size,
      smoke,
      // False for a cross-compiled target that no runner executed.
      smoked: smoke !== "none",
      smokeNote: flags["smoke-note"] ?? null,
      signed,
      notarized: flags.notarized === "true",
      sourcemap: hasMap,
      runner: flags.runner ?? null,
      bunVersion: Bun.version,
    }
    writeJson(join(out, `${target.id}.target.json`), row)
    console.log(
      `package: ${asset} sha256 ${row.sha256} (${row.size} bytes, smoke ${smoke}, ${signed})`,
    )
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

if (import.meta.main) await runMain("package", main)
