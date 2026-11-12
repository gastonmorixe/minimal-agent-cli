/**
 * The `minimal-agent update` engine: find a release, compare, download,
 * verify, smoke, swap. Every side effect goes through {@link UpdateDeps},
 * so tests drive it with a fake GitHub, filesystem, and exec.
 *
 * Flow (see `commands/update.ts` for the argv side):
 *
 * 1. Install kind. A run from source and a Homebrew Cellar binary print what
 *    to do instead and exit 0. Only a standalone binary is replaced.
 * 2. `--rollback`: swap `<exe>.old` back in (the replaced binary becomes the
 *    new `.old`, so a second rollback undoes the first). No network.
 * 3. Token: the releases are on the PRIVATE CLI repo, so a token is required
 *    (`MINIMAL_AGENT_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `gh auth token`).
 * 4. Release: stable is `/releases/latest`, nightly is the newest published
 *    pre-release tagged `v<x.y.z>-nightly.<stamp>`, `--to` is one exact tag.
 * 5. Compare: the release's `build-info.json` SHAs equal to the running
 *    binary's means the same build. Else version order (`update/version.ts`).
 *    A release older than the binary is refused unless `--to` names it.
 *    `--check` stops here: exit 0 (current or ahead) or 10 (update available).
 * 6. Asset for this host (`update/target.ts`), download it and `SHA256SUMS`,
 *    verify the sha256, extract only `minimal-agent`, write `<exe>.new`
 *    (0755) next to the binary, run `<exe>.new version --json`, check the
 *    version, keep the current binary as `<exe>.old`, then `rename(2)` the
 *    new one over `process.execPath`. A failure at any step before the
 *    rename leaves the current binary untouched and removes `<exe>.new`.
 *
 * Plugins are embedded in the binary, so update never touches the plugin
 * dirs (`~/.minimal-agent/plugins` stays as the user override tier).
 *
 * @module update/run
 */

import { dirname } from "node:path"

import type { BuildInfo } from "../cli/build-info.ts"
import { ArchiveError, extractFromTarGz, parseSha256Sums, sha256Hex } from "./archive.ts"
import {
  type FetchFn,
  GithubError,
  GithubReleases,
  newestNightly,
  privateRepoHint,
  RELEASE_REPO,
  type Release,
  type ReleaseAsset,
} from "./github.ts"
import { detectInstallKind, type InstallKind, installKindMessage } from "./install-kind.ts"
import type { ExecFn, UpdateFs } from "./io.ts"
import { candidateTargetIds, type HostFacts, pickAsset, UnsupportedHostError } from "./target.ts"
import {
  compareVersions,
  coreVersion,
  parseLabel,
  type ReleaseLabel,
  tagOf,
  type VersionPoint,
} from "./version.ts"

/** Exit codes of `minimal-agent update`. */
export const UPDATE_EXIT = {
  /** Up to date, updated, rolled back, or a source/brew install (nothing to do here). */
  ok: 0,
  /** Any other failure: network, checksum, smoke, swap. The binary is unchanged. */
  error: 1,
  /** Bad arguments. */
  usage: 2,
  /** No GitHub token, or the token cannot read the private repo. */
  auth: 3,
  /** No matching release, no asset for this host, or no `<exe>.old` to roll back to. */
  notFound: 4,
  /** The binary's directory is not writable. The manual command is printed. */
  notWritable: 5,
  /** `--check` only: a newer release exists. */
  updateAvailable: 10,
} as const

/** The release channel. */
export type Channel = "stable" | "nightly"

/** Parsed options of one `update` run. */
export interface UpdateOptions {
  readonly check: boolean
  readonly channel: Channel
  /** An exact version or tag (`0.2.0`, `v0.2.0-nightly.20261112T200000Z`). */
  readonly to?: string
  readonly rollback: boolean
  readonly json: boolean
}

