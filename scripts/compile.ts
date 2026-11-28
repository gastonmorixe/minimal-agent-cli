#!/usr/bin/env bun
/**
 * Build a standalone `minimal-agent` binary with `Bun.build({ compile })`.
 *
 *   bun run compile:dev       # core = ../minimal-agent-core working tree (WIP)
 *   bun run compile:release   # core = the commit pinned in package.json
 *   (from the monorepo root: bun run cli:compile:dev / cli:compile:release)
 *
 * Options (after `--mode dev|release`):
 *   --target TARGET         cross-compile: a release target id (linux-x64-musl) or its
 *                           Bun string (bun-linux-x64-musl). See scripts/release/targets.ts.
 *                           Default: this machine.
 *   --all                   build every release target (release builds only)
 *   --outfile PATH          output path, one target only. Default: dist/minimal-agent[-TARGET]
 *   --bytecode, --no-bytecode   default: off for dev (faster), on for release
 *   --no-smoke              skip the smoke and e2e runs of the built binary
 *
 * Where the plugins come from
 * ----------------------------
 * Every first-party plugin is embedded. `scripts/gen-embedded-plugins.ts`
 * writes a table of literal `import()` thunks plus text and file imports
 * (gitignored, under `tmp/`), and a build-time resolver maps the CLI's
 * `#embedded-plugins` import to it (from source that import is an empty
 * stub, see `package.json#imports`). `src/index.ts` registers the table
 * with core at startup.
 *
 *   - dev: `MA_PLUGINS_DIR`, else the `../minimal-agent-plugins` working tree.
 *   - release: `git archive` of the plugins checkout HEAD (or
 *     `MA_PLUGINS_SHA`) into `tmp/`, the same as core. A dirty plugins tree
 *     does not leak into a release. The sha is `pluginsSha` in the build info.
 *
 * A darwin target also embeds the computer-use helper: swiftc builds it from
 * the same plugins tree into `tmp/cu-helper/<target id>/`, and the table
 * adds it as the file `native/build/ComputerUseHelper` of
 * `ma-computer-use-plugin` (see `scripts/computer-use-helper.ts`). A release
 * fails when it cannot build the helper. A dev build prints a warning and
 * embeds no helper. `MA_COMPILE_NO_HELPER=1` skips the helper in a dev build
 * (a release ignores it). The build info gets `helperSelftest` (`passed` or
 * `skipped: <reason>`) when the binary embeds a helper.
 *
 * Where core comes from
 * ---------------------
 * The CLI imports `@minimal-agent/core/SUBPATH`. A build-time resolver
 * plugin maps each specifier through the `exports` map of the chosen core
 * tree, so the bundle never depends on what `node_modules/@minimal-agent/core`
 * points at (dev link or pinned install). Nothing is copied into
 * `node_modules` and `bun install` is never run.
 *
 *   - dev: the monorepo checkout `../minimal-agent-core`, uncommitted edits included.
 *   - release: `git archive` of the pinned commit (the sha in this package's
 *     `@minimal-agent/core` dependency) into `tmp/`. Core has no runtime
 *     dependencies, so the archive needs no install.
 *
 * The smoke run starts the binary from an empty dir in the OS temp dir (never
 * under this repo, whose `node_modules` would mask a resolution bug), with an
 * isolated home and a minimal env. It runs `--help` and `plugins`, and fails
 * the build on a non-zero exit or a `fatal:` / `Cannot find package` /
 * `ENOENT` line. `plugins` boots the host-core resolver, the part that has no
 * `node_modules` to lean on in a compiled binary. Then `scripts/compile-e2e.sh`
 * runs it the way a user does: copied out of the repo, a fresh HOME, a `-p`
 * prompt, and the interactive REPL in tmux.
 *
 * The binary is built to a staging file and moved to the output path only
 * after every check passes. A failed build never replaces a working binary.
 *
 * @module scripts/compile
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

import {
  buildComputerUseHelper,
  defaultToolchainGap,
  HELPER_KEY,
  HELPER_PACKAGE,
  HelperBuildError,
  type HelperResult,
  hasRosetta,
  helperInfo,
  helperLogLine,
  helperOutDir,
  NO_HELPER_ENV,
  noHelperRequested,
} from "./computer-use-helper.ts"
import { type ExtraFiles, writeEmbeddedPluginsModule } from "./gen-embedded-plugins.ts"
import { findReleaseTarget, RELEASE_TARGET_IDS, RELEASE_TARGETS } from "./release/targets.ts"

const CLI_DIR = resolve(import.meta.dir, "..")
const CORE_CHECKOUT = resolve(CLI_DIR, "..", "minimal-agent-core")
const ENTRY = join(CLI_DIR, "src", "index.ts")
const DIST = join(CLI_DIR, "dist")
const NAME = "minimal-agent"
const CORE = "@minimal-agent/core"
const PIN_RE = /minimal-agent-core\.git#([0-9a-f]{7,40})/
/**
 * Crash text in the smoke output. `fatal:` is the CLI's own error line; the
 * rest match compile-e2e.sh's CRASH_RE (a missed import, a missing embedded
 * file, a Bun stack frame inside the bundle, a Bun panic).
 */
