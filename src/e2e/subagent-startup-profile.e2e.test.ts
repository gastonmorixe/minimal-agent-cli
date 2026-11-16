/**
 * End-to-end: a worker child boots with the lead's startup settings
 * (SPEC 2026-11-15-subagent-inherit, T4, T5, T6, R11, section 5 precedence,
 * 6.3 fatal).
 *
 * Offline capture: every child runs with `--dry-run`. The dry-run plugin
 * builds the first model request, writes it as JSON to the file in
 * `MINIMAL_AGENT_DRY_RUN_OUT`, and halts the send. The lead runs use the
 * test transport (`MINIMAL_AGENT_TRANSPORT=test`). No real provider is
 * called.
 *
 * Flow: a real lead CLI boots with the flags under test in an isolated
 * `MINIMAL_AGENT_HOME` and writes `<sid>.profile.json`. A child then boots
 * with the worker-style argv from `buildSpawnPlan` (`--session-id`,
 * `--no-header`, `--mode`, `--output-format stream-json`,
 * `--startup-profile <path>`, `--disable-plugin intercom`, `--prompt`) and
 * the test reads its system prompt and tool list from the dump.
 *
 * @module e2e/subagent-startup-profile.e2e.test
 */

import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { siblingPluginPresent } from "../test-utils/sibling-repo.ts"
import { tempHomeSpawnEnv } from "../test-utils/temp-home-env.ts"

// Needs the opencode-go provider and the dry-run plugin from the sibling
// plugins repo. On a bare checkout the tests skip, like the other e2e files.
const HAVE_PLUGINS =
  siblingPluginPresent("ma-llm-opencode-go-plugin") &&
  siblingPluginPresent("ma-dry-run-plugin") &&
  siblingPluginPresent("ma-agents-md-plugin") &&
  siblingPluginPresent("ma-speak-plugin") &&
  siblingPluginPresent("ma-intercom-plugin")

const CLI_ROOT = join(import.meta.dir, "..", "..")
const ENTRY = join(CLI_ROOT, "src", "index.ts")
const TMP_ROOT = join(CLI_ROOT, "tmp")
mkdirSync(TMP_ROOT, { recursive: true })
const ROOT = mkdtempSync(join(TMP_ROOT, "e2e-subagent-profile-"))
const HOME_DIR = join(ROOT, "home")
const MA_HOME = join(HOME_DIR, ".minimal-agent")
const SESSIONS = join(MA_HOME, "sessions")
const WORK = join(ROOT, "work")
mkdirSync(WORK, { recursive: true })
mkdirSync(HOME_DIR, { recursive: true })

/** Unique text in the child cwd AGENTS.md. */
const AGENTS_MARKER = "AGENTSMD_MARKER_7f3c9b"
writeFileSync(join(WORK, "AGENTS.md"), `${AGENTS_MARKER}\n`)

/** Text from the default instructions section (core prompts/instructions.md). */
const INSTRUCTIONS_PROBE = "# Instructions (INS)"
/** Text from the default loop-safety section. */
const LOOP_SAFETY_PROBE = "Tool-use loop safety"
/** Text that only plugin prompts add (the `<ma::sys::...>` blocks). */
const PLUGIN_PROMPT_PROBE = "<ma::sys::"

const LEAD_SID = "a1a1a1a1-0000-4000-8000-000000000001"
const LEAD_DISABLE_SID = "a1a1a1a1-0000-4000-8000-000000000002"
const DISABLED_PLUGIN = "ma-speak"

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

let seq = 0

/** Child env: drop every inherited MINIMAL_AGENT_* key, then pin the test setup. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("MINIMAL_AGENT_")) base[k] = v
  }
  return {
    ...base,
    ...tempHomeSpawnEnv(),
    NODE_ENV: "test",
    HOME: HOME_DIR,
    MINIMAL_AGENT_HOME: MA_HOME,
    MINIMAL_AGENT_TEST_AUTH: "1",
    MINIMAL_AGENT_TRANSPORT: "test",
    MINIMAL_AGENT_TEST_RESPONSE: "PONG",
    MINIMAL_AGENT_PROVIDER: "opencode-go",
    MINIMAL_AGENT_MODEL: "qwen3.7-plus",
    ...extra,
  }
}

async function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", "run", ENTRY, "--skip-quota", ...args], {
    cwd: WORK,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30000,
    env: childEnv(extraEnv),
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

/** What the dry-run dump shows of the first request. */
interface Captured {
  readonly system: string
  readonly tools: string[]
  readonly messages: unknown[]
}