/** Everything the engine touches. */
export interface UpdateDeps {
  readonly env: Record<string, string | undefined>
  readonly build: BuildInfo
  /** `Bun.isStandaloneExecutable`. */
  readonly standalone: boolean
  /** `process.execPath` (resolved through {@link UpdateFs.realpath} here). */
  readonly execPath: string
  readonly host: HostFacts
  readonly fs: UpdateFs
  readonly exec: ExecFn
  readonly fetch: FetchFn
  /** The token chain. The real one is core's `resolveGithubToken`. */
  readonly resolveToken: (env: Record<string, string | undefined>) => Promise<string | null>
  /** Progress lines (stderr in the real command). Not called in JSON mode. */
  readonly progress: (line: string) => void
  /** API base override (tests). Default `MINIMAL_AGENT_UPDATE_API` or api.github.com. */
  readonly apiBase?: string
}

/** The outcome: an exit code, the human text, and the JSON object. */
export interface UpdateOutcome {
  readonly code: number
  /** One or more lines for stdout (code 0 or 10) or stderr (anything else). */
  readonly text: string
  readonly json: Record<string, unknown>
}

/** The binary name inside every release tarball. */
export const BINARY_MEMBER = "minimal-agent"

/** The smoke test's time limit. A cold compiled binary starts in well under 1 s. */
const SMOKE_TIMEOUT_MS = 30_000

/** The text shown when no token is found. Never includes a token. */
export function noTokenMessage(repo = RELEASE_REPO): string {
  return [
    `no GitHub token: minimal-agent releases live on ${repo}, which is a private repo.`,
    "Provide a token with read access to it, one of:",
    "  export MINIMAL_AGENT_GITHUB_TOKEN=<token>   (or GITHUB_TOKEN, GH_TOKEN)",
    "  gh auth login                               (then update uses gh auth token)",
  ].join("\n")
}

/** A failure with an exit code. Thrown inside the engine, caught by {@link runUpdate}. */
class UpdateFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

/** The running binary as a {@link VersionPoint}. */
function currentPoint(build: BuildInfo): VersionPoint {
  const label = parseLabel(build.version) ?? parseLabel("0.0.0")
  if (label === undefined) throw new Error("unreachable: 0.0.0 parses")
  const t = new Date(build.builtAt)
  return Number.isNaN(t.getTime()) ? { label } : { label, time: t }
}

/** A release as a {@link VersionPoint}: the nightly stamp, else its publish time. */
function releasePoint(release: Release, label: ReleaseLabel): VersionPoint {
  const t = release.published_at ? new Date(release.published_at) : undefined
  return t !== undefined && !Number.isNaN(t.getTime()) ? { label, time: t } : { label }
}

/** The fields of a release `build-info.json` the updater reads. */
interface ReleaseBuildInfo {
  readonly sources?: {
    readonly cli?: { readonly sha?: string | null }
    readonly core?: { readonly sha?: string | null }
    readonly plugins?: { readonly sha?: string | null }
  }
  readonly targets?: readonly {
    readonly id?: string
    readonly binarySha256?: string
    readonly signed?: string
    readonly notarized?: boolean
    readonly smoked?: boolean
  }[]
}

/** True when the release was built from the same cli, core, and plugins commits. */
function sameBuild(info: ReleaseBuildInfo | undefined, build: BuildInfo): boolean {
  const s = info?.sources
  if (!s?.cli?.sha || !s.core?.sha) return false
  if (build.dirty) return false
  const pluginsMatch = !s.plugins?.sha || s.plugins.sha === build.pluginsSha
  return s.cli.sha === build.cliSha && s.core.sha === build.coreSha && pluginsMatch
}

/** Find an asset by exact name. */
function assetNamed(release: Release, name: string): ReleaseAsset | undefined {
  return release.assets.find((a) => a.name === name)
}

/** The `<exe>.new` and `<exe>.old` paths. */
export function sidePaths(exe: string): { readonly next: string; readonly old: string } {
  return { next: `${exe}.new`, old: `${exe}.old` }
}

/** Env for running a downloaded binary: no `BUN_BE_BUN` (it would run as plain bun). */
function smokeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...env }
  delete out.BUN_BE_BUN
  return out
}

