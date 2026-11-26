/**
 * `--resume` of a session with an unfinished turn (S50). A resumed session
 * never continues anything until the user engages: `/continue` resumes the
 * turn at its next round, and a new message starts a new turn instead.
 *
 * The test spawns the real CLI `main()` through
 * `fixtures/resume-kill-child.ts`, with the scripted fixture provider
 * (`fixtures/plugins/ma-llm-resume-fixture-plugin`, shipped with this test,
 * so it never skips) and a real session store in a temp home. Run 1 does
 * two tool rounds, and the child kills itself with SIGKILL when round 3
 * starts. Run 2 is `--resume <id>`. With no input it must send nothing.
 * With `/continue` it must continue at round 3 and must not repeat the
 * Bash calls of rounds 1 and 2.
 *
 * @module startup/resume-continue.test
 */

import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import type { AuthResult } from "@minimal-agent/core/host/auth"
import type { BuildAgentCoreDeps } from "@minimal-agent/core/host-kit/build-agent-core"
import { SessionStore } from "@minimal-agent/core/host-kit/session-store"
import { cleanSpawnEnv } from "../e2e/clean-spawn-env.ts"
import { InteractiveSession } from "../interactive-session.ts"
import { tempHomeSpawnEnv } from "../test-utils/temp-home-env.ts"
import type {
  TestSendParams as SendOptions,
  TestSendResult as StreamedResponse,
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
  stdinText?: string,
) {
  const p = Bun.spawn(["bun", "run", CHILD, "--skip-quota", "--formatter", "cat", ...args], {
    cwd: CLI_ROOT,
    stdin: stdinText === undefined ? "ignore" : new Blob([stdinText]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30000,
    env: {
      ...cleanSpawnEnv(),
      ...tempHomeSpawnEnv(),
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

/** The records of the session that `--resume` forked from `parent`. */
function forkedRecords(sessions: string, parent: string) {
  const forkedName = readdirSync(sessions).find(
    (f) => /^[0-9a-f-]{36}\.jsonl$/.test(f) && f !== `${parent}.jsonl`,
  )
  expect(forkedName).toBeDefined()
  return lines(join(sessions, forkedName ?? "")).map(
    (l) => JSON.parse(l) as { kind: string; round?: number; content?: unknown },
  )
}

describe("--resume waits for the user on an unfinished turn (S50)", () => {
  it("sends nothing with no input, then /continue resumes at round 3", async () => {
    const first = await runChild(["--session-id", SID, "-p", "go"], 3)
    expect(first.signalCode).toBe("SIGKILL")
    expect(lines(LOG)).toEqual(["1", "2", "3"])
    expect(lines(MARK)).toEqual(["r1", "r2"])

    // No prompt and no stdin: the REPL starts, reads EOF, and exits. The
    // unfinished turn must not continue by itself.
    rmSync(LOG, { force: true })
    const idle = await runChild(["--resume", SID], 0)
    expect(idle.stderr).not.toContain("fatal")
    expect(idle.exitCode).toBe(0)
    expect(lines(LOG)).toEqual([])
    expect(lines(MARK)).toEqual(["r1", "r2"])
    expect(idle.stdout).not.toContain("ROUND-3-ANSWER")
    expect(idle.stdout).toContain("/continue to resume it")

    // `/continue` resumes the cut turn at round 3, with no new user turn.
    rmSync(SESSIONS, { recursive: true, force: true })
    rmSync(MARK, { force: true })
    rmSync(LOG, { force: true })
    const again = await runChild(["--session-id", SID, "-p", "go"], 3)
    expect(again.signalCode).toBe("SIGKILL")
    rmSync(LOG, { force: true })
    const resumed = await runChild(["--resume", SID], 0, homeFiles(HOME_DIR), "/continue\n")
    expect(resumed.stderr).not.toContain("fatal")
    expect(resumed.exitCode).toBe(0)
    const requests = lines(LOG)
    // The first request after the restart is round 3. Rounds 1 and 2 are
    // never sent again, and their Bash calls never run again.
    expect(requests).toEqual(["3"])
    expect(lines(MARK)).toEqual(["r1", "r2"])
    expect(resumed.stdout).toContain("ROUND-3-ANSWER")

    // The forked session holds the round 3 answer right after the old
    // records, with no new user turn before it. The turn then settled.
    const records = forkedRecords(SESSIONS, SID)
    const conversation = records.filter((r) => r.kind === "user" || r.kind === "assistant")
    expect(conversation.map((r) => r.kind).slice(0, 4)).toEqual([
      "user",
      "assistant",
      "assistant",
      "assistant",
    ])
    expect(JSON.stringify(conversation[3]?.content)).toContain("ROUND-3-ANSWER")
    expect(records.filter((r) => r.kind === "round_checkpoint").at(-1)?.round).toBe(0)
  }, 90000)

  it("the json route runs only the new prompt, not the cut turn", async () => {
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
    // One request: the new prompt. The cut turn is not continued first.
    expect(lines(files.log)).toEqual(["3"])
    expect(lines(files.mark)).toEqual(["r1", "r2"])
    // stdout is JSON lines only.
    for (const line of resumed.stdout.split("\n").filter((l) => l.length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    // The new prompt is a user record in the forked session, and the turn
    // settled, so the stale checkpoint is gone.
    const records = forkedRecords(join(files.home, ".minimal-agent", "sessions"), sid)
    const users = records.filter((r) => r.kind === "user")
    expect(JSON.stringify(users.at(-1)?.content)).toContain("next")
    expect(records.filter((r) => r.kind === "round_checkpoint").at(-1)?.round).toBe(0)
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

/** A provider that asks for one tool per round and dies at round 3. */
function crashingAtRound3(sent: number[]) {
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    const round = roundOf(opts)
    sent.push(round)
    if (round === 3) throw new Error("process killed")
    return {
      blocks: [{ type: "tool_use", id: `tool-${round}`, name: "NoSuchTool", input: {} }],
      text: "",
      stopReason: "tool_use",
    } as StreamedResponse
  }
}

/** A provider that answers with text, and records the round and the request. */
function answering(rounds: number[], requests: SendOptions[] = []) {
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    rounds.push(roundOf(opts))
    requests.push(opts)
    yield "round 3 answer"
    return {
      blocks: [{ type: "text", text: "round 3 answer" }],
      text: "round 3 answer",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

function openStore(dir: string, sid: string, existsOk = false): SessionStore {
  return SessionStore.open({
    sid,
    model: "test-model",
    cwd: process.cwd(),
    systemHash: "",
    toolsHash: "",
    agentVersion: "test",
    dir,
    ...(existsOk ? { existsOk: true } : {}),
  })
}

/** Run 1: two tool rounds, then a crash in round 3. */
async function crashSession(dir: string, sid: string): Promise<void> {
  const sent: number[] = []
  const first = await InteractiveSession.create(deps(openStore(dir, sid), crashingAtRound3(sent)))
  const gen = first.run("go")
  await expect(
    (async () => {
      for (let step = await gen.next(); !step.done; step = await gen.next()) {
        // drain
      }
    })(),
  ).rejects.toThrow("process killed")
  expect(sent).toEqual([1, 2, 3])
}

async function drain(gen: AsyncGenerator<string, unknown, undefined>): Promise<string> {
  let text = ""
  for (let step = await gen.next(); !step.done; step = await gen.next()) text += step.value
  return text
}

describe("InteractiveSession resumeFrom (S50, in process)", () => {
  it("/continue (noteSessionResumed) continues at round 3 after a crash in round 3", async () => {
    const dir = join(HOME_DIR, "in-process")
    const sid = "6b1c2d3e-4f5a-4b6c-9d7e-8f9a0b1c2d3e"
    await crashSession(dir, sid)

    // A new process: reopen the same store and resume by id.
    const resumedRounds: number[] = []
    const resumed = await InteractiveSession.create({
      ...deps(openStore(dir, sid, true), answering(resumedRounds)),
      resumeFrom: { sid, dir },
    })
    // Opening the session sends nothing.
    expect(resumedRounds).toEqual([])
    // What the REPL's `/continue` does: mark, then an empty run.
    resumed.noteSessionResumed()
    const turns: number[] = []
    const text = await drain(
      resumed.run("", {
        onEvent: (e) => {
          if (e.type === "turn_completed") turns.push(e.turn)
        },
      }),
    )
    expect(resumedRounds).toEqual([3])
    // The core continued its own round count: round 3, not a new round 1.
    expect(turns).toEqual([3])
    expect(text).toBe("round 3 answer")
    // The history came from disk: two tool rounds, then the answer. No new
    // user turn was added: "go" and the two tool-result messages only.
    const history = resumed.history()
    expect(history.filter((m) => m.role === "assistant")).toHaveLength(3)
    expect(history.filter((m) => m.role === "user")).toHaveLength(3)
    // No event sidecar: the CLI keeps the event log in memory.
    expect(existsSync(join(dir, `${sid}.events.jsonl`))).toBe(false)
  })

  it("a new message instead of /continue starts a new turn and clears the checkpoint", async () => {
    const dir = join(HOME_DIR, "in-process-new")
    const sid = "8d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a"
    await crashSession(dir, sid)

    const rounds: number[] = []
    const requests: SendOptions[] = []
    const resumed = await InteractiveSession.create({
      ...deps(openStore(dir, sid, true), answering(rounds, requests)),
      resumeFrom: { sid, dir },
    })
    await drain(resumed.run("something else"))
    expect(rounds).toEqual([3])
    // The request ends with a user message that holds the new text, and
    // the history alternates roles (the API needs no [user, user]).
    const messages = requests[0]?.messages ?? []
    expect(JSON.stringify(messages.at(-1))).toContain("something else")
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i]?.role).not.toBe(messages[i - 1]?.role)
    }
    // The turn settled, so a later resume finds nothing to continue.
    const records = lines(join(dir, `${sid}.jsonl`)).map(
      (l) => JSON.parse(l) as { kind: string; round?: number },
    )
    expect(records.filter((r) => r.kind === "round_checkpoint").at(-1)?.round).toBe(0)
  })
})