const SMOKE_FAIL_RE = /fatal:|Cannot find package|ENOENT|at .*\(\/\$bunfs\/|panic/
/** Time limit for one smoke command and for the whole e2e script. */
const SMOKE_TIMEOUT_MS = 30_000
const E2E_TIMEOUT_MS = 300_000

/**
 * Bun compile target strings for `--all`: every macOS and Linux target in
 * `scripts/release/targets.ts` (glibc, musl, x64-baseline). No Windows.
 */
const TARGETS: readonly string[] = RELEASE_TARGETS.map((t) => t.bun)

type Mode = "dev" | "release"

interface Options {
  mode: Mode
  target?: string
  outfile?: string
  bytecode: boolean
  all: boolean
  smoke: boolean
}

/** A build failure with a message for the user. The main block prints it and exits 1. */
class CompileError extends Error {}

/** Throw (not exit), so `finally` still removes the release archive and smoke dirs. */
function fail(msg: string): never {
  throw new CompileError(msg)
}

/** A smoke or e2e failure: the binary itself was built but does not run. */
class SmokeError extends CompileError {}

/** Paths to delete on exit, including Ctrl-C and SIGTERM (see `cleanupNow`). */
const cleanupPaths = new Set<string>()

/** Delete every registered path. Safe to call more than once. */
function cleanupNow(): void {
  for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true })
  cleanupPaths.clear()
}

// `finally` blocks do not run when a signal ends the process, so a Ctrl-C
// during a build would leave the staging binary, the release archive, and
// the smoke dir behind. The handlers clean up and exit with the usual code.
// Every long step (build, smoke, e2e) awaits instead of blocking, so a
// signal is handled at once and the binary is never published after it.
const children = new Set<Bun.Subprocess>()
function onSignal(code: number): void {
  for (const child of children) child.kill("SIGTERM")
  cleanupNow()
  process.exit(code)
}
process.on("SIGINT", () => onSignal(130))
process.on("SIGTERM", () => onSignal(143))

/**
 * Run a command to completion without blocking the event loop. Kills it
 * with SIGKILL after `timeoutMs`. `exitCode` is null on a timeout.
 */
async function runChild(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; capture: boolean; timeoutMs: number },
): Promise<{ exitCode: number | null; out: string }> {
  const child = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: opts.capture ? "pipe" : "inherit",
    stderr: opts.capture ? "pipe" : "inherit",
  })
  children.add(child)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, opts.timeoutMs)
  try {
    const [out, err] = opts.capture
      ? await Promise.all([
          new Response(child.stdout as ReadableStream).text(),
          new Response(child.stderr as ReadableStream).text(),
        ])
      : ["", ""]
    const code = await child.exited
    return { exitCode: timedOut ? null : code, out: `${out}\n${err}` }
  } finally {
    clearTimeout(timer)
    children.delete(child)
  }
}

/** The host's own compile target (smoke and e2e run only for it). */
const HOST_TARGET = `bun-${process.platform}-${process.arch}`

/**
 * Map `--target` to its Bun compile target string. It accepts a release
 * target id (`linux-x64-musl`) or a Bun string (`bun-linux-x64-musl`) from
 * `scripts/release/targets.ts`, and fails on anything else (Windows, typos).
 */
function resolveTarget(spec: string): string {
  const found = findReleaseTarget(spec)
  if (found === undefined) {
    fail(`--target ${spec} is not a release target. One of: ${RELEASE_TARGET_IDS.join(", ")}`)
  }
  return found.bun
}