/** Run `<bin> version --json` and parse it. */
async function probeVersion(
  deps: UpdateDeps,
  bin: string,
): Promise<{ ok: true; info: Partial<BuildInfo> } | { ok: false; why: string }> {
  const r = await deps.exec([bin, "version", "--json"], smokeEnv(deps.env), SMOKE_TIMEOUT_MS)
  if (r.exitCode !== 0) {
    const tail = r.stderr.trim().split("\n").slice(-3).join(" | ")
    return { ok: false, why: `exit ${r.exitCode}${tail ? `: ${tail}` : ""}` }
  }
  try {
    return { ok: true, info: JSON.parse(r.stdout) as Partial<BuildInfo> }
  } catch {
    return { ok: false, why: "version --json printed no JSON" }
  }
}

/** The run's shared state, for messages. */
interface Ctx {
  readonly opts: UpdateOptions
  readonly deps: UpdateDeps
  readonly exe: string
  readonly kind: InstallKind
}

/** `--rollback`: put `<exe>.old` back. */
async function rollback(ctx: Ctx): Promise<UpdateOutcome> {
  const { deps, exe } = ctx
  const { old } = sidePaths(exe)
  if (!deps.fs.exists(old)) {
    throw new UpdateFailure(
      UPDATE_EXIT.notFound,
      `no previous binary at ${old}: nothing to roll back to`,
    )
  }
  const dir = dirname(exe)
  if (!deps.fs.canWrite(dir)) {
    throw new UpdateFailure(
      UPDATE_EXIT.notWritable,
      `${dir} is not writable. Roll back by hand:\n  sudo mv ${old} ${exe}`,
    )
  }
  const probe = await probeVersion(deps, old)
  if (!probe.ok) {
    throw new UpdateFailure(
      UPDATE_EXIT.error,
      `the previous binary ${old} does not run (${probe.why}); left everything in place`,
    )
  }
  // exe -> exe.prev (a second name for the current binary), old -> exe
  // (atomic), exe.prev -> old. A crash between the steps leaves a working
  // exe in every state.
  const prev = `${exe}.prev`
  deps.fs.rm(prev)
  deps.fs.linkOrCopy(exe, prev)
  deps.fs.rename(old, exe)
  deps.fs.rename(prev, old)
  const from = deps.build.version
  const to = probe.info.version ?? "?"
  return {
    code: UPDATE_EXIT.ok,
    text:
      `rolled back ${exe} to ${to} (${short(probe.info.cliSha)}).\n` +
      `the binary it replaced (${from}) is now ${old}; run update --rollback again to undo.`,
    json: {
      status: "rolled-back",
      kind: ctx.kind,
      path: exe,
      from: { version: from, cliSha: deps.build.cliSha },
      to: { version: to, cliSha: probe.info.cliSha ?? null },
    },
  }
}

function short(sha: unknown): string {
  return typeof sha === "string" && /^[0-9a-f]{8,}$/u.test(sha) ? sha.slice(0, 7) : String(sha)
}

/** Find the release for the options. Throws a not-found or auth failure. */
async function findRelease(ctx: Ctx, gh: GithubReleases): Promise<Release> {
  const { opts } = ctx
  let release: Release | undefined
  let what: string
  if (opts.to !== undefined) {
    const tag = tagOf(opts.to)
    what = `release ${tag}`
    release = await gh.byTag(tag)
    if (release?.draft) release = undefined
  } else if (opts.channel === "stable") {
    what = "stable release"
    release = await gh.latestStable()
  } else {
    what = "nightly release"
    release = newestNightly(await gh.list(3))
  }
  if (release !== undefined) return release
  // A 404 on a private repo is also what a token without access gets.
  if (!(await gh.repoVisible())) {
    throw new UpdateFailure(
      UPDATE_EXIT.auth,
      `the token cannot see ${gh.repo}. ${privateRepoHint(gh.repo)}`,
    )
  }
  throw new UpdateFailure(
    UPDATE_EXIT.notFound,
    `no ${what} found on ${gh.repo}${opts.to ? "" : " (none is published yet)"}`,
    { status: "no-release", channel: opts.channel, ...(opts.to ? { to: opts.to } : {}) },
  )
}

