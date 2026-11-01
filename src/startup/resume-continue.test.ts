/**
 * `--resume` continues an unfinished turn at its next round (S50).
 *
 * The test spawns the real CLI `main()` through
 * `fixtures/resume-kill-child.ts`, with the scripted fixture provider
 * (`fixtures/plugins/ma-llm-resume-fixture-plugin`, shipped with this test,
 * so it never skips) and a real session store in a temp home. Run 1 does two tool rounds, and the child
 * kills itself with SIGKILL when round 3 starts. Run 2 is
 * `--resume <id>`. It must continue the turn by itself at round 3, with
 * no human input, and must not repeat the Bash calls of rounds 1 and 2.
 *
 * @module startup/resume-continue.test
 */

import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import type { AuthResult } from "@minimal-agent/core/host/auth"
import type { BuildAgentCoreDeps } from "@minimal-agent/core/host-kit/build-agent-core"
import { SessionStore } from "@minimal-agent/core/host-kit/session-store"
import { InteractiveSession } from "../interactive-session.ts"
import type {
  TestSendOptions as SendOptions,
  TestStreamedResponse as StreamedResponse,
} from "../test-utils/transport-types.ts"

const CLI_ROOT = join(import.meta.dir, "..", "..")
const TMP_ROOT = join(CLI_ROOT, "tmp")
mkdirSync(TMP_ROOT, { recursive: true })
const HOME_DIR = mkdtempSync(join(TMP_ROOT, "resume-continue-"))
const LOG = join(HOME_DIR, "requests.log")
const MARK = join(HOME_DIR, "mark.txt")
const SESSIONS = join(HOME_DIR, ".minimal-agent", "sessions")
const CHILD = join(import.meta.dir, "fixtures", "resume-kill-child.ts")
// Only the fixture provider. The test needs no sibling plugins repo.
const FIXTURE_PLUGINS = join(import.meta.dir, "fixtures", "plugins")
const SID = "5a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d"

afterAll(() => {
  rmSync(HOME_DIR, { recursive: true, force: true })
})

/** A temp home with its own request log and mark file. */
function homeFiles(home: string) {
  return { home, log: join(home, "requests.log"), mark: join(home, "mark.txt") }
}

