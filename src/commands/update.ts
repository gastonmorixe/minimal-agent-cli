/**
 * The `update` command (`minimal-agent update`), plan phase 7.
 *
 * Argv side only: parse the flags, wire the real seams, print the outcome.
 * The engine is `src/update/run.ts`. Dispatched from `src/main.ts` right
 * after `prepareEntrypointArgs`, before any config load, provider boot,
 * plugin load, or session start, so it works on a host with no
 * credentials and no plugins.
 *
 * TODO(plan phase 7, passive update check): not built yet. Design:
 * - At most once per 24h, interactive REPL boots only (never `-p`, ACP,
 *   `--host-mode`, or any non-TTY run, matching the plugin sync policy in
 *   `src/main.ts`), and only for a standalone binary
 *   (`detectInstallKind(...) === "standalone"`).
 * - Off with `MINIMAL_AGENT_NO_UPDATE_CHECK=1` (and config `updateCheck: false`).
 * - Only when a token resolves from env without the `gh` subprocess
 *   (`resolveGithubToken(env, false)`): a boot must never spawn `gh`.
 * - Run in the background after the first prompt renders, with a 5 s
 *   timeout, via the same `GithubReleases` client and channel rules as
 *   `update --check`. Cache `{checkedAt, channel, latestTag, etag}` in
 *   `~/.minimal-agent/update-check.json` and send `If-None-Match`.
 * - Show one dim startup row on the NEXT boot: "update available 0.2.1
 *   (minimal-agent update)". Never block, never print an error: a failed
 *   check just retries after 24h.
 *
 * @module commands/update
 */

import { resolveGithubToken } from "@minimal-agent/core/host-kit/auto-plugins"
import { isStandaloneExecutable } from "@minimal-agent/core/plugin-api/utils/self-spawn"

import { type BuildInfo, buildInfo } from "../cli/build-info.ts"
import { builtinRegistry } from "../cli/registry/index.ts"
import { resolveHelpRequest } from "../cli/registry/resolve.ts"
import { wantsJsonHelp } from "../ui/help/json.ts"
import { realExec, realFs } from "../update/io.ts"
import {
  type Channel,
  runUpdate,
  UPDATE_EXIT,
  type UpdateDeps,
  type UpdateOptions,
} from "../update/run.ts"
import { detectHost } from "../update/target.ts"

/**
 * True when raw argv runs `update`: `update` is the first token and the argv
 * is not a help request (`update --help` stays with the help path).
 */
export function isUpdateRequest(raw: readonly string[]): boolean {
  return raw[0] === "update" && resolveHelpRequest(raw, builtinRegistry()) === undefined
}

/** A bad `update` argument. */
export class UpdateArgError extends Error {}

/**
 * Parse the argv after `update`. Accepts `--flag value` and `--flag=value`.
 * `--json` and `--output-format json` select JSON output. Global display
 * flags (`--no-color`, `--debug`, `--verbose`) are ignored.
 *
 * @throws UpdateArgError on an unknown argument, a missing value, a bad
 *   channel, or a conflicting combination
 */
export function parseUpdateArgs(raw: readonly string[]): UpdateOptions {
  const args = raw[0] === "update" ? raw.slice(1) : [...raw]
  let check = false
  let rollback = false
  let channel: Channel | undefined
  let to: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""
    const eq = arg.indexOf("=")
    const name = arg.startsWith("--") && eq !== -1 ? arg.slice(0, eq) : arg
    const inline = arg.startsWith("--") && eq !== -1 ? arg.slice(eq + 1) : undefined
    const value = (): string => {
      if (inline !== undefined) return inline
      const v = args[++i]
      if (v === undefined || v.startsWith("--")) throw new UpdateArgError(`${name} needs a value`)
      return v
    }
    switch (name) {
      case "--check":
        check = true
        break
      case "--rollback":
        rollback = true
        break
      case "--channel": {
        const v = value()
        if (v !== "stable" && v !== "nightly") {
          throw new UpdateArgError(`--channel ${v}: use stable or nightly`)
        }
        channel = v
        break
      }
      case "--to":
        to = value().trim()
        if (to === "") throw new UpdateArgError("--to needs a version or tag")
        break
      case "--json":
      case "--no-color":
      case "--debug":
      case "--verbose":
        break
      case "--output-format":
        value()
        break
      default:
        throw new UpdateArgError(`unknown argument for update: ${arg}`)
    }
  }
  if (rollback && (check || to !== undefined || channel !== undefined)) {
    throw new UpdateArgError("--rollback takes no other option")
  }
  // `--to` names one release, so its channel follows from the tag.
  const inferred: Channel = to !== undefined && /-nightly\./u.test(to) ? "nightly" : "stable"
  return {
    check,
    rollback,
    channel: channel ?? inferred,
    json: wantsJsonHelp(raw),
    ...(to ? { to } : {}),
  }
}

/** The output streams of the command. */
export interface UpdateIo {
  readonly stdout: { write(s: string): unknown }
  readonly stderr: { write(s: string): unknown }
}

/** The real seams, for a run of the installed binary. */
export function realUpdateDeps(
  env: Record<string, string | undefined>,
  stderr: UpdateIo["stderr"],
  build: BuildInfo = buildInfo(),
): UpdateDeps {
  return {
    env,
    build,
    standalone: isStandaloneExecutable(),
    execPath: process.execPath,
    host: detectHost(),
    fs: realFs,
    exec: realExec,
    fetch: (input, init) => fetch(input, init),
    resolveToken: (e) => resolveGithubToken(e, true),
    progress: (line) => stderr.write(`${line}\n`),
  }
}

/**
 * Run `update` for raw argv and return the exit code. Success and `--check`
 * results go to stdout, failures to stderr. JSON mode prints one object on
 * stdout in every case.
 */
export async function runUpdateCommand(
  raw: readonly string[],
  env: Record<string, string | undefined>,
  io: UpdateIo = { stdout: process.stdout, stderr: process.stderr },
  deps?: UpdateDeps,
): Promise<number> {
  let opts: UpdateOptions
  try {
    opts = parseUpdateArgs(raw)
  } catch (e) {
    if (!(e instanceof UpdateArgError)) throw e
    io.stderr.write(`update: ${e.message} (see minimal-agent update --help)\n`)
    return UPDATE_EXIT.usage
  }
  const outcome = await runUpdate(opts, deps ?? realUpdateDeps(env, io.stderr))
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ ...outcome.json, exitCode: outcome.code }, null, 2)}\n`)
  } else {
    const ok = outcome.code === UPDATE_EXIT.ok || outcome.code === UPDATE_EXIT.updateAvailable
    ;(ok ? io.stdout : io.stderr).write(`${ok ? "" : "update: "}${outcome.text}\n`)
  }
  return outcome.code
}
