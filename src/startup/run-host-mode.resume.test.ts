/**
 * Tests for `HostRuntime.resumeSession` (CLI host mode): a saved session
 * reopens in place under its own id with its history, new records go to
 * the same file, an unknown id throws `session.not-found` and leaves the
 * runtime able to open a fresh session, and the one-session limit covers
 * both `openSession` and `resumeSession`.
 *
 * @module host/startup/run-host-mode.resume.test
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionEntry } from "@minimal-agent/core"
import type { AuthResult } from "@minimal-agent/core/host/auth"
import { createLifecyclePort } from "@minimal-agent/core/host-kit/build-agent-core"
import type { HostModeContext, HostModeHandler } from "@minimal-agent/core/host-kit/host-mode"
import type { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { SessionStore } from "@minimal-agent/core/host-kit/session-store"
import type {
  TestSendParams as SendOptions,
  TestSendResult as StreamedResponse,
} from "../test-utils/transport-types.ts"

import { SESSION_NOT_FOUND } from "./host-resume.ts"
import {
  type HostRuntimeWithCapabilities,
  type RunHostModeInput,
  runHostMode,
} from "./run-host-mode.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const SAVED = "00000000-0000-4000-8000-81ae0d9c2428"

/** A loader stub with one host mode and an empty hook chain. */
function stubLoader(handler: HostModeHandler): PluginLoader {
  return {
    findHostMode: (id: string) =>
      id === "test"
        ? {
            spec: { id: "test", description: "test", entry: { type: "module", path: "x.ts" } },
            pluginId: "p",
            packageDir: "/",
            entryAbsolute: "/x.ts",
            handler,
          }
        : undefined,
    hooks: () => ({
      emitChain: async (_c: string, payload: unknown) => ({ payload, halted: false }),
    }),
  } as unknown as PluginLoader
}

/** A transport that records the message count of each request and answers "ok". */
function countingSend(counts: number[]) {
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    counts.push(opts.messages.length)
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

function makeInput(handler: HostModeHandler, dir: string, counts: number[]): RunHostModeInput {
  return {
    hostModeId: "test",
    hostModeArgv: [],
    promptSource: { kind: "none" },
    loader: stubLoader(handler),
    sessionDeps: {
      auth: AUTH,
      model: "model-a",
      sendFn: countingSend(counts),
      loader: null,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    },
    sessionId: "ba0ad20f-0000-4000-8000-cf4c4732fd3b",
    hostLifecycle: createLifecyclePort(null),
    stderr: { write: () => true },
    sessionsDir: dir,
    signalSource: new EventEmitter() as unknown as Pick<NodeJS.Process, "on" | "removeListener">,
  }
}

async function drain(iter: AsyncIterable<SessionEntry>): Promise<void> {
  for await (const _ of iter) {
    // drain only
  }
}

/** Write a saved session with one user and one assistant turn. */
function saveSession(dir: string): void {
  const store = SessionStore.open({
    sid: SAVED,
    dir,
    model: "model-a",
    cwd: process.cwd(),
    systemHash: "s",
    toolsHash: "t",
    agentVersion: "test",
  })
  store.appendUser("first question")
  store.appendAssistant([{ type: "text", text: "first answer" }], "end_turn")
}

const runtimeOf = (ctx: HostModeContext) => ctx.runtime as HostRuntimeWithCapabilities

describe("HostRuntime.resumeSession", () => {
  const savedExitCode = process.exitCode
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "host-resume-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    process.exitCode = savedExitCode
  })

  it("reopens a saved session in place: same id, its history, new records in the same file", async () => {
    saveSession(dir)
    const counts: number[] = []
    let sid = ""
    await runHostMode(
      makeInput(
        async (ctx) => {
          const session = await runtimeOf(ctx).resumeSession(SAVED)
          sid = session.sessionId
          const ac = new AbortController()
          const run = session.run("second question", { emitDeltas: true, signal: ac.signal })
          await drain(run)
          await run.result
          await session.close()
          return 0
        },
        dir,
        counts,
      ),
    )
    expect(process.exitCode).toBe(0)
    expect(sid).toBe(SAVED)
    // The request held the saved user + assistant turns plus the new prompt.
    expect(counts[0]).toBe(3)
    const log = readFileSync(join(dir, `${SAVED}.jsonl`), "utf8")
    expect(log).toContain("first question")
    expect(log).toContain("second question")
    expect(log.split("\n").filter((l) => l.includes('"kind":"meta"'))).toHaveLength(1)
  })

  it("an unknown id throws session.not-found, then openSession still works", async () => {
    const counts: number[] = []
    let code: unknown
    let freshId = ""
    await runHostMode(
      makeInput(
        async (ctx) => {
          try {
            await runtimeOf(ctx).resumeSession(SAVED)
          } catch (e) {
            code = (e as { code?: unknown }).code
          }
          const session = await ctx.runtime.openSession()
          freshId = session.sessionId
          await session.close()
          return 0
        },
        dir,
        counts,
      ),
    )
    expect(code).toBe(SESSION_NOT_FOUND)
    expect(freshId).toBe("ba0ad20f-0000-4000-8000-cf4c4732fd3b")
  })

  it("an id that is not a UUID is session.not-found (no path is read)", async () => {
    let code: unknown
    await runHostMode(
      makeInput(
        async (ctx) => {
          try {
            await runtimeOf(ctx).resumeSession("../etc/passwd")
          } catch (e) {
            code = (e as { code?: unknown }).code
          }
          return 0
        },
        dir,
        [],
      ),
    )
    expect(code).toBe(SESSION_NOT_FOUND)
  })

  it("one session per process: resumeSession after openSession throws", async () => {
    saveSession(dir)
    let message = ""
    await runHostMode(
      makeInput(
        async (ctx) => {
          const session = await ctx.runtime.openSession()
          try {
            await runtimeOf(ctx).resumeSession(SAVED)
          } catch (e) {
            message = (e as Error).message
          }
          await session.close()
          return 0
        },
        dir,
        [],
      ),
    )
    expect(message).toContain("already called once")
  })
})