function parseArgs(argv: string[]): Options {
  let mode: string | undefined
  let target: string | undefined
  let outfile: string | undefined
  let bytecode: boolean | undefined
  let all = false
  let smoke = true
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined || v.startsWith("--")) fail(`${arg} needs a value`)
      return v
    }
    if (arg === "--mode") mode = value()
    else if (arg === "--target") target = value()
    else if (arg === "--outfile") outfile = value()
    else if (arg === "--bytecode") bytecode = true
    else if (arg === "--no-bytecode") bytecode = false
    else if (arg === "--all") all = true
    else if (arg === "--no-smoke") smoke = false
    else fail(`unknown argument: ${arg}`)
  }
  if (mode !== "dev" && mode !== "release") fail("--mode dev|release is required")
  if (all && (target || outfile)) fail("--all cannot be combined with --target or --outfile")
  if (target !== undefined) target = resolveTarget(target)
  // The host's own target is a native build: smoke-test it.
  if (target === HOST_TARGET) target = undefined
  return { mode, target, outfile, bytecode: bytecode ?? mode === "release", all, smoke }
}

function git(args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", "-C", CORE_CHECKOUT, ...args], { stdout: "pipe", stderr: "pipe" })
  return { ok: r.exitCode === 0, out: `${r.stdout.toString()}${r.stderr.toString()}`.trim() }
}

/** The core sha pinned in this package's `@minimal-agent/core` dependency. */
function pinnedCoreSha(): string {
  const pkg = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>
  }
  const spec = pkg.dependencies?.[CORE] ?? fail(`package.json has no ${CORE} dependency`)
  return spec.match(PIN_RE)?.[1] ?? fail(`cannot read a core sha from "${spec}"`)
}

