/**
 * The filesystem and process seams of `minimal-agent update`, and their
 * real implementations. Tests pass fakes.
 *
 * @module update/io
 */

import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"

/** The file operations the updater needs. All paths are absolute. */
export interface UpdateFs {
  exists(path: string): boolean
  /** True when the updater can create and rename files in `dir`. */
  canWrite(dir: string): boolean
  /** Write `data` to a new file with `mode` (chmod after write, so umask does not apply). */
  writeFile(path: string, data: Uint8Array, mode: number): void
  /** `rename(2)`: atomic replace within one filesystem. */
  rename(from: string, to: string): void
  /** Remove a file. No error when it is missing. */
  rm(path: string): void
  /** Hard-link `from` to `to`, else copy it (keeping mode 0755). `to` must not exist. */
  linkOrCopy(from: string, to: string): void
  /** Resolve symlinks. Returns `path` unchanged on error. */
  realpath(path: string): string
}

/** The real filesystem. */
export const realFs: UpdateFs = {
  exists: (path) => existsSync(path),
  canWrite: (dir) => {
    try {
      accessSync(dir, constants.W_OK | constants.X_OK)
      return true
    } catch {
      return false
    }
  },
  writeFile: (path, data, mode) => {
    writeFileSync(path, data, { mode })
    chmodSync(path, mode)
  },
  rename: (from, to) => renameSync(from, to),
  rm: (path) => rmSync(path, { force: true }),
  linkOrCopy: (from, to) => {
    try {
      linkSync(from, to)
    } catch {
      copyFileSync(from, to)
      chmodSync(to, 0o755)
    }
  },
  realpath: (path) => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  },
}

/** The result of one child process. */
export interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Run `argv` with `env` and a timeout. Never throws: a spawn error is exit 127. */
export type ExecFn = (
  argv: readonly string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
) => Promise<ExecResult>

/** The real exec, via `Bun.spawn`. */
export const realExec: ExecFn = async (argv, env, timeoutMs) => {
  try {
    const proc = Bun.spawn([...argv], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    return { exitCode, stdout, stderr }
  } catch (e) {
    return { exitCode: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) }
  }
}
