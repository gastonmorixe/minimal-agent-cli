/**
 * LIVE e2e: drives the real CLI against the real OpenCode Go gateway.
 *
 * Complements the plugin-level suite (`ma-llm-opencode-go-plugin/e2e/`): this
 * one exercises the whole host — argv parsing, provider boot, credential
 * resolution by name, network client, streaming render — rather than the
 * adapter in isolation.
 *
 * NOT RUN BY DEFAULT. `bun test` only discovers `*.test.*` / `*.spec.*`, so the
 * `.e2e.ts` suffix keeps this out. Opt in:
 *
 *   # from minimal-agent-cli
 *   MA_E2E_LIVE=1 MA_E2E_CREDENTIAL_NAME="opencode-console-oauth-2" bun test ./src/e2e/*.e2e.ts --timeout 180000
 *
 * SAFETY: the credential is resolved by the CLI itself via `--credential-name`;
 * this test never reads `auth.jsonc` and never prints a token. With the gate
 * off, everything skips.
 *
 * @module e2e/opencode-go-live.e2e
 */

import { describe, expect, it } from "bun:test"

import { siblingPluginPresent } from "../test-utils/sibling-repo.ts"

const LIVE = process.env.MA_E2E_LIVE === "1" || process.env.MA_E2E_LIVE === "true"
const CREDENTIAL_NAME = process.env.MA_E2E_CREDENTIAL_NAME ?? "opencode-console-oauth-2"
const MODEL = process.env.MA_E2E_MODEL ?? "deepseek-v4.1-flash"
const PROVIDER = "opencode-go"

const HAVE_PROVIDER = siblingPluginPresent("ma-llm-opencode-go-plugin")

const SKIP_REASON = !LIVE
  ? "set MA_E2E_LIVE=1 to run live CLI e2e"
  : !HAVE_PROVIDER
    ? "ma-llm-opencode-go-plugin is not checked out in the sibling plugins repo"
    : null

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  return new Response(stream).text()
}

/**
 * Run one prompt through the real CLI and return its output.
 *
 * Note the flags: `--credential-name` pins the operator's account, and the
 * `--no-*` switches strip the harness scaffolding so the run is a clean
 * single-turn measurement (the same shape used for the perf baseline in the
 * research folder).
 */
async function runCli(prompt: string, extraArgs: string[] = []) {
  const p = Bun.spawn(
    [
      "bun",
      "run",
      "src/index.ts",
      "--provider",
      PROVIDER,
      "--model",
      MODEL,
      "--credential-name",
      CREDENTIAL_NAME,
      "--effort",
      "low",
      "--no-plugin-prompts",
      "--no-system-instructions",
      "--no-agents-md",
      "--no-system-loop-safety",
      "--no-system-tool-output-conventions",
      "--no-color",
      ...extraArgs,
      prompt,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 170_000,
      env: {
        ...process.env,
        NODE_ENV: "test",
        // Deliberately NOT setting MINIMAL_AGENT_TEST_AUTH / _TRANSPORT=test:
        // this must hit the real gateway with the real credential.
      },
    },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    p.exited,
    readStream(p.stdout),
    readStream(p.stderr),
  ])
  return { exitCode, stdout, stderr }
}

describe.skipIf(SKIP_REASON !== null)("opencode-go live CLI e2e", () => {
  const T = { timeout: 180_000 }

  it("answers a trivial prompt end-to-end and exits 0", T, async () => {
    const run = await runCli("Reply with exactly the word: pong")
    if (run.exitCode !== 0) {
      // Surface stderr in the failure message — without it a live failure is
      // nearly undebuggable.
      throw new Error(`CLI exited ${run.exitCode}\nstderr:\n${run.stderr}\nstdout:\n${run.stdout}`)
    }
    expect(run.stdout.toLowerCase()).toContain("pong")
  })

  it("emits a stream-json transcript when asked (verifies SSE decoding live)", T, async () => {
    const run = await runCli("Say ok", ["--output-format", "stream-json"])
    if (run.exitCode !== 0) {
      throw new Error(`CLI exited ${run.exitCode}\nstderr:\n${run.stderr}`)
    }
    // Every line should be a JSON object; the stream must contain at least one
    // assistant/text event decoded from the live SSE frames.
    const lines = run.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    let parsed = 0
    let sawText = false
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        parsed++
        const s = JSON.stringify(obj).toLowerCase()
        if (s.includes("text") || s.includes("delta")) sawText = true
      } catch {
        // Non-JSON noise (banner, spinner residue) is tolerated; we only
        // require that real JSON events came through.
      }
    }
    expect(parsed).toBeGreaterThan(0)
    expect(sawText).toBe(true)
  })

  it("fails cleanly (not hangs) on an unknown credential name", T, async () => {
    // Guard-rail: a wrong credential must produce a fast, clear error. If this
    // ever hangs, the live path regressed into an interactive prompt.
    const p = Bun.spawn(
      [
        "bun",
        "run",
        "src/index.ts",
        "--provider",
        PROVIDER,
        "--model",
        MODEL,
        "--credential-name",
        "e2e-does-not-exist-credential",
        "--no-color",
        "Say ok",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
        env: { ...process.env, NODE_ENV: "test" },
      },
    )
    const [exitCode, , stderr] = await Promise.all([
      p.exited,
      readStream(p.stdout),
      readStream(p.stderr),
    ])
    expect(exitCode).not.toBe(0)
    expect(stderr.toLowerCase()).toMatch(/credential|unknown|not found/)
  })
})
