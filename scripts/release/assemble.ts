#!/usr/bin/env bun
/**
 * Assemble the release from the packaged targets of every build leg.
 *
 * ```sh
 * bun run scripts/release/assemble.ts --dir dist/release --version 0.1.0 \
 *   --channel stable --tag v0.1.0 --cli-sha <sha> --core-sha <sha> \
 *   [--plugins-sha <sha>] [--plugins-ref <ref>] [--require all|priority|none] \
 *   [--expect "linux-x64 darwin-arm64 ..."]
 * ```
 *
 * Reads every `<id>.target.json` that `package.ts` wrote into `--dir`, then
 * writes into the same dir:
 *
 *   - `minimal-agent-<version>-sourcemaps.tar.gz` when any leg shipped a
 *     sourcemap (`sourcemaps/<id>/minimal-agent.map`). Not inside the
 *     binary tarballs: a debug artifact, not something a user installs.
 *   - `build-info.json`: version, channel, tag, source SHAs, Bun version,
 *     the workflow run, and one row per target (asset, sha256, size, smoke
 *     and signing status). A target that was cross-compiled and never run
 *     says `"smoke": "none"` with a note.
 *   - `SHA256SUMS`: `sha256  name` lines (the `sha256sum -c` format) for
 *     every asset, `build-info.json` included.
 *   - `release-notes.md`: a short body for the GitHub release, ending in an
 *     HTML comment the nightly job reads to skip a build with no changes.
 *
 * `--require all` (stable) fails when any target in `--expect` is missing.
 * `--require priority` (nightly) fails only for a missing priority target
 * and warns for the rest.
 *
 * @module scripts/release/assemble
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import {
  fail,
  parseFlags,
  required,
  runMain,
  sha256File,
  sourceDateEpoch,
  sourcemapsAssetName,
  VERSION_RE,
  writeJson,
  writeTarGz,
} from "./lib.ts"
import { RELEASE_TARGETS } from "./targets.ts"

const CLI_DIR = resolve(import.meta.dir, "..", "..")
const OWNER = "gastonmorixe"

/** One row that `package.ts` wrote. Only the fields this script reads are typed. */
interface TargetRow {
  id: string
  asset: string
  sha256: string
  size: number
  priority: boolean
  smoke: string
  smoked: boolean
  smokeNote: string | null
  signed: string
  notarized: boolean
  sourcemap: boolean
  [key: string]: unknown
}

/** The `@minimal-agent/config` commit the CLI package.json pins, or null. */
function configPin(): string | null {
  const pkg = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>
  }
  const spec = pkg.devDependencies?.["@minimal-agent/config"] ?? ""
  return /#([0-9a-f]{7,40})$/.exec(spec)?.[1] ?? null
}