/** Extract the pinned core commit into a fresh dir under `tmp/`. */
function archivePinnedCore(sha: string): string {
  if (!existsSync(CORE_CHECKOUT)) fail(`core checkout not found at ${CORE_CHECKOUT}`)
  if (!git(["cat-file", "-e", `${sha}^{commit}`]).ok) {
    fail(`core commit ${sha} is not in ${CORE_CHECKOUT}. Run: git -C ${CORE_CHECKOUT} fetch`)
  }
  mkdirSync(join(CLI_DIR, "tmp"), { recursive: true })
  const dir = mkdtempSync(join(CLI_DIR, "tmp", `core-${sha.slice(0, 7)}-`))
  cleanupPaths.add(dir)
  const archive = Bun.spawnSync(["git", "-C", CORE_CHECKOUT, "archive", "--format=tar", sha], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (archive.exitCode !== 0) fail(`git archive ${sha} failed: ${archive.stderr.toString()}`)
  const untar = Bun.spawnSync(["tar", "-x", "-C", dir], { stdin: archive.stdout, stderr: "pipe" })
  if (untar.exitCode !== 0) fail(`tar -x failed: ${untar.stderr.toString()}`)
  return dir
}

/**
 * Extract commit `sha` of the plugins checkout into a fresh dir under
 * `tmp/`. A release embeds the plugins from this archive, never from the
 * working tree.
 */
function archivePlugins(sha: string): string {
  if (!existsSync(PLUGINS_CHECKOUT)) fail(`plugins checkout not found at ${PLUGINS_CHECKOUT}`)
  if (gitIn(PLUGINS_CHECKOUT, ["cat-file", "-e", `${sha}^{commit}`]) === undefined) {
    fail(
      `plugins commit ${sha} is not in ${PLUGINS_CHECKOUT}. Run: git -C ${PLUGINS_CHECKOUT} fetch`,
    )
  }
  mkdirSync(join(CLI_DIR, "tmp"), { recursive: true })
  const dir = mkdtempSync(join(CLI_DIR, "tmp", `plugins-${sha.slice(0, 7)}-`))
  cleanupPaths.add(dir)
  const archive = Bun.spawnSync(["git", "-C", PLUGINS_CHECKOUT, "archive", "--format=tar", sha], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (archive.exitCode !== 0)
    fail(`git archive ${sha} (plugins) failed: ${archive.stderr.toString()}`)
  const untar = Bun.spawnSync(["tar", "-x", "-C", dir], { stdin: archive.stdout, stderr: "pipe" })
  if (untar.exitCode !== 0) fail(`tar -x failed: ${untar.stderr.toString()}`)
  return dir
}

/** Read the `exports` map of the core tree at `coreDir`. Every target must be a string. */
function readCoreExports(coreDir: string): Map<string, string> {
  const pkgPath = join(coreDir, "package.json")
  if (!existsSync(pkgPath)) fail(`no core checkout at ${coreDir} (missing package.json)`)
  let pkg: { name?: string; exports?: Record<string, unknown> }
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as typeof pkg
  } catch (e) {
    fail(`cannot read ${pkgPath}: ${(e as Error).message}`)
  }
  if (pkg.name !== CORE) fail(`${coreDir} is "${pkg.name ?? "unnamed"}", not ${CORE}`)
  const map = new Map<string, string>()
  for (const [key, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target !== "string" || key.includes("*")) {
      fail(`unsupported exports entry ${key}: only exact keys with string targets are mapped`)
    }
    map.set(key, join(coreDir, target))
  }
  return map
}

/**
 * Build-time resolver for the CLI's `#embedded-plugins` import: the
 * generated table at `tableFile`, in place of the empty stub that
 * `package.json#imports` names for source runs.
 */
function embeddedPluginsPlugin(tableFile: string): Bun.BunPlugin {
  return {
    name: "minimal-agent-embedded-plugins",
    setup(build) {
      build.onResolve({ filter: /^#embedded-plugins$/ }, () => ({ path: tableFile }))
    },
  }
}

/**
 * Build-time resolver: maps `@minimal-agent/core[/<sub>]` to the file its
 * `exports` key names in the chosen core tree. Covers the CLI's imports and core's own
 * self-references (core imports plugin-api by package name). An unexported
 * subpath fails the build, the same as Node/Bun package resolution.
 */
function corePlugin(exportsMap: Map<string, string>): Bun.BunPlugin {
  return {
    name: "minimal-agent-core-source",
    setup(build) {
      build.onResolve({ filter: /^@minimal-agent\/core(\/.*)?$/ }, (args) => {
        const key = `.${args.path.slice(CORE.length)}`
        const path = exportsMap.get(key)
        if (path === undefined) {
          throw new Error(`${args.path} (from ${args.importer}) is not in core's exports map`)
        }
        return { path }
      })
    },
  }
}

/**
 * Bun 1.4.4 leaves one `.<hash>-00000000.bun-build` temp file (a full copy
 * of the runtime, ~90 MB) in the cwd after each compile, from both
 * `Bun.build` and `bun build --compile`. The build removes the ones it made.
 */
function bunBuildLeftovers(): string[] {
  return readdirSync(process.cwd()).filter((name) => /^\..*\.bun-build$/.test(name))
}

/**
 * Build one target and publish it at its output path.
 *
 * The binary is built to a staging file next to the output, smoke-tested
 * there (native builds), and renamed over the output only when it passes.
 * A failed build or smoke run never replaces a working binary at the
 * output path; the staging file is removed.
 *
 * @returns The output path.
 */
async function compileOne(opts: Options, coreExports: Map<string, string>, target?: string) {
  const suffix = target ? `-${target.replace(/^bun-/, "")}` : ""
  const outfile = resolve(opts.outfile ?? join(DIST, `${NAME}${suffix}`))
  if (existsSync(outfile) && statSync(outfile).isDirectory()) {
    fail(`--outfile ${outfile} is a directory; pass a file path`)
  }
  const staging = join(dirname(outfile), `.${basename(outfile)}.staging-${process.pid}`)
  mkdirSync(dirname(outfile), { recursive: true })
  cleanupPaths.add(staging)
  // The external sourcemap Bun writes next to the staging binary.
  const stagingMap = `${staging}.map`
  cleanupPaths.add(stagingMap)
  console.log(
    `compile: ${opts.mode} ${target ?? "native"}${opts.bytecode ? " +bytecode" : ""} -> ${outfile}`,
  )
  try {
    await buildTo(staging, opts, coreExports, target)
    if (opts.smoke && !target) {
      await smoke(staging)
      await e2e(staging)
    } else if (opts.smoke) {
      console.log("compile: smoke skipped for a cross-compiled target")
    }
    renameSync(staging, outfile)
    if (existsSync(stagingMap)) renameSync(stagingMap, `${outfile}.map`)
  } finally {
    rmSync(staging, { force: true })
    rmSync(stagingMap, { force: true })
    cleanupPaths.delete(staging)
    cleanupPaths.delete(stagingMap)
  }
  console.log(`compile: wrote ${outfile}`)
  if (existsSync(`${outfile}.map`)) console.log(`compile: sourcemap ${outfile}.map`)
  return outfile
}

/** Run `Bun.build` into `outfile`. Throws a {@link CompileError} on a failed build. */
async function buildTo(
  outfile: string,
  opts: Options,
  coreExports: Map<string, string>,
  target: string | undefined,
): Promise<void> {
  const info = buildInfo(opts, target)
  const table = await generateTable(info, opts.mode, target)
  const before = new Set(bunBuildLeftovers())
  let result: Bun.BuildOutput
  try {
    result = await build(outfile, opts, coreExports, target, info, table)
  } finally {
    for (const name of bunBuildLeftovers()) {
      if (!before.has(name)) rmSync(join(process.cwd(), name), { force: true })
    }
  }
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    fail(`build failed (${opts.mode} ${target ?? "native"})`)
  }
}

/**
 * The plugins checkout whose commit the build info names, and the source of
 * a release archive. `MA_PLUGINS_DIR` overrides it.
 */
const PLUGINS_CHECKOUT = resolve(
  process.env.MA_PLUGINS_DIR || resolve(CLI_DIR, "..", "minimal-agent-plugins"),
)

/** Where the generated table is written (gitignored `tmp/`). */
const TABLE_FILE = join(CLI_DIR, "tmp", "embedded-plugins.gen.ts")

/** The root of the computer-use helper builds (gitignored `tmp/`). */
const HELPER_OUT_ROOT = join(CLI_DIR, "tmp", "cu-helper")

/**
 * Build the computer-use helper for a darwin target and name it as an extra
 * plugin file. No files for a non-darwin target, for a dev build with
 * `MA_COMPILE_NO_HELPER=1`, and for a dev build that cannot build it (with a
 * warning). A release that cannot build it fails. `result` gives the
 * selftest status to the build info.
 */
async function computerUseHelperFiles(
  mode: Mode,
  dir: string,
  target: string,
): Promise<{ extraFiles: ExtraFiles | undefined; result: HelperResult }> {
  const noHelper = noHelperRequested(process.env)
  const outDir = helperOutDir(HELPER_OUT_ROOT, target)
  // Register the output dir before the build: a failed swiftc, codesign or
  // selftest, or a Ctrl-C during swiftc, then leaves no `tmp/cu-helper/<id>/`.
  if (outDir !== undefined && !(noHelper && mode === "dev")) cleanupPaths.add(outDir)
  if (noHelper && mode === "release" && outDir !== undefined) {
    console.log(
      `compile: ${NO_HELPER_ENV}=1 is ignored in release mode: a release embeds the helper`,
    )
  }
  let r: HelperResult
  try {
    r = await buildComputerUseHelper(
      { target, mode, pluginsDir: dir, outRoot: HELPER_OUT_ROOT, noHelper },
      {
        run: (cmd, timeoutMs) => runChild(cmd, { capture: true, timeoutMs }),
        toolchainGap: defaultToolchainGap,
        host: { platform: process.platform, arch: process.arch },
        rosetta: hasRosetta,
      },
    )
  } catch (e) {
    if (e instanceof HelperBuildError) fail(e.message)
    throw e
  }
  const id = target.replace(/^bun-/, "")
  if (r.kind === "not-darwin") {
    console.log(`compile: computer-use helper: none for ${id}`)
    return { extraFiles: undefined, result: r }
  }
  if (r.kind === "skipped") {
    console.log(`compile: computer-use helper: skipped for ${id} (${r.reason}, dev mode)`)
    return { extraFiles: undefined, result: r }
  }
  if (r.kind === "missing") {
    console.warn(`compile: warning: no computer-use helper for ${id}: ${r.reason}`)
    return { extraFiles: undefined, result: r }
  }
  console.log(`compile: ${helperLogLine(r)}`)
  return { extraFiles: { [HELPER_PACKAGE]: { [HELPER_KEY]: r.path } }, result: r }
}

/**
 * Write the embedded plugin table for this build. Dev: the plugins working
 * tree. Release: the archive at {@link pluginsSha}. The table's `buildId`
 * names the three trees, so a new build never reuses old extracted files.
 * A darwin target also gets the computer-use helper as an extra file, and
 * `info` gets its selftest status (`helperSelftest`, see {@link helperInfo}).
 */
async function generateTable(
  info: Record<string, unknown>,
  mode: Mode,
  target: string | undefined,
): Promise<string> {
  const dir = pluginsDir ?? PLUGINS_CHECKOUT
  const helper = await computerUseHelperFiles(mode, dir, target ?? HOST_TARGET)
  const extraFiles = helper.extraFiles
  Object.assign(info, helperInfo(helper.result))
  const short = (v: unknown): string => String(v).slice(0, 12)
  const buildId =
    `${short(info.cliSha)}-${short(info.coreSha)}-${short(info.pluginsSha)}` +
    (info.dirty
      ? `-dirty${contentHash(pluginsDir === undefined ? [CLI_DIR, dir] : [CLI_DIR])}`
      : "")
  const r = writeEmbeddedPluginsModule(dir, TABLE_FILE, buildId, { extraFiles })
  cleanupPaths.add(TABLE_FILE)
  console.log(
    `compile: embedded plugins ${r.packages} packages, ${r.modules} modules, ${r.texts} texts, ` +
      `${r.files} files, scripts ${r.scripts.join(" ")} (build ${buildId})`,
  )
  return TABLE_FILE
}

/**
 * A short hash of the uncommitted state of the git trees in `dirs`
 * (`git status` plus `git diff HEAD`). A dirty build puts it in the build
 * id, so an edited plugin file gets a fresh extract dir.
 */
function contentHash(dirs: readonly string[]): string {
  const h = new Bun.CryptoHasher("sha256")
  for (const dir of dirs) {
    h.update(gitIn(dir, ["status", "--porcelain"]) ?? "")
    h.update(gitIn(dir, ["diff", "HEAD"]) ?? "")
  }
  return h.digest("hex").slice(0, 8)
}

/** `git -C <dir> <args>`, trimmed stdout, or undefined when git fails. */
function gitIn(dir: string, args: string[]): string | undefined {
  if (!existsSync(dir)) return undefined
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" })
  return r.exitCode === 0 ? r.stdout.toString().trim() : undefined
}

/** The HEAD sha of the git tree at `dir`, or `dev` when it is not a git tree. */
function headSha(dir: string): string {
  return gitIn(dir, ["rev-parse", "HEAD"]) || "dev"
}

/**
 * Tracked files with uncommitted changes in the git tree at `dir` (porcelain
 * lines, untracked files ignored). Empty when clean or not a git tree.
 */
function dirtyTracked(dir: string): string[] {
  const out = gitIn(dir, ["status", "--porcelain", "--untracked-files=no"]) ?? ""
  // `gitIn` trims the output, which eats the first line's leading status
  // column: trim every line so the list prints aligned.
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
}

/**
 * The build identity baked into the binary as `MA_BUILD_INFO` (read by
 * `src/cli/build-info.ts`). SHAs come from git at build time, never at run
 * time. `coreSha` is the pinned commit in release mode, else the core
 * checkout HEAD. `dirty` is true when any of the three trees has tracked
 * changes (a release build has already failed on a dirty CLI tree).
 * `SOURCE_DATE_EPOCH` (seconds) fixes `builtAt` for a reproducible build.
 */
function buildInfo(opts: Options, target: string | undefined): Record<string, unknown> {
  const pkg = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")) as {
    version?: string
  }
  const epoch = Number(process.env.SOURCE_DATE_EPOCH)
  const builtAt = Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date()
  const coreSha = pinnedSha ?? headSha(CORE_CHECKOUT)
  // A release embeds the plugins archive at `pluginsSha`, so a dirty plugins
  // working tree does not make it dirty.
  const dirty =
    dirtyTracked(CLI_DIR).length > 0 ||
    (pinnedSha === undefined && dirtyTracked(CORE_CHECKOUT).length > 0) ||
    (pluginsSha === undefined && dirtyTracked(PLUGINS_CHECKOUT).length > 0)
  return {
    version: pkg.version ?? "0.0.0",
    cliSha: headSha(CLI_DIR),
    coreSha,
    pluginsSha: pluginsSha ?? headSha(PLUGINS_CHECKOUT),
    dirty,
    bunVersion: Bun.version,
    target: (target ?? HOST_TARGET).replace(/^bun-/, ""),
    mode: opts.mode,
    builtAt: builtAt.toISOString(),
  }
}

function build(
  outfile: string,
  opts: Options,
  coreExports: Map<string, string>,
  target: string | undefined,
  info: Record<string, unknown>,
  tableFile: string,
): Promise<Bun.BuildOutput> {
  console.log(
    `compile: build info cli ${String(info.cliSha).slice(0, 7)} core ${String(info.coreSha).slice(0, 7)} ` +
      `plugins ${String(info.pluginsSha).slice(0, 7)}${info.dirty ? " (dirty)" : ""}`,
  )
  return Bun.build({
    entrypoints: [ENTRY],
    // `src/cli/build-info.ts` reads this. A run from source has no define.
    define: { MA_BUILD_INFO: JSON.stringify(info) },
    compile: {
      outfile,
      // A compiled binary skips `package.json` files on disk by default, so
      // a plugin's own package import (a workspace kit with an `exports`
      // map, e.g. ma-prompts-plugin -> ma-autocomplete-kit) fails with
      // "Cannot find package". This turns that lookup back on.
      autoloadPackageJson: true,
      // Bun's defaults for a compiled binary read `bunfig.toml` and `.env`
      // from the cwd at startup. The agent runs inside any project, so a
      // `bunfig.toml` `preload` there would run that project's code inside
      // the agent, and its `.env` would land in the agent's env. Both off.
      // compile-e2e.sh checks this with a hostile project dir.
      autoloadBunfig: false,
      autoloadDotenv: false,
      // `target` is a Bun compile target string (see TARGETS). The cast keeps
      // this file independent of the bun-types version's target union.
      ...(target ? { target: target as Bun.Build.CompileTarget } : {}),
    },
    format: "esm",
    bytecode: opts.bytecode,
    minify: false,
    // `<outfile>.map` next to the binary, not inside it: a debug artifact
    // for crash stacks (`/$bunfs/root/minimal-agent:<line>`), not shipped.
    sourcemap: "external",
    throw: false,
    plugins: [embeddedPluginsPlugin(tableFile), corePlugin(coreExports)],
  })
}

/** True when `dir` or one of its parents holds a `node_modules` dir. */
function hasNodeModulesAbove(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, "node_modules"))) return true
    if (dirname(d) === d) return false
  }
}

