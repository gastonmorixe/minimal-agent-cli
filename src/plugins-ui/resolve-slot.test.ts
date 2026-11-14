/**
 * A subprocess live-area slot must not outlive its invocation: a hanging
 * child is killed when the slot timeout fires or when `ctx.abort` aborts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type {
  LiveAreaHandlerContext,
  ManifestLiveAreaSlot,
} from "@minimal-agent/core/plugin-api/types/plugin"

import { resolveLiveAreaSlot } from "./resolve-slot.ts"

const RESOLVE_SLOT = join(import.meta.dir, "resolve-slot.ts")

/** True while `pid` exists (signal 0 probe). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await Bun.sleep(20)
  }
  return !alive(pid)
}

/** Resolve with `p`, or reject when `p` does not settle within `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`invoke did not return within ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([p, late])
  } finally {
    clearTimeout(timer)
  }
}

describe("resolveLiveAreaSlot subprocess kill", () => {
  let dir: string
  const started: number[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "slot-kill-"))
    // Write the script pid, then block on it (`exec` keeps the same pid).
    // The shell pid variable is built by repeat so no editor collapses the pair.
    const selfPid = "$".repeat(2)
    const script = join(dir, "hang")
    writeFileSync(script, `#!/bin/sh\necho ${selfPid} > "${join(dir, "pid")}"\nexec sleep 300\n`)
    chmodSync(script, 0o755)
  })

  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })

  async function readPid(): Promise<number> {
    const file = join(dir, "pid")
    const end = Date.now() + 5000
    while (Date.now() < end) {
      if (existsSync(file)) {
        const pid = Number(readFileSync(file, "utf8").trim())
        if (pid > 0) {
          started.push(pid)
          return pid
        }
      }
      await Bun.sleep(20)
    }
    throw new Error("slot did not write its pid")
  }

  async function resolveHang(timeoutMs: number) {
    const slot: ManifestLiveAreaSlot = {
      id: "hang",
      handler: { type: "subprocess", command: ["hang"] },
      timeoutMs,
    }
    const resolved = await resolveLiveAreaSlot(slot, "test-plugin", dir, () => {})
    if (!resolved) throw new Error("slot did not resolve")
    return resolved
  }

  function ctx(abort: AbortSignal): LiveAreaHandlerContext {
    return {
      packageDir: dir,
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      abort,
      tick: 0,
    } as unknown as LiveAreaHandlerContext
  }

  test("timeout: the call returns and the child is gone", async () => {
    const slot = await resolveHang(1500)
    const run = slot.invoke(ctx(new AbortController().signal))
    const pid = await readPid()
    expect(await within(run, 5000)).toBeNull()
    expect(await waitGone(pid, 1000)).toBe(true)
  }, 15_000)

  test("abort: the call returns and the child is gone", async () => {
    const slot = await resolveHang(30_000)
    const ac = new AbortController()
    const run = slot.invoke(ctx(ac.signal))
    const pid = await readPid()
    ac.abort()
    expect(await within(run, 3000)).toBeNull()
    expect(await waitGone(pid, 1000)).toBe(true)
  }, 15_000)

  test("host exit: a hanging slot dies when the host calls process.exit(0)", async () => {
    const host = Bun.spawn(
      [
        process.execPath,
        "-e",
        [
          `import { existsSync } from "node:fs"`,
          `import { resolveLiveAreaSlot } from ${JSON.stringify(RESOLVE_SLOT)}`,
          `const slot = { id: "hang", handler: { type: "subprocess", command: ["hang"] }, timeoutMs: 30000 }`,
          `const r = await resolveLiveAreaSlot(slot, "test-plugin", ${JSON.stringify(dir)}, () => {})`,
          `void r.invoke({ packageDir: ${JSON.stringify(dir)}, cwd: ${JSON.stringify(dir)}, env: { PATH: process.env.PATH ?? "" }, abort: new AbortController().signal, tick: 0 })`,
          "const end = Date.now() + 5000",
          `while (!existsSync(${JSON.stringify(join(dir, "pid"))}) && Date.now() < end) await Bun.sleep(20)`,
          "process.exit(0)",
        ].join("\n"),
      ],
      { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "inherit" },
    )
    started.push(host.pid)
    const pid = await readPid()
    expect(await host.exited).toBe(0)
    expect(await waitGone(pid, 2000)).toBe(true)
  }, 15_000)

  test("the slot shares the host process group, so terminal SIGHUP reaches it", async () => {
    const slot = await resolveHang(30_000)
    const ac = new AbortController()
    const run = slot.invoke(ctx(ac.signal))
    const pid = await readPid()
    const ps = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)])
    const own = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)])
    expect(ps.stdout.toString().trim()).toBe(own.stdout.toString().trim())
    ac.abort()
    expect(await within(run, 3000)).toBeNull()
  }, 15_000)
})