/** The workflow run, when this runs in GitHub Actions. */
function workflowRun(): Record<string, string> | null {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env
  if (!GITHUB_RUN_ID || !GITHUB_REPOSITORY) return null
  return {
    repository: GITHUB_REPOSITORY,
    runId: GITHUB_RUN_ID,
    runAttempt: GITHUB_RUN_ATTEMPT ?? "1",
    url: `${GITHUB_SERVER_URL ?? "https://github.com"}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
  }
}

/** Short smoke label for the notes table. */
function smokeLabel(row: TargetRow): string {
  const base = row.smoke === "e2e" ? "e2e" : row.smoke === "basic" ? "--help only" : "not run"
  return row.smokeNote ? `${base} (${row.smokeNote})` : base
}

/** Entry point. */
function main(): void {
  const flags = parseFlags(process.argv.slice(2), [
    "dir",
    "version",
    "channel",
    "tag",
    "cli-sha",
    "core-sha",
    "plugins-sha",
    "plugins-ref",
    "require",
    "expect",
  ])
  const dir = resolve(required(flags, "dir"))
  const version = required(flags, "version")
  const channel = required(flags, "channel")
  const tag = required(flags, "tag")
  const requireMode = flags.require ?? (channel === "stable" ? "all" : "priority")
  if (!VERSION_RE.test(version)) fail(`--version ${version} is not a release version`)
  if (channel !== "stable" && channel !== "nightly") fail(`--channel ${channel}: stable|nightly`)
  if (!["all", "priority", "none"].includes(requireMode)) fail(`--require ${requireMode}`)
  if (!existsSync(dir)) fail(`no dir ${dir}`)

  const rows: TargetRow[] = readdirSync(dir)
    .filter((name) => name.endsWith(".target.json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as TargetRow)
  const order = RELEASE_TARGETS.map((t) => t.id)
  rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  if (rows.length === 0) fail(`no *.target.json in ${dir}: did any build leg run?`)

  // Every row's tarball must exist and still hash to what the leg recorded.
  for (const row of rows) {
    const path = join(dir, row.asset)
    if (!existsSync(path)) fail(`${row.id}: ${row.asset} is missing from ${dir}`)
    const got = sha256File(path)
    if (got !== row.sha256) fail(`${row.id}: ${row.asset} sha256 ${got} != recorded ${row.sha256}`)
  }

  const expected = (flags.expect ?? order.join(" ")).split(/\s+/).filter(Boolean)
  const have = new Set(rows.map((r) => r.id))
  const missing = expected.filter((id) => !have.has(id))
  for (const id of missing) {
    const priority = RELEASE_TARGETS.find((t) => t.id === id)?.priority === true
    const msg = `target ${id} has no packaged asset`
    if (requireMode === "all" || (requireMode === "priority" && priority)) fail(msg)
    console.log(`::warning::${msg}; the ${channel} release ships without it`)
  }

  // Sourcemaps: one tarball for every target that has one.
  const mapIds = rows.filter((r) => r.sourcemap).map((r) => r.id)
  let sourcemaps: { asset: string; sha256: string; size: number; targets: string[] } | null = null
  if (mapIds.length > 0) {
    const asset = sourcemapsAssetName(version)
    const mapRoot = join(dir, "sourcemaps")
    for (const id of mapIds) {
      if (!existsSync(join(mapRoot, id, "minimal-agent.map"))) fail(`${id}: sourcemap file missing`)
    }
    const mtime = sourceDateEpoch(Date.now() / 1000)
    writeTarGz(mapRoot, mapIds, join(dir, asset), mtime)
    const path = join(dir, asset)
    sourcemaps = { asset, sha256: sha256File(path), size: statSync(path).size, targets: mapIds }
  }

  const info = {
    schema: 1,
    name: "minimal-agent",
    version,
    channel,
    tag,
    prerelease: channel !== "stable",
    createdAt: new Date().toISOString(),
    sources: {
      cli: { repo: `${OWNER}/minimal-agent-cli`, sha: required(flags, "cli-sha") },
      core: { repo: `${OWNER}/minimal-agent-core`, sha: required(flags, "core-sha") },
      plugins: {
        repo: `${OWNER}/minimal-agent-plugins`,
        ref: flags["plugins-ref"] ?? null,
        sha: flags["plugins-sha"] ?? null,
      },
      config: { repo: `${OWNER}/minimal-agent-config`, sha: configPin() },
    },
    bunVersion: Bun.version,
    workflow: workflowRun(),
    targets: rows,
    missing,
    sourcemaps,
  }
  writeJson(join(dir, "build-info.json"), info)

  const sumNames = [
    ...rows.map((r) => r.asset),
    ...(sourcemaps ? [sourcemaps.asset] : []),
    "build-info.json",
  ].sort()
  const sums = sumNames.map((name) => `${sha256File(join(dir, name))}  ${name}`).join("\n")
  writeFileSync(join(dir, "SHA256SUMS"), `${sums}\n`)

  const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "?")
  const notes = [
    channel === "stable"
      ? `minimal-agent ${version}.`
      : `Nightly build of minimal-agent ${version}. Pre-release: not for production use.`,
    "",
    `Sources: cli \`${short(info.sources.cli.sha)}\`, core \`${short(info.sources.core.sha)}\`, ` +
      `plugins \`${short(info.sources.plugins.sha)}\`. Bun ${Bun.version}.`,
    "",
    "| target | asset | smoke | signed |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.id}${r.priority ? " (priority)" : ""} | \`${r.asset}\` | ${smokeLabel(r)} | ` +
        `${r.signed}${r.notarized ? " + notarized" : ""} |`,
    ),
    "",
    ...(missing.length > 0 ? [`Missing from this build: ${missing.join(", ")}.`, ""] : []),
    "Verify: `sha256sum -c SHA256SUMS --ignore-missing` (macOS: `shasum -a 256 -c ...`).",
    "",
    // Read by the nightly job to skip a run whose sources did not move.
    `<!-- ma-build cli=${info.sources.cli.sha} core=${info.sources.core.sha} plugins=${info.sources.plugins.sha ?? ""} -->`,
    "",
  ].join("\n")
  writeFileSync(join(dir, "release-notes.md"), notes)

  console.log(`assemble: ${rows.length} target(s), ${missing.length} missing, SHA256SUMS:`)
  console.log(sums)
}

if (import.meta.main) await runMain("assemble", main)
