import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isolatedCliEnv } from "../test-utils/isolated-cli-env.ts"

const iso = isolatedCliEnv({ prefix: "ma-e2e-startup-errors-" })
afterAll(() => iso.cleanup())

async function runStartup(...args: string[]) {
  const child = Bun.spawn(["bun", "src/index.ts", "--bare", "--skip-quota", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
    env: { ...iso.env, MINIMAL_AGENT_HEADER: "1", NO_COLOR: "1" },
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

describe("startup errors", () => {
  it("shows a provider typo and next step without printing a session banner", async () => {
    const run = await runStartup("--provider", "anthropica", "--model", "some-model")
    expect(run.code).toBe(1)
    expect(run.stdout).toBe("")
    expect(run.stderr).toBe(
      'fatal: unknown provider "anthropica"\n  Did you mean "anthropic"?\n  List providers: minimal-agent providers\n',
    )
  })

  it("shows where to find model ids when --provider has no model", async () => {
    const run = await runStartup("--provider", "openai")
    expect(run.code).toBe(1)
    expect(run.stdout).toBe("")
    expect(run.stderr).toBe(
      'fatal: provider "openai" requires an explicit model\n  Add --model <id> to your command.\n  List models: minimal-agent providers models openai\n',
    )
  })

  it("names the flag when its value is missing", async () => {
    const run = await runStartup("--provider", "openai", "--model")
    expect(run.code).toBe(2)
    expect(run.stdout).toBe("")
    expect(run.stderr).toBe("fatal: --model requires a value.\n")
  })

  it("shows the failed credential and gives the selected provider's sign-in command", async () => {
    const run = await runStartup(
      "--provider",
      "openai",
      "--model",
      "gpt-4.1",
      "--credential-name",
      "missing",
    )
    expect(run.code).toBe(1)
    expect(run.stdout).toBe("")
    expect(run.stderr).toBe(
      'fatal: no usable credential "missing" for provider "openai"\n  Clear the credential name to use the default.\n  Sign in: minimal-agent provider openai login\n',
    )
  })

  it("stream-json: the error line names the missing credential, as stderr does", async () => {
    const run = await runStartup(
      "--provider",
      "openai",
      "--model",
      "gpt-4.1",
      "--credential-name",
      "missing",
      "--output-format",
      "stream-json",
      "--prompt",
      "hi",
    )
    expect(run.code).toBe(1)
    expect(run.stderr.split("\n")[0]).toBe(
      'fatal: no usable credential "missing" for provider "openai"',
    )
    const lines = run.stdout
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const error = lines.find((l) => l.type === "error")
    expect(error?.message).toBe('no usable credential "missing" for provider "openai"')
    expect(lines.at(-1)).toMatchObject({ type: "run_finished", outcome: "failed" })
  })

  it("stream-json: a saved credential of another name is not reported as no credentials", async () => {
    // One saved openai API key named "work". The run asks for "missing".
    const store = isolatedCliEnv({ prefix: "ma-e2e-startup-cred-" })
    try {
      mkdirSync(store.agentHome, { recursive: true })
      const now = new Date(0).toISOString()
      writeFileSync(
        join(store.agentHome, "auth.jsonc"),
        JSON.stringify({
          version: 1,
          entries: [
            {
              id: "openai-api-key",
              name: "work",
              secrets: { tokenType: "api-key", apiKey: "sk-test-not-real" },
              createdAt: now,
              updatedAt: now,
            },
          ],
        }),
      )
      const child = Bun.spawn(
        [
          "bun",
          "src/index.ts",
          "--bare",
          "--skip-quota",
          "--provider",
          "openai",
          "--model",
          "gpt-4.1",
          "--credential-name",
          "missing",
          "--output-format",
          "stream-json",
          "--prompt",
          "hi",
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 15_000,
          env: { ...store.env, MINIMAL_AGENT_HEADER: "1", NO_COLOR: "1" },
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code).toBe(1)
      expect(stderr).toBe(
        'fatal: no usable credential "missing" for provider "openai"\n' +
          "  Check credentials: minimal-agent auth-status\n" +
          "  Clear the credential name to use the default.\n" +
          "  Or select a saved name with --credential-name <name>.\n",
      )
      expect(stdout).toContain('no usable credential \\"missing\\" for provider \\"openai\\"')
      expect(stdout).not.toContain("No provider credentials found")
    } finally {
      store.cleanup()
    }
  })

  it("shows the selected provider's model catalog for an unknown model", async () => {
    const run = await runStartup("--provider", "openai", "--model", "idsf")
    expect(run.code).toBe(1)
    expect(run.stdout).toBe("")
    expect(run.stderr).toBe(
      'fatal: unknown model "idsf" for provider "openai"\n  List models: minimal-agent providers models openai\n',
    )
  })
})