/**
 * A provider plugin for the smoke home. Provider discovery imports it from
 * disk during `plugins`. It imports core by package name, with `import` and
 * with `require()`, and throws unless both get the binary's own bundled copy.
 * It exports no valid provider, so discovery then skips it.
 */
const SMOKE_PLUGIN_FILES: Record<string, string> = {
  "provider.json": JSON.stringify({ id: "smoke", entry: "./index.ts", export: "smoke" }),
  "index.ts": [
    'import { ProviderError } from "@minimal-agent/core/plugin-api/llm/errors"',
    'const viaRequire = require("@minimal-agent/core/plugin-api/llm/errors")',
    "if (viaRequire.ProviderError !== ProviderError) {",
    '  throw new Error("smoke plugin: core import and require() differ")',
    "}",
    "export const smoke = {}",
    "",
  ].join("\n"),
}

/**
 * Run the binary from an empty dir with an isolated home and a minimal env.
 *
 * The dir is in the OS temp dir, never in this repo: a compiled binary that
 * misses a bare import falls back to resolving it from the cwd, so a cwd
 * under `minimal-agent-cli/` would find `node_modules/@minimal-agent/core`
 * and hide the very bug this run is for. The home holds one plugin (see
 * {@link SMOKE_PLUGIN_FILES}), so `plugins` also proves that a plugin on disk
 * can import core.
 */
