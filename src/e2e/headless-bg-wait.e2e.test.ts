/**
 * A headless run must not end its turn while its own background job runs
 * (ma-background `turn.willStop` hook, plan `.research/bg-exit-plan.md`).
 *
 * The test spawns the REAL CLI (`src/index.ts`) with `-p` and
 * `--output-format stream-json`, the scripted fixture provider
 * (`fixtures/ma-llm-bg-wait-fixture-plugin`), the text stub plugin and the
 * real ma-background plugin of the sibling checkout (skip when absent).
 *
 * 1. Round 1 starts `BackgroundRun`. Round 2 answers "I wait." and the turn
 *    tries to end. The hook waits for the job, then halts with the digest.
 *    Round 3 reads the log, round 4 gives the final text. The result has the
 *    job output, the exit code is 0, and the job exited 0 (it was not
 *    stopped by "harness exited").
 * 2. Negative control: with `MINIMAL_AGENT_BG_HEADLESS_WAIT=0` the turn ends
 *    after "I wait.", so the rounds are only run/wait and the result has no
 *    job output. (In this test the CLI process stays alive while the runner
 *    pipe is open, so the job itself can still exit 0. The proof is that the
 *    model never reads the output.)
 * 3. A worker run (`MINIMAL_AGENT_WRAP_UP_TOOLS`) gets SIGTERM while the hook
 *    waits: the process exits 143 at once (the turn signal ends the hook, so
 *    no live handle keeps the process), and the job is stopped.
 * 4. A plain `-p` run (no wrap-up owner of SIGTERM) gets SIGTERM while the
 *    hook waits: the process ends by the signal, and the job is stopped.
 *
 * @module e2e/headless-bg-wait.e2e.test
 */

import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { join } from "node:path"

import { SIBLING_REPO_ROOT, siblingPluginPresent } from "../test-utils/sibling-repo.ts"
import { tempHomeSpawnEnv } from "../test-utils/temp-home-env.ts"

const HAVE_BG = siblingPluginPresent("ma-background-plugin")
if (!HAVE_BG) {
  const msg = `headless-bg-wait: ma-background-plugin not found at ${SIBLING_REPO_ROOT}`
  // CI must not skip this suite with no message.
  if (process.env.CI) throw new Error(`${msg} (CI is set)`)
  console.warn(`skip: ${msg}`)
}
const CLI_ROOT = join(import.meta.dir, "..", "..")
const TMP_ROOT = join(CLI_ROOT, "tmp")
mkdirSync(TMP_ROOT, { recursive: true })
const HOME_DIR = mkdtempSync(join(TMP_ROOT, "headless-bg-wait-"))
const PLUGINS = join(HOME_DIR, "plugins")
mkdirSync(PLUGINS)
for (const [name, dir] of [
  [
    "ma-llm-bg-wait-fixture-plugin",
    join(import.meta.dir, "fixtures", "ma-llm-bg-wait-fixture-plugin"),
  ],
  [
    "ma-text-stub-fixture-plugin",
    join(CLI_ROOT, "src", "startup", "fixtures", "plugins", "ma-text-stub-fixture-plugin"),
  ],
  ["ma-background-plugin", join(SIBLING_REPO_ROOT, "ma-background-plugin")],
] as const) {
  if (existsSync(dir)) symlinkSync(dir, join(PLUGINS, name))
}

afterAll(() => {
  rmSync(HOME_DIR, { recursive: true, force: true })
})

interface Spawned {
  readonly p: Bun.Subprocess<"ignore", "pipe", "pipe">
  readonly stdout: Promise<string>
  readonly stderr: Promise<string>
  readonly log: string
  readonly sid: string
}

function spawnCli(name: string, sid: string, command: string, extra: Record<string, string> = {}) {
  const log = join(HOME_DIR, `${name}.rounds.log`)
  const p = Bun.spawn(
    [
      "bun",
      "src/index.ts",
      "--skip-quota",
      "--session-id",
      sid,
      "--output-format",
      "stream-json",
      "-p",
      "go",
    ],
    {
      cwd: CLI_ROOT,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      env: {
        ...parentEnv(),
        ...tempHomeSpawnEnv(),
        NODE_ENV: "test",
        MINIMAL_AGENT_TEST_AUTH: "1",
        MINIMAL_AGENT_PROVIDER: "bg-wait-fixture",
        MINIMAL_AGENT_MODEL: "bg-wait-fixture-model",
        MINIMAL_AGENT_PLUGIN_SIBLINGS: PLUGINS,
        MINIMAL_AGENT_NO_PLUGIN_SYNC: "1",
        MINIMAL_AGENT_NO_LIVE_AREA: "1",
        HOME: HOME_DIR,
        MINIMAL_AGENT_HOME: join(HOME_DIR, ".minimal-agent"),
        BG_TEST_LOG: log,
        BG_TEST_CMD: command,
        ...extra,
      },
    },
  )
  return {
    p,
    stdout: new Response(p.stdout).text(),
    stderr: new Response(p.stderr).text(),
    log,
    sid,
  } satisfies Spawned
}

/** Exact env keys that the child must not get from the test process. */
const DROPPED_KEYS: ReadonlySet<string> = new Set([
  "MINIMAL_AGENT_WRAP_UP_TOOLS",
  "MINIMAL_AGENT_DISABLE_BGJOBS",
  "MINIMAL_AGENT_LEAD_PID",
  "MINIMAL_AGENT_SESSION_ID",
])
/** Env key prefixes that the child must not get from the test process. */
const DROPPED_PREFIXES = ["MINIMAL_AGENT_SUBAGENT_", "MINIMAL_AGENT_BG_"] as const