/** Download and parse a small JSON or text asset, or undefined when the release lacks it. */
async function smallAsset(
  gh: GithubReleases,
  release: Release,
  name: string,
): Promise<string | undefined> {
  const asset = assetNamed(release, name)
  if (asset === undefined) return undefined
  return new TextDecoder().decode(await gh.download(asset))
}

/** The manual install text for an unwritable dir. */
function manualCommand(exe: string, release: Release, assetName: string): string {
  const url =
    release.html_url ?? `https://github.com/${RELEASE_REPO}/releases/tag/${release.tag_name}`
  return [
    `${dirname(exe)} is not writable, so update cannot replace ${exe}.`,
    "Either re-run it with write access to that directory:",
    `  sudo -E ${exe} update${release.prerelease ? " --channel nightly" : ""}`,
    "or install by hand (the repo is private, so download with gh or a token):",
    `  gh release download ${release.tag_name} -R ${RELEASE_REPO} -p ${assetName} -p SHA256SUMS`,
    "  sha256sum -c SHA256SUMS --ignore-missing   (macOS: shasum -a 256 -c SHA256SUMS --ignore-missing)",
    `  tar -xzf ${assetName} minimal-agent && sudo install -m 0755 minimal-agent ${exe}`,
    `(release page: ${url})`,
  ].join("\n")
}

/** The macOS signing note for the installed target, or undefined. */
function signingNote(
  ctx: Ctx,
  row: NonNullable<ReleaseBuildInfo["targets"]>[number] | undefined,
): string | undefined {
  if (ctx.deps.host.platform !== "darwin") return undefined
  if (row?.signed === "developer-id") {
    return row.notarized
      ? "macOS: this build is Developer ID signed and notarized."
      : "macOS: this build is Developer ID signed but not notarized."
  }
  return (
    "macOS: this build is ad-hoc signed only (no Developer ID, not notarized: CI had no signing secrets). " +
    "update wrote it directly, so it carries no quarantine flag. If Gatekeeper still blocks it, run: " +
    `xattr -d com.apple.quarantine ${ctx.exe}`
  )
}

