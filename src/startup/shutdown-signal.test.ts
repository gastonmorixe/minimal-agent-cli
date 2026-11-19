import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { PluginLoaderOptions } from "@minimal-agent/core/host-kit/plugin-loader"

import { cliShutdown } from "./shutdown-signal.ts"

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

const throwingExit = (code: number): never => {
  throw new ExitCalled(code)
}

describe("cliShutdown", () => {
  test("the signal is not aborted at the start", () => {
    const s = cliShutdown(throwingExit)
    expect(s.signal.aborted).toBe(false)
    expect(s.exitRequested()).toBe(false)
  })

  test("end() aborts the signal and is idempotent", () => {
    const s = cliShutdown(throwingExit)
    let events = 0
    s.signal.addEventListener("abort", () => events++)
    s.end()
    s.end()
    expect(s.signal.aborted).toBe(true)
    expect(events).toBe(1)
    expect(s.signal.reason).toBeInstanceOf(Error)
    expect(s.exitRequested()).toBe(false)
  })

  test("exit() aborts the signal before the base exit runs", () => {
    let abortedAtExit: boolean | undefined
    const s = cliShutdown((code): never => {
      abortedAtExit = s.signal.aborted
      throw new ExitCalled(code)
    })
    expect(() => s.exit(3)).toThrow(ExitCalled)
    expect(abortedAtExit).toBe(true)
    expect(s.exitRequested()).toBe(true)
    expect((s.signal.reason as Error).message).toBe("cli-exit")
  })

  test("the signal fits the loader hostOptions.shutdownSignal type", () => {
    const s = cliShutdown(throwingExit)
    const hostOptions: NonNullable<PluginLoaderOptions["hostOptions"]> = {
      shutdownSignal: s.signal,
    }
    expect(hostOptions.shutdownSignal).toBe(s.signal)
  })
})

describe("main.ts wiring (source check)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "main.ts"), "utf8")

  test("main() makes one cliShutdown and passes its exit and signal", () => {
    expect(src.match(/cliShutdown\(/g)?.length).toBe(1)
    expect(src).toContain("exit: shutdown.exit,")
    expect(src).toContain("shutdownSignal: shutdown.signal,")
  })

  test("the finally of main() calls shutdown.end()", () => {
    expect(src).toMatch(/\} finally \{\s*shutdown\.end\(\)/)
  })

  test("PluginLoader.load gets hostOptions.shutdownSignal", () => {
    const start = src.indexOf("PluginLoader.load({")
    const end = src.indexOf("}).then(dryRun.checked)", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(src.slice(start, end)).toContain("hostOptions: { shutdownSignal: io.shutdownSignal }")
  })
})