async function runChild(
  args: string[],
  killAtRound: number,
  files = homeFiles(HOME_DIR),
) {
  const p = Bun.spawn(["bun", "run", CHILD, "--skip-quota", "--formatter", "cat", ...args], {
    cwd: CLI_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      MINIMAL_AGENT_TEST_AUTH: "1",
      MINIMAL_AGENT_PROVIDER: "resume-fixture",
      MINIMAL_AGENT_MODEL: "resume-fixture-model",
      MINIMAL_AGENT_PLUGIN_SIBLINGS: FIXTURE_PLUGINS,
      MINIMAL_AGENT_NO_PLUGIN_SYNC: "1",
      MINIMAL_AGENT_NO_LIVE_AREA: "1",
      HOME: files.home,
      MINIMAL_AGENT_HOME: join(files.home, ".minimal-agent"),
      RESUME_TEST_LOG: files.log,
      RESUME_TEST_MARK: files.mark,
      RESUME_TEST_KILL_AT_ROUND: String(killAtRound),
    },
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  return { exitCode, signalCode: p.signalCode, stdout, stderr }
}

function lines(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
}

describe("--resume continues an unfinished turn (S50)", () => {
  it("a run killed after round 2 continues at round 3 and does not repeat rounds 1-2", async () => {
    const first = await runChild(["--session-id", SID, "-p", "go"], 3)
    expect(first.signalCode).toBe("SIGKILL")
    expect(lines(LOG)).toEqual(["1", "2", "3"])
    expect(lines(MARK)).toEqual(["r1", "r2"])

    rmSync(LOG, { force: true })
    // No prompt and no stdin: no human is present. The run must go on by itself.
    const resumed = await runChild(["--resume", SID], 0)
    expect(resumed.stderr).not.toContain("fatal")
    expect(resumed.exitCode).toBe(0)
    const requests = lines(LOG)
    // The first request after the restart is round 3. Rounds 1 and 2 are
    // never sent again, and their Bash calls never run again.
    expect(requests[0]).toBe("3")
    expect(requests).not.toContain("1")
    expect(requests).not.toContain("2")
    expect(lines(MARK)).toEqual(["r1", "r2"])
    expect(resumed.stdout).toContain("ROUND-3-ANSWER")

    // The forked session holds the round 3 answer right after the old
    // records, with no new user turn before it. The turn then settled.
    const forkedName = readdirSync(SESSIONS).find(
      (f) => /^[0-9a-f-]{36}\.jsonl$/.test(f) && f !== `${SID}.jsonl`,
    )
    expect(forkedName).toBeDefined()
    const records = lines(join(SESSIONS, forkedName ?? "")).map(
      (l) => JSON.parse(l) as { kind: string; round?: number; content?: unknown },
    )
    const conversation = records.filter((r) => r.kind === "user" || r.kind === "assistant")
    expect(conversation.map((r) => r.kind).slice(0, 4)).toEqual([
      "user",
      "assistant",
      "assistant",
      "assistant",
    ])
    expect(JSON.stringify(conversation[3]?.content)).toContain("ROUND-3-ANSWER")
    expect(records.filter((r) => r.kind === "round_checkpoint").at(-1)?.round).toBe(0)
  }, 60000)

  it("the json route continues the turn at round 3 before the new prompt", async () => {
    const files = homeFiles(mkdtempSync(join(HOME_DIR, "json-")))
    const sid = "7c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
    const first = await runChild(["--session-id", sid, "-p", "go"], 3, files)
    expect(first.signalCode).toBe("SIGKILL")
    expect(lines(files.mark)).toEqual(["r1", "r2"])

    rmSync(files.log, { force: true })
    const resumed = await runChild(
      ["--resume", sid, "-p", "next", "--output-format", "json"],
      0,
      files,
    )
    expect(resumed.stderr).not.toContain("fatal")
    expect(resumed.exitCode).toBe(0)
    // Two requests: the continuation of the cut turn (round 3), then the
    // new prompt. Rounds 1 and 2 never run again.
    expect(lines(files.log)).toEqual(["3", "3"])
    expect(lines(files.mark)).toEqual(["r1", "r2"])
    // stdout is JSON lines only, and it carries the round 3 answer.
    for (const line of resumed.stdout.split("\n").filter((l) => l.length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    expect(resumed.stdout).toContain("ROUND-3-ANSWER")
  }, 60000)
})

/** The round of a request: 1 + the count of tool results in its history. */
function roundOf(opts: SendOptions): number {
  return 1 + (JSON.stringify(opts.messages).match(/"tool_result"/g)?.length ?? 0)
}

function deps(store: SessionStore, sendFn: BuildAgentCoreDeps["sendFn"]) {
  const auth: AuthResult = { type: "api-key", token: "test-token" }
  return {
    auth,
    model: "test-model",
    sendFn,
    loader: null,
    modeManager: null,
    store,
    blobStore: null,
    saveEcho: null,
    turnAttachments: [],
  }
}

describe("InteractiveSession resumeFrom (S50, in process)", () => {
  it("continues at round 3 through core resumeSession after a crash in round 3", async () => {
    const dir = join(HOME_DIR, "in-process")
    const sid = "6b1c2d3e-4f5a-4b6c-9d7e-8f9a0b1c2d3e"
    const store = SessionStore.open({
      sid,
      model: "test-model",
      cwd: process.cwd(),
      systemHash: "",
      toolsHash: "",
      agentVersion: "test",
      dir,
    })
    const sent: number[] = []
    const crashing = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      const round = roundOf(opts)
      sent.push(round)
      if (round === 3) throw new Error("process killed")
      return {
        blocks: [{ type: "tool_use", id: `tool-${round}`, name: "NoSuchTool", input: {} }],
        text: "",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    const first = await InteractiveSession.create(deps(store, crashing))
    const gen = first.run("go")
    await expect(
      (async () => {
        for (let step = await gen.next(); !step.done; step = await gen.next()) {
          // drain
        }
      })(),
    ).rejects.toThrow("process killed")
    expect(sent).toEqual([1, 2, 3])

    // A new process: reopen the same store and resume by id.
    const reopened = SessionStore.open({
      sid,
      model: "test-model",
      cwd: process.cwd(),
      systemHash: "",
      toolsHash: "",
      agentVersion: "test",
      dir,
      existsOk: true,
    })
    const resumedRounds: number[] = []
    const answering = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      resumedRounds.push(roundOf(opts))
      yield "round 3 answer"
      return {
        blocks: [{ type: "text", text: "round 3 answer" }],
        text: "round 3 answer",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const resumed = await InteractiveSession.create({
      ...deps(reopened, answering),
      resumeFrom: { sid, dir },
    })
    let text = ""
    const run = resumed.run("", { resume: true })
    for (let step = await run.next(); !step.done; step = await run.next()) text += step.value
    expect(resumedRounds).toEqual([3])
    expect(text).toBe("round 3 answer")
    // The history came from disk: two tool rounds, then the answer.
    expect(resumed.history().filter((m) => m.role === "assistant")).toHaveLength(3)
    // No event sidecar: the CLI keeps the event log in memory.
    expect(existsSync(join(dir, `${sid}.events.jsonl`))).toBe(false)
  })
})