/** The install path: download, verify, smoke, swap. */
async function install(
  ctx: Ctx,
  gh: GithubReleases,
  release: Release,
  label: ReleaseLabel,
  sums: Map<string, string>,
  info: ReleaseBuildInfo | undefined,
  base: Record<string, unknown>,
): Promise<UpdateOutcome> {
  const { deps, exe } = ctx
  let picked: ReturnType<typeof pickAsset<ReleaseAsset>>
  try {
    picked = pickAsset(label.label, deps.host, release.assets)
  } catch (e) {
    if (e instanceof UnsupportedHostError) throw new UpdateFailure(UPDATE_EXIT.notFound, e.message)
    throw e
  }
  if (picked === undefined) {
    throw new UpdateFailure(
      UPDATE_EXIT.notFound,
      `${release.tag_name} has no build for this host (wanted ${candidateTargetIds(deps.host).join(" or ")})`,
      base,
    )
  }
  const { asset, id } = picked
  const expected = sums.get(asset.name)
  if (expected === undefined) {
    throw new UpdateFailure(UPDATE_EXIT.error, `SHA256SUMS has no line for ${asset.name}`, base)
  }
  const dir = dirname(exe)
  if (!deps.fs.canWrite(dir)) {
    throw new UpdateFailure(UPDATE_EXIT.notWritable, manualCommand(exe, release, asset.name), {
      ...base,
      status: "not-writable",
      asset: asset.name,
    })
  }

  progress(ctx, `downloading ${asset.name} (${Math.round(asset.size / 1e6)} MB)`)
  const tgz = await gh.download(asset)
  const got = sha256Hex(tgz)
  if (got !== expected) {
    throw new UpdateFailure(
      UPDATE_EXIT.error,
      `checksum mismatch for ${asset.name}: got ${got}, SHA256SUMS says ${expected}. Nothing was changed.`,
      { ...base, status: "checksum-mismatch", asset: asset.name },
    )
  }
  let binary: Uint8Array
  try {
    binary = extractFromTarGz(tgz, BINARY_MEMBER)
  } catch (e) {
    if (e instanceof ArchiveError) {
      throw new UpdateFailure(UPDATE_EXIT.error, `${asset.name}: ${e.message}`, base)
    }
    throw e
  }
  const row = info?.targets?.find((t) => t.id === id)
  if (row?.binarySha256 && sha256Hex(binary) !== row.binarySha256) {
    throw new UpdateFailure(
      UPDATE_EXIT.error,
      `the binary in ${asset.name} does not match build-info.json binarySha256. Nothing was changed.`,
      { ...base, status: "checksum-mismatch", asset: asset.name },
    )
  }

  const { next, old } = sidePaths(exe)
  deps.fs.rm(next)
  try {
    deps.fs.writeFile(next, binary, 0o755)
  } catch (e) {
    deps.fs.rm(next)
    throw new UpdateFailure(
      UPDATE_EXIT.notWritable,
      `cannot write ${next}: ${e instanceof Error ? e.message : String(e)}\n${manualCommand(exe, release, asset.name)}`,
      base,
    )
  }

  progress(ctx, `checking ${next}`)
  const probe = await probeVersion(deps, next)
  const wantVersion = coreVersion(label)
  const smokeError = !probe.ok
    ? `does not run (${probe.why})`
    : probe.info.version !== wantVersion
      ? `reports version ${String(probe.info.version)}, expected ${wantVersion}`
      : info?.sources?.cli?.sha && probe.info.cliSha && probe.info.cliSha !== info.sources.cli.sha
        ? `reports cli ${short(probe.info.cliSha)}, the release says ${short(info.sources.cli.sha)}`
        : undefined
  if (smokeError !== undefined) {
    deps.fs.rm(next)
    throw new UpdateFailure(
      UPDATE_EXIT.error,
      `the downloaded binary ${smokeError}. Removed it, ${exe} is unchanged.`,
      { ...base, status: "smoke-failed" },
    )
  }

  // Keep the current binary as <exe>.old, then rename the new one over it.
  // rename(2) is atomic, and a running process keeps its old inode.
  try {
    deps.fs.rm(old)
    deps.fs.linkOrCopy(exe, old)
    deps.fs.rename(next, exe)
  } catch (e) {
    deps.fs.rm(next)
    throw new UpdateFailure(
      UPDATE_EXIT.error,
      `could not replace ${exe}: ${e instanceof Error ? e.message : String(e)}`,
      base,
    )
  }

  const notes = [
    `the previous binary is kept at ${old} (minimal-agent update --rollback).`,
    "plugins are embedded in the binary: update does not touch ~/.minimal-agent/plugins.",
    ...(picked.fallback ? [`installed the ${id} build: the release has no better match.`] : []),
    ...(row?.smoked === false ? [`note: CI did not smoke-test the ${id} build.`] : []),
  ]
  const sign = signingNote(ctx, row)
  if (sign !== undefined) notes.push(sign)
  return {
    code: UPDATE_EXIT.ok,
    text: [
      `updated ${exe}: ${deps.build.version} (${short(deps.build.cliSha)}) -> ${label.label} (${id})`,
      ...notes,
    ].join("\n"),
    json: { ...base, status: "updated", asset: asset.name, target: id, path: exe, notes },
  }
}

function progress(ctx: Ctx, line: string): void {
  if (!ctx.opts.json) ctx.deps.progress(line)
}

