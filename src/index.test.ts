/**
 * Tests for the `minimal-agent` bin (`src/index.ts`) and its `main()`
 * (`src/main.ts`).
 *
 * Two kinds of test, as the scaffold had. In-process calls of `main()` check
 * the parameter seams: injected argv, stderr, and exit. Spawns of the real
 * bin check the real process: `--help`, one `--prompt` turn over the test
 * transport, and one `--host-mode acp` handshake. The spawn tests that need
 * a provider or the ACP plugin use the sibling plugins checkout and skip
 * cleanly without it.
 *
 * @module index.test
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "./main.ts"
import { siblingPluginPresent } from "./test-utils/sibling-repo.ts"

const CLI_ROOT = join(import.meta.dir, "..")
const HAVE_PROVIDER = siblingPluginPresent("ma-llm-opencode-go-plugin")
const HAVE_ACP = HAVE_PROVIDER && siblingPluginPresent("ma-acp-plugin")

/** Thrown by the injected exit, so a test can see the exit code. */
class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`)
  }
}

const throwingExit = (code: number): never => {
  throw new ExitCalled(code)
}

/** Env for a spawned bin: test transport, a temp agent home, no network sync. */
function spawnEnv(home: string): Record<string, string | undefined> {
  return {
    ...process.env,
    NODE_ENV: "test",
    MINIMAL_AGENT_HOME: home,
    MINIMAL_AGENT_NO_PLUGIN_SYNC: "1",
    MINIMAL_AGENT_NO_BINARY_SETUP: "1",
    MINIMAL_AGENT_TEST_AUTH: "1",
    MINIMAL_AGENT_TRANSPORT: "test",
    MINIMAL_AGENT_TEST_RESPONSE: "PONG",
    // Same pin as e2e-smoke.test.ts: a registered provider and model that
    // decode the test transport.
    MINIMAL_AGENT_PROVIDER: "opencode-go",
    MINIMAL_AGENT_MODEL: "qwen3.7-plus",
  }
}

/** Spawn the real bin and collect its output. */
async function runBin(
  args: readonly string[],
  opts: { home?: string; stdin?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "ma-cli-index-"))
  try {
    const p = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
      cwd: CLI_ROOT,
      stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
      stdout: "pipe",
      stderr: "pipe",
      // Generous ceiling so the child is not killed under parallel test load.
      timeout: 30000,
      env: spawnEnv(home),
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    if (opts.home === undefined) rmSync(home, { recursive: true, force: true })
  }
}

describe("main() in process", () => {
  test("an argv error writes to the injected stderr and calls the injected exit", async () => {
    let stderr = ""
    const run = main({
      argv: ["—help"],
      env: {},
      cwd: CLI_ROOT,
      exit: throwingExit,
      stderr: { write: (s: string | Uint8Array) => ((stderr += String(s)), true) },
    })
    // The injected exit's throw passes through. main() does not report it
    // as a fatal error and does not turn it into code 1.
    await expect(run).rejects.toEqual(new ExitCalled(2))
    expect(stderr).toContain("non-ASCII dash")
  })
})

describe("the minimal-agent bin", () => {
  test("--help prints the real help and exits 0", async () => {
    const result = await runBin(["--help"])
    expect(result.exitCode).toBe(0)
    const plain = result.stdout.replace(/\u001b\[[0-9;]*m/g, "")
    expect(plain).toContain("  USAGE\n")
    expect(plain).toContain("--host-mode")
    expect(plain).not.toContain("scaffold")
  })

  test.skipIf(!HAVE_PROVIDER)("--prompt runs one turn over the test transport", async () => {
    const result = await runBin(["--skip-quota", "--prompt", "ping"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PONG")
  })

  test.skipIf(!HAVE_PROVIDER)(
    "a stream-json failure ends by itself with code 1 after the failure lines",
    async () => {
      const result = await runBin([
        "--resume",
        "00000000-no-such-session",
        "--output-format",
        "stream-json",
        "-p",
        "go",
      ])
      expect(result.exitCode).toBe(1)
      const lines = result.stdout.trim().split("\n")
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
      const types = lines.map((l) => (JSON.parse(l) as { type: string }).type)
      expect(types.slice(-2)).toEqual(["error", "run_finished"])
    },
  )

  test.skipIf(!HAVE_ACP)("--host-mode acp answers initialize with one JSON-RPC line", async () => {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    }
    const result = await runBin(["--host-mode", "acp"], { stdin: `${JSON.stringify(request)}\n` })
    expect(result.exitCode).toBe(0)
    const lines = result.stdout.split("\n").filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
    const reply = JSON.parse(lines[0] ?? "") as { jsonrpc: string; id: number; result?: unknown }
    expect(reply.jsonrpc).toBe("2.0")
    expect(reply.id).toBe(1)
    expect(reply.result).toBeDefined()
  })
})