/** Boot a child with `--dry-run` and return its first request. */
async function captureChild(args: string[], extraEnv: Record<string, string> = {}) {
  seq++
  const out = join(ROOT, `dump-${seq}.json`)
  const run = await runCli(["--dry-run", ...args], { ...extraEnv, MINIMAL_AGENT_DRY_RUN_OUT: out })
  if (run.exitCode !== 0 || !existsSync(out)) {
    throw new Error(`child failed (exit ${run.exitCode}): ${run.stderr.slice(-2000)}`)
  }
  const dump = JSON.parse(readFileSync(out, "utf8")) as {
    system: unknown
    messages?: unknown[]
    request?: { tools?: Array<{ name: string }> }
  }
  const system =
    typeof dump.system === "string"
      ? dump.system
      : (dump.system as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n")
  return {
    system,
    tools: (dump.request?.tools ?? []).map((t) => t.name),
    messages: dump.messages ?? [],
  } satisfies Captured
}

/** The worker argv from buildSpawnPlan (spawn-plan.ts), without the prompt. */
function workerArgv(sid: string, profilePath: string | undefined): string[] {
  return [
    "--session-id",
    sid,
    "--no-header",
    "--mode",
    "none",
    "--output-format",
    "stream-json",
    ...(profilePath === undefined ? [] : ["--startup-profile", profilePath]),
    "--disable-plugin",
    "intercom",
    "--prompt",
    "do the work",
  ]
}

function childSid(): string {
  seq++
  return `c0c0c0c0-0000-4000-8000-${String(seq).padStart(12, "0")}`
}

/** Boot a real lead and return the path of the profile it wrote. */
async function bootLead(sid: string, flags: string[]): Promise<string> {
  const run = await runCli(["--session-id", sid, ...flags, "--prompt", "hello"])
  if (run.exitCode !== 0) throw new Error(`lead failed: ${run.stderr.slice(-2000)}`)
  const path = join(SESSIONS, `${sid}.profile.json`)
  expect(existsSync(path)).toBe(true)
  return path
}

const T4_LEAD_FLAGS = [
  "--no-system-instructions",
  "--no-system-loop-safety",
  "--no-system-tool-output-conventions",
  "--no-agents-md",
  "--no-plugin-prompts",
]

function expectInheritedOmits(c: Captured): void {
  expect(c.system).not.toContain(INSTRUCTIONS_PROBE)
  expect(c.system).not.toContain(LOOP_SAFETY_PROBE)
  expect(c.system).not.toContain(AGENTS_MARKER)
  expect(c.system).not.toContain(PLUGIN_PROMPT_PROBE)
}

function expectDefaults(c: Captured): void {
  expect(c.system).toContain(INSTRUCTIONS_PROBE)
  expect(c.system).toContain(LOOP_SAFETY_PROBE)
  expect(c.system).toContain(AGENTS_MARKER)
  expect(c.system).toContain(PLUGIN_PROMPT_PROBE)
}

describe.skipIf(!HAVE_PLUGINS)("subagent child boots with the lead startup profile (e2e)", () => {
  let t4Profile = ""
  let t5Profile = ""

  it("lead writes the profile with its final resolved values", async () => {
    t4Profile = await bootLead(LEAD_SID, T4_LEAD_FLAGS)
    const p = JSON.parse(readFileSync(t4Profile, "utf8")) as {
      systemPrompt: Record<string, { kind: string }>
      noAgentsMd: boolean
      pluginPrompts: { all: boolean }
    }
    expect(p.systemPrompt.instructions).toEqual({ kind: "omit" })
    expect(p.systemPrompt.loopSafety).toEqual({ kind: "omit" })
    expect(p.systemPrompt.toolOutputConventions).toEqual({ kind: "omit" })
    expect(p.noAgentsMd).toBe(true)
    expect(p.pluginPrompts.all).toBe(true)
  }, 60000)

  it("control: a child without the profile has every default section", async () => {
    expectDefaults(await captureChild(workerArgv(childSid(), undefined)))
  }, 60000)

  it("T4: a child with the profile lacks the omitted sections, AGENTS.md and plugin prompts", async () => {
    expectInheritedOmits(await captureChild(workerArgv(childSid(), t4Profile)))
  }, 60000)

  it("T6: a fork child (--resume <leadSid>) with the profile also lacks them", async () => {
    const c = await captureChild(["--resume", LEAD_SID, ...workerArgv(childSid(), t4Profile)])
    expectInheritedOmits(c)
    // The fork carries the lead transcript: the lead prompt is in the messages.
    expect(JSON.stringify(c.messages)).toContain("hello")
  }, 60000)

  it("R11: MINIMAL_AGENT_SUBAGENT_INHERIT=0 (no --startup-profile) acts like the control", async () => {
    const c = await captureChild(workerArgv(childSid(), undefined), {
      MINIMAL_AGENT_SUBAGENT_INHERIT: "0",
    })
    expectDefaults(c)
  }, 60000)

  it("precedence: the child's explicit --system-instructions beats the profile omit", async () => {
    const marker = "CHILD_EXPLICIT_INSTRUCTIONS_5d21"
    const c = await captureChild([
      "--system-instructions",
      marker,
      ...workerArgv(childSid(), t4Profile),
    ])
    expect(c.system).toContain(marker)
    // The other inherited omits still hold.
    expect(c.system).not.toContain(LOOP_SAFETY_PROBE)
    expect(c.system).not.toContain(AGENTS_MARKER)
  }, 60000)

  it("T5: lead --disable-plugin X; the child has X and intercom disabled", async () => {
    t5Profile = await bootLead(LEAD_DISABLE_SID, ["--disable-plugin", DISABLED_PLUGIN])
    const p = JSON.parse(readFileSync(t5Profile, "utf8")) as { plugins: { disable: string[] } }
    expect(p.plugins.disable).toContain(DISABLED_PLUGIN)

    const control = await captureChild(["--session-id", childSid(), "--prompt", "x"])
    expect(control.tools).toContain("Speak")
    expect(control.tools.some((t) => t.startsWith("Intercom"))).toBe(true)

    const child = await captureChild(workerArgv(childSid(), t5Profile))
    expect(child.tools.length).toBeGreaterThan(0)
    expect(child.tools).not.toContain("Speak")
    expect(child.tools.some((t) => t.startsWith("Intercom"))).toBe(false)
  }, 90000)

  it("fatal: a missing profile path exits 2 with `fatal: startup profile`", async () => {
    const missing = join(ROOT, "no-such.profile.json")
    const run = await runCli(workerArgv(childSid(), missing))
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain("fatal: startup profile")
    expect(run.stderr).toContain(missing)
  }, 60000)
})