/** The body of {@link runUpdate}. */
async function runInner(ctx: Ctx): Promise<UpdateOutcome> {
  const { opts, deps } = ctx
  if (ctx.kind !== "standalone") {
    return {
      code: UPDATE_EXIT.ok,
      text: installKindMessage(ctx.kind),
      json: { status: ctx.kind, kind: ctx.kind, message: installKindMessage(ctx.kind) },
    }
  }
  if (opts.rollback) return await rollback(ctx)

  const token = await deps.resolveToken(deps.env)
  if (!token) throw new UpdateFailure(UPDATE_EXIT.auth, noTokenMessage(), { status: "no-token" })
  const gh = new GithubReleases({
    token,
    fetch: deps.fetch,
    apiBase: deps.apiBase ?? deps.env.MINIMAL_AGENT_UPDATE_API,
  })

  const release = await findRelease(ctx, gh)
  const label = parseLabel(release.tag_name)
  if (label === undefined) {
    throw new UpdateFailure(UPDATE_EXIT.error, `release tag ${release.tag_name} is not v<x.y.z>`)
  }
  const sumsText = await smallAsset(gh, release, "SHA256SUMS")
  if (sumsText === undefined) {
    throw new UpdateFailure(UPDATE_EXIT.error, `${release.tag_name} has no SHA256SUMS asset`)
  }
  const sums = parseSha256Sums(sumsText)
  const infoText = await smallAsset(gh, release, "build-info.json")
  let info: ReleaseBuildInfo | undefined
  if (infoText !== undefined) {
    const infoSha = sums.get("build-info.json")
    if (infoSha !== undefined && sha256Hex(new TextEncoder().encode(infoText)) !== infoSha) {
      throw new UpdateFailure(UPDATE_EXIT.error, "build-info.json does not match SHA256SUMS")
    }
    try {
      info = JSON.parse(infoText) as ReleaseBuildInfo
    } catch {
      info = undefined
    }
  }

  const same = sameBuild(info, deps.build)
  const order = same ? 0 : compareVersions(releasePoint(release, label), currentPoint(deps.build))
  const status = order > 0 ? "available" : order === 0 ? "current" : "ahead"
  const base: Record<string, unknown> = {
    kind: ctx.kind,
    channel: opts.channel,
    current: {
      version: deps.build.version,
      cliSha: deps.build.cliSha,
      mode: deps.build.mode,
      builtAt: deps.build.builtAt,
    },
    latest: {
      tag: release.tag_name,
      label: label.label,
      prerelease: release.prerelease,
      published: release.published_at ?? null,
      url: release.html_url ?? null,
    },
  }
  const current = `${deps.build.version} (${short(deps.build.cliSha)}, ${deps.build.mode})`
  const pinned = opts.to !== undefined

  if (opts.check) {
    const line =
      status === "available"
        ? `update available: ${current} -> ${label.label}`
        : status === "current"
          ? `up to date: ${label.label}`
          : `this binary (${current}) is newer than the ${pinned ? "requested" : opts.channel} release ${label.label}`
    return {
      code: status === "available" ? UPDATE_EXIT.updateAvailable : UPDATE_EXIT.ok,
      text: line,
      json: { ...base, status },
    }
  }
  if (status === "current" && (!pinned || same)) {
    return { code: UPDATE_EXIT.ok, text: `up to date: ${label.label}`, json: { ...base, status } }
  }
  if (status === "ahead" && !pinned) {
    return {
      code: UPDATE_EXIT.ok,
      text:
        `this binary (${current}) is newer than the ${opts.channel} release ${label.label}: not downgrading.\n` +
        `to install it anyway: minimal-agent update --to ${release.tag_name}`,
      json: { ...base, status },
    }
  }
  return await install(ctx, gh, release, label, sums, info, base)
}

/**
 * Run `minimal-agent update` and return the outcome. Never throws for an
 * expected failure: the code and message say what went wrong.
 */
export async function runUpdate(opts: UpdateOptions, deps: UpdateDeps): Promise<UpdateOutcome> {
  const exe = deps.fs.realpath(deps.execPath)
  const kind = detectInstallKind({
    mode: deps.build.mode,
    standalone: deps.standalone,
    execPath: exe,
  })
  const ctx: Ctx = { opts, deps, exe, kind }
  try {
    return await runInner(ctx)
  } catch (e) {
    if (e instanceof UpdateFailure) {
      return {
        code: e.code,
        text: e.message,
        json: { status: "error", ...e.extra, error: e.message, code: e.code },
      }
    }
    if (e instanceof GithubError) {
      const code = e.kind === "auth" ? UPDATE_EXIT.auth : UPDATE_EXIT.error
      return { code, text: e.message, json: { status: "error", error: e.message, code } }
    }
    throw e
  }
}