async function smoke(binary: string): Promise<void> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "minimal-agent-smoke-")))
  cleanupPaths.add(scratch)
  if (hasNodeModulesAbove(scratch)) {
    fail(`smoke dir ${scratch} has a node_modules above it; set TMPDIR to a clean dir`)
  }
  const home = join(scratch, "home")
  const cwd = join(scratch, "cwd")
  const pluginDir = join(home, ".minimal-agent", "plugins", "llm-smoke")
  mkdirSync(pluginDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  for (const [name, text] of Object.entries(SMOKE_PLUGIN_FILES)) {
    writeFileSync(join(pluginDir, name), text)
  }
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    MINIMAL_AGENT_HOME: join(home, ".minimal-agent"),
    MINIMAL_AGENT_NO_PLUGIN_SYNC: "1",
    MINIMAL_AGENT_NO_BINARY_SETUP: "1",
    TERM: "dumb",
    NO_COLOR: "1",
  }
  try {
    for (const args of [["--help"], ["plugins"]]) {
      const label = `smoke \`${args.join(" ")}\``
      const r = await runChild([binary, ...args], {
        cwd,
        env,
        capture: true,
        timeoutMs: SMOKE_TIMEOUT_MS,
      })
      const out = r.out
      if (r.exitCode === null) {
        console.error(out.trim().split("\n").slice(-20).join("\n"))
        throw new SmokeError(`${label} did not exit within ${SMOKE_TIMEOUT_MS / 1000}s`)
      }
      const bad = out.split("\n").find((line) => SMOKE_FAIL_RE.test(line))
      if (r.exitCode !== 0 || bad !== undefined) {
        console.error(out.trim().split("\n").slice(-20).join("\n"))
        throw new SmokeError(`${label} failed (exit ${r.exitCode})${bad ? `: ${bad.trim()}` : ""}`)
      }
      console.log(`compile: ${label} ok`)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    cleanupPaths.delete(scratch)
  }
}

