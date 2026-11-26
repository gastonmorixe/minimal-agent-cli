import { afterAll, describe, expect, it } from "bun:test"
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

  it("shows the selected provider's model catalog for an unknown model", async () => {
    const run = await runStartup("--provider", "openai", "--model", "idsf")
    expect(run.code).toBe(1)
    expect(run.stdout).toBe("")
    expect(run.stderr).toBe(
      'fatal: unknown model "idsf" for provider "openai"\n  List models: minimal-agent providers models openai\n',
    )
  })
})
