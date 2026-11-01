/**
 * A tool call cut off by a kill, over two resumes (decision 31).
 *
 * The test spawns the real CLI `main()` through
 * `fixtures/resume-kill-child.ts` with the fixture provider in its `cutoff`
 * script and a real session store in a temp home.
 *
 * 1. Run 1 does one normal Bash round. In round 2, the Bash call kills the
 *    CLI with SIGKILL while the tool runs.
 * 2. Resume 1 continues the turn. Core closes the cut-off call with a
 *    synthetic error result (the note). The model asks for one more Bash
 *    call, and that call kills the CLI again while it runs.
 * 3. Resume 2 continues the turn. Its request must hold each tool_use and
 *    tool_result pair exactly once, in order, with the note for each cut-off
 *    call. No tool may run again by itself.
 *
 * @module startup/resume-cutoff.test
 */

import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { tempHomeSpawnEnv } from "../test-utils/temp-home-env.ts"

const CLI_ROOT = join(import.meta.dir, "..", "..")
const TMP_ROOT = join(CLI_ROOT, "tmp")
mkdirSync(TMP_ROOT, { recursive: true })
const HOME_DIR = mkdtempSync(join(TMP_ROOT, "resume-cutoff-"))
const MARK = join(HOME_DIR, "mark.txt")
const REQS = join(HOME_DIR, "requests.jsonl")
const SESSIONS = join(HOME_DIR, ".minimal-agent", "sessions")
const CHILD = join(import.meta.dir, "fixtures", "resume-kill-child.ts")
const FIXTURE_PLUGINS = join(import.meta.dir, "fixtures", "plugins")
const SID = "8d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a"
const NOTE =
  "The process stopped while this tool call ran. It may have run fully, partly, or not at all. Check its effects before you run it again."

afterAll(() => {
  rmSync(HOME_DIR, { recursive: true, force: true })
})

async function runChild(args: string[]) {
  const p = Bun.spawn(["bun", "run", CHILD, "--skip-quota", "--formatter", "cat", ...args], {
    cwd: CLI_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30000,
    env: {
      ...process.env,
      ...tempHomeSpawnEnv(),
      NODE_ENV: "test",
      MINIMAL_AGENT_TEST_AUTH: "1",
      MINIMAL_AGENT_PROVIDER: "resume-fixture",
      MINIMAL_AGENT_MODEL: "resume-fixture-model",
      MINIMAL_AGENT_PLUGIN_SIBLINGS: FIXTURE_PLUGINS,
      MINIMAL_AGENT_NO_PLUGIN_SYNC: "1",
      MINIMAL_AGENT_NO_LIVE_AREA: "1",
      HOME: HOME_DIR,
      MINIMAL_AGENT_HOME: join(HOME_DIR, ".minimal-agent"),
      RESUME_TEST_LOG: join(HOME_DIR, "rounds.log"),
      RESUME_TEST_MARK: MARK,
      RESUME_TEST_KILL_AT_ROUND: "0",
      RESUME_TEST_SCRIPT: "cutoff",
      RESUME_TEST_REQS: REQS,
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

interface Block {
  type: string
  id?: string
  toolUseId?: string
  content?: unknown
  isError?: boolean
  text?: string
}

/**
 * A short form of a request's messages: one entry per tool_use and
 * tool_result block, in order, as `use:<id>` or `result:<id>[:note]`.
 */
function pairs(messages: Array<{ role: string; content: string | Block[] }>): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b.type === "tool_use") out.push(`${m.role}:use:${b.id}`)
      if (b.type === "tool_result") {
        const text = JSON.stringify(b.content)
        const note = text.includes(NOTE) && b.isError === true ? ":note" : ""
        out.push(`${m.role}:result:${b.toolUseId}${note}`)
      }
    }
  }
  return out
}

/** The newest session file that is not in `known`. */
function newSession(known: string[]): string {
  const name = readdirSync(SESSIONS).find(
    (f) => /^[0-9a-f-]{36}\.jsonl$/.test(f) && !known.includes(f),
  )
  expect(name).toBeDefined()
  return (name ?? "").replace(/\.jsonl$/, "")
}

describe("a tool call cut off by a kill, over two resumes (decision 31)", () => {
  it("keeps each cut-off pair once and in place, and never runs a tool again", async () => {
    const first = await runChild(["--session-id", SID, "-p", "go"])
    expect(first.signalCode).toBe("SIGKILL")
    expect(lines(MARK)).toEqual(["r1", "c2"])

    const resume1 = await runChild(["--resume", SID])
    expect(resume1.signalCode).toBe("SIGKILL")
    expect(lines(MARK)).toEqual(["r1", "c2", "c3"])
    const sid1 = newSession([`${SID}.jsonl`])

    const resume2 = await runChild(["--resume", sid1])
    expect(resume2.stderr).not.toContain("fatal")
    expect(resume2.exitCode).toBe(0)
    expect(resume2.stdout).toContain("CUTOFF-ANSWER")
    // No tool ran again by itself.
    expect(lines(MARK)).toEqual(["r1", "c2", "c3"])

    const requests = lines(REQS).map(
      (l) => JSON.parse(l) as Array<{ role: string; content: string | Block[] }>,
    )
    expect(requests).toHaveLength(4)
    const [, round2, resumed1, resumed2] = requests
    // Run 1, round 2: the normal round 1 pair is in the request.
    expect(pairs(round2 ?? [])).toEqual(["assistant:use:toolu_1", "user:result:toolu_1"])
    // Resume 1: the cut-off call gets the note right after its tool_use.
    expect(pairs(resumed1 ?? [])).toEqual([
      "assistant:use:toolu_1",
      "user:result:toolu_1",
      "assistant:use:toolu_2",
      "user:result:toolu_2:note",
    ])
    // Resume 2: the first pair is still there, once and in the same place.
    // The second cut-off call gets its own note after it.
    expect(pairs(resumed2 ?? [])).toEqual([
      "assistant:use:toolu_1",
      "user:result:toolu_1",
      "assistant:use:toolu_2",
      "user:result:toolu_2:note",
      "assistant:use:toolu_3",
      "user:result:toolu_3:note",
    ])
    // Resume 2 holds the request of resume 1 unchanged, as a prefix. The
    // prompt-cache marker moves to the last message, so it is left out.
    const noCache = (v: unknown): string =>
      JSON.stringify(v, (k, x: unknown) => (k === "cache" ? undefined : x))
    expect(noCache(resumed2?.slice(0, resumed1?.length ?? 0))).toBe(noCache(resumed1))
  }, 90000)
})