/**
 * The env of the test process without the keys that change the result: the
 * worker keys (run mode, budget), the background-job keys (opt out, max
 * wait) and the session keys of a parent agent.
 */
function parentEnv(
  src: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(src)) {
    if (DROPPED_KEYS.has(k) || DROPPED_PREFIXES.some((p) => k.startsWith(p))) continue
    env[k] = v
  }
  return env
}

function rounds(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
}

function sidecar(sid: string, id: string): Record<string, unknown> | undefined {
  const path = join(HOME_DIR, ".minimal-agent", "sessions", `${sid}.bgjobs`, `${id}.status.json`)
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await Bun.sleep(50)
  }
  return pred()
}

describe("parentEnv", () => {
  it("drops the worker, background-job and parent session keys", () => {
    const env = parentEnv({
      PATH: "/bin",
      MINIMAL_AGENT_SUBAGENT_ID: "A1",
      MINIMAL_AGENT_WRAP_UP_TOOLS: "Report",
      MINIMAL_AGENT_BG_HEADLESS_WAIT: "0",
      MINIMAL_AGENT_BG_HEADLESS_WAIT_MS: "1",
      MINIMAL_AGENT_DISABLE_BGJOBS: "1",
      MINIMAL_AGENT_LEAD_PID: "1",
      MINIMAL_AGENT_SESSION_ID: "s",
      MINIMAL_AGENT_HOME: "/h",
    })
    expect(env).toEqual({ PATH: "/bin", MINIMAL_AGENT_HOME: "/h" })
  })
})

describe.skipIf(!HAVE_BG)("headless run waits for its background job", () => {
  it("the turn continues after the job, and the result has the job output", async () => {
    const sid = "6b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e"
    // `$((40+2))`: the marker DONE-42 is only in the job output, not in the input.
    const run = spawnCli("ok", sid, "sleep 1; echo DONE-$((40+2))")
    const [exitCode, stdout, stderr] = await Promise.all([run.p.exited, run.stdout, run.stderr])
    expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(rounds(run.log)).toEqual(["run", "wait", "logs", "final"])
    expect(stdout).toContain("RESULT DONE-42")
    const status = sidecar(sid, "j1")
    expect(status?.phase).toBe("exited")
    expect(status?.exitCode).toBe(0)
    expect(JSON.stringify(status)).not.toContain("harness exited")
  }, 60_000)

  it("negative control: with the wait off, the turn ends before the job and the model never reads it", async () => {
    const sid = "8d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a"
    const run = spawnCli("nowait", sid, "sleep 1; echo DONE-$((40+2))", {
      MINIMAL_AGENT_BG_HEADLESS_WAIT: "0",
    })
    const [exitCode, stdout] = await Promise.all([run.p.exited, run.stdout])
    expect(exitCode).toBe(0)
    // The turn ended after "I wait.": no halt note, no BackgroundLogs round.
    expect(rounds(run.log)).toEqual(["run", "wait"])
    expect(stdout).not.toContain("RESULT DONE-42")
    expect(stdout).toContain("I wait.")
  }, 60_000)

  it("SIGTERM while the hook waits in a worker run: exit 143 at once, and the job is stopped", async () => {
    const sid = "7c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
    const run = spawnCli("sigterm", sid, "sleep 30; echo LATE", {
      MINIMAL_AGENT_WRAP_UP_TOOLS: "Report",
    })
    expect(await waitForHookWait(run)).toBe(true)
    const t0 = Date.now()
    run.p.kill("SIGTERM")
    const [exitCode, stderr] = await Promise.all([run.p.exited, run.stderr])
    const elapsed = Date.now() - t0
    // No live handle: the wrap-up does not need its 2 s forced exit.
    expect(stderr).not.toContain("a live handle kept the process")
    expect(elapsed).toBeLessThan(1500)
    expect(exitCode).toBe(143)
    // The runner sees the harness exit and stops the job.
    expect(await waitFor(() => sidecar(sid, "j1")?.phase === "stopped", 10_000)).toBe(true)
    expect(rounds(run.log)).not.toContain("logs")
  }, 60_000)

  it("SIGTERM while the hook waits in a plain -p run: the signal ends the process", async () => {
    const sid = "9e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b"
    const run = spawnCli("plain-sigterm", sid, "sleep 30; echo LATE")
    expect(await waitForHookWait(run)).toBe(true)
    run.p.kill("SIGTERM")
    const exitCode = await run.p.exited
    // The default action of the raised signal, or the file-lock fan-out exit 143.
    expect(run.p.signalCode === "SIGTERM" || exitCode === 143).toBe(true)
    expect(await waitFor(() => sidecar(sid, "j1")?.phase === "stopped", 10_000)).toBe(true)
    expect(rounds(run.log)).not.toContain("logs")
  }, 60_000)
})

/**
 * Wait until the hook waits: round "wait" ended, and the job runs. The hook
 * then polls each second. A short pause gives the hook time to start after
 * the round.
 */
async function waitForHookWait(run: Spawned): Promise<boolean> {
  const ok = await waitFor(
    () => rounds(run.log).includes("wait") && sidecar(run.sid, "j1")?.phase === "running",
    30_000,
  )
  await Bun.sleep(500)
  return ok
}