/**
 * Run `scripts/compile-e2e.sh` on the built binary: the user's view (copied
 * out of the repo, a fresh HOME, a hostile project dir, `-p`, and the REPL
 * in tmux). The script limits each command itself; this outer limit only
 * covers a stuck script.
 */
async function e2e(binary: string): Promise<void> {
  const r = await runChild(["bash", join(CLI_DIR, "scripts", "compile-e2e.sh"), binary], {
    capture: false,
    timeoutMs: E2E_TIMEOUT_MS,
  })
  if (r.exitCode === null) {
    throw new SmokeError(
      `e2e (scripts/compile-e2e.sh) did not finish within ${E2E_TIMEOUT_MS / 1000}s`,
    )
  }
  if (r.exitCode === 2) fail("e2e (scripts/compile-e2e.sh) could not run: see its message above")
  if (r.exitCode !== 0)
    throw new SmokeError(`e2e (scripts/compile-e2e.sh) failed (exit ${r.exitCode})`)
}

let pinnedSha: string | undefined
/** Release mode: the plugins commit embedded, and its archive dir. */
let pluginsSha: string | undefined
let pluginsDir: string | undefined
try {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.all && opts.mode !== "release") fail("--all is for release builds")
  let coreDir = CORE_CHECKOUT
  if (opts.mode === "release") {
    // A release bundles the CLI working tree and names its HEAD sha, so any
    // tracked change (src, package.json version, ...)
    // would ship under a sha that does not contain it. Fail, do not warn.
    // MA_COMPILE_ALLOW_DIRTY=1 builds anyway and marks the build dirty.
    const dirty = dirtyTracked(CLI_DIR)
    if (dirty.length > 0) {
      const list = dirty.slice(0, 10).join("\n  ")
      if (process.env.MA_COMPILE_ALLOW_DIRTY === "1") {
        console.warn(
          `compile: warning: release from a dirty CLI tree (MA_COMPILE_ALLOW_DIRTY=1):\n  ${list}`,
        )
      } else {
        fail(
          `release mode needs a clean minimal-agent-cli tree; ${dirty.length} tracked file(s) changed:\n  ${list}\n` +
            "Commit or stash them (or set MA_COMPILE_ALLOW_DIRTY=1 for a local test build).",
        )
      }
    }
    const sha = pinnedCoreSha()
    pinnedSha = sha
    coreDir = archivePinnedCore(sha)
    console.log(`compile: core pinned at ${sha}`)
    const psha =
      process.env.MA_PLUGINS_SHA?.trim() ||
      gitIn(PLUGINS_CHECKOUT, ["rev-parse", "HEAD"]) ||
      fail(`cannot read the plugins HEAD in ${PLUGINS_CHECKOUT} (a release needs a git checkout)`)
    const full = gitIn(PLUGINS_CHECKOUT, ["rev-parse", `${psha}^{commit}`]) ?? psha
    pluginsDir = archivePlugins(full)
    pluginsSha = full
    const dirtyPlugins = dirtyTracked(PLUGINS_CHECKOUT)
    console.log(
      `compile: plugins archived at ${full}` +
        (dirtyPlugins.length > 0
          ? ` (${dirtyPlugins.length} uncommitted change(s) in the checkout are NOT embedded)`
          : ""),
    )
  } else {
    console.log(`compile: core from working tree ${coreDir}`)
    console.log(`compile: plugins from working tree ${PLUGINS_CHECKOUT}`)
  }
  const coreExports = readCoreExports(coreDir)

  if (opts.all) {
    for (const target of TARGETS) await compileOne(opts, coreExports, target)
  } else {
    await compileOne(opts, coreExports, opts.target)
  }
} catch (e) {
  if (!(e instanceof CompileError)) throw e
  console.error(`compile: ${e.message}`)
  console.error("compile: no binary written; the previous file at the output path is unchanged.")
  if (pinnedSha && e instanceof SmokeError) {
    console.error(
      `compile: the binary built from the pinned core ${pinnedSha.slice(0, 7)} does not run. ` +
        `If that commit predates a compiled-binary fix in core, commit the fix, point the ${CORE} ` +
        "dependency in minimal-agent-cli/package.json at it, and retry. " +
        "`bun run cli:compile:dev` builds with the working-tree core.",
    )
  }
  process.exitCode = 1
} finally {
  cleanupNow()
}
