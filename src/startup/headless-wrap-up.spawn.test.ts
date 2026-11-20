/**
 * The SIGTERM wrap-up in a REAL child process (review test #9): the real
 * SIGTERM listener, the real stdout and the real exit path, with a fake
 * provider (`fixtures/sigterm-wrap-up-child.ts`).
 *
 * - One SIGTERM: ONE final turn, the report tool writes the sentinel, and
 *   the process exits 143 well under the 45 s grace.
 * - A final request that hangs: a second SIGTERM ends the process at once
 *   with 143.
 * - A live handle after the run (an interval): the after-run exit still
 *   ends the process with 143.
 * - Not a worker (no wrap-up tools env): SIGTERM ends the process at once,
 *   with no more request, as before the feature.
 *
 * The child also has one plugin-style fan-out SIGTERM listener.
 *
 * @module host/startup/headless-wrap-up.spawn.test
 */

import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { isolatedCliEnv } from "../test-utils/isolated-cli-env.ts"

import {
  AFTER_RUN_EXIT_MS,
  ENV_WRAP_UP_TOOLS,
  REPEAT_IGNORE_MS,
  SIGTERM_EXIT_CODE,
} from "./headless-wrap-up.ts"

const CHILD = join(import.meta.dir, "fixtures", "sigterm-wrap-up-child.ts")
const ISO = isolatedCliEnv({ prefix: "ma-wrap-up-home-" })
const DIR = mkdtempSync(join(tmpdir(), "ma-wrap-up-"))
afterAll(() => {
  ISO.cleanup()
  rmSync(DIR, { recursive: true, force: true })
})

/** A stream reader that collects the text and waits for a line. */
function collect(stream: ReadableStream<Uint8Array>) {
  let text = ""
  const waiters: Array<{ needle: string; resolve: () => void }> = []
  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true })
      for (const w of waiters.splice(0)) {
        if (text.includes(w.needle)) w.resolve()
        else waiters.push(w)
      }
    }
  })()
  return {
    text: (): string => text,
    waitFor: (needle: string, ms = 10_000): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (text.includes(needle)) return resolve()
        waiters.push({ needle, resolve })
        setTimeout(() => reject(new Error(`no "${needle}" in ${ms} ms: ${text}`)), ms)
      }),
  }
}

function spawnChild(mode: "final" | "hang" | "live", sentinel: string, worker = true) {
  const env: Record<string, string | undefined> = { ...ISO.env }
  if (worker) env[ENV_WRAP_UP_TOOLS] = "Report"
  else delete env[ENV_WRAP_UP_TOOLS]
  const p = Bun.spawn(["bun", "run", CHILD, mode, sentinel], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  return { p, out: collect(p.stdout), err: collect(p.stderr) }
}

/** Resolve with the exit code, or kill the child and fail after `ms`. */
async function exitWithin(p: Bun.Subprocess, ms: number): Promise<number> {
  const timer = Bun.sleep(ms).then(() => "timeout" as const)
  const code = await Promise.race([p.exited, timer])
  if (code === "timeout") {
    p.kill("SIGKILL")
    throw new Error(`child did not exit in ${ms} ms`)
  }
  return code
}

describe("headless SIGTERM wrap-up (real process)", () => {
  it("one SIGTERM: one final turn, the sentinel is written, exit 143 in time", async () => {
    const sentinel = join(DIR, "final.sentinel")
    const { p, out, err } = spawnChild("final", sentinel)
    await err.waitFor("SEND 1")
    const t0 = Date.now()
    p.kill("SIGTERM")
    expect(await exitWithin(p, 20_000)).toBe(SIGTERM_EXIT_CODE)
    expect(Date.now() - t0).toBeLessThan(20_000)
    expect(existsSync(sentinel)).toBe(true)
    // Exactly one more request (the final turn), and no third one.
    expect(err.text()).toContain("SEND 2")
    expect(err.text()).not.toContain("SEND 3")
    const lines = out
      .text()
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.filter((l) => l.type === "run_finished").map((l) => l.outcome)).toEqual([
      "truncated",
    ])
  }, 30_000)

  it("a second SIGTERM ends a hung final turn at once with 143", async () => {
    const sentinel = join(DIR, "hang.sentinel")
    const { p, err } = spawnChild("hang", sentinel)
    await err.waitFor("SEND 1")
    p.kill("SIGTERM")
    await err.waitFor("SEND 2")
    // A repeat in the first REPEAT_IGNORE_MS is ignored (a plugin re-raise).
    await Bun.sleep(REPEAT_IGNORE_MS + 100)
    const t0 = Date.now()
    p.kill("SIGTERM")
    expect(await exitWithin(p, 10_000)).toBe(SIGTERM_EXIT_CODE)
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(existsSync(sentinel)).toBe(false)
  }, 30_000)

  it("MAJ-1: a live handle after the run cannot keep the process; exit 143", async () => {
    const sentinel = join(DIR, "live.sentinel")
    const { p, err } = spawnChild("live", sentinel)
    await err.waitFor("SEND 1")
    const t0 = Date.now()
    p.kill("SIGTERM")
    expect(await exitWithin(p, 15_000)).toBe(SIGTERM_EXIT_CODE)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(AFTER_RUN_EXIT_MS - 100)
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(existsSync(sentinel)).toBe(true)
    expect(err.text()).toContain("a live handle kept the process")
    // The fan-out listener saw the owner and deferred to it.
    expect(err.text()).toContain("FANOUT owners=1")
  }, 30_000)

  it("R3: not a worker: SIGTERM ends the process at once with no more request", async () => {
    const sentinel = join(DIR, "plain.sentinel")
    const { p, err } = spawnChild("final", sentinel, false)
    await err.waitFor("SEND 1")
    const t0 = Date.now()
    p.kill("SIGTERM")
    await exitWithin(p, 10_000)
    expect(Date.now() - t0).toBeLessThan(5000)
    // The fan-out found no owner, raised the signal again, and the default
    // action ended the process.
    expect(err.text()).toContain("FANOUT owners=0")
    expect(p.signalCode).toBe("SIGTERM")
    expect(err.text()).not.toContain("SEND 2")
    expect(err.text()).not.toContain("wrap-up started")
    expect(existsSync(sentinel)).toBe(false)
  }, 30_000)
})
