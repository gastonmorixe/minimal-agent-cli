/**
 * SPEC-ONESHOT R14/R15 (T14b): the REAL CLI process speaks Open Responses
 * over stdio. One OR request on stdin, the flags
 * `--input-format open-responses` and `--output-format open-responses`,
 * and the answer on stdout.
 *
 * No model call: the test transport (`MINIMAL_AGENT_TRANSPORT=test` +
 * `MINIMAL_AGENT_TEST_RESPONSE`) answers every request with the scripted
 * text. Provider/model pinning mirrors `output-format-g3.e2e.test.ts`.
 *
 * Checks:
 * - `stream: true`: SSE frames (`event:` + `data:` lines), sequence numbers
 *   in order, text deltas, terminal `response.completed`, exit 0.
 * - no `stream`: one JSON `response` object, status `completed`, exit 0.
 * - a schema mismatch (`text.format` json_schema, answer not JSON): status
 *   `completed` with `metadata.output_error`, exit 1 (both framings).
 * - a preflight failure (unknown provider): non-zero exit and no non-OR
 *   text on stdout.
 *
 * @module e2e/open-responses.e2e.test
 */

import { afterAll, describe, expect, it } from "bun:test"

import { isolatedCliEnv } from "../test-utils/isolated-cli-env.ts"
import { siblingPluginPresent } from "../test-utils/sibling-repo.ts"

const HAVE_PROVIDER = siblingPluginPresent("ma-llm-opencode-go-plugin")

// The child writes its session and logs under a temp agent home, never the
// real ~/.minimal-agent of the developer (see test-utils/isolated-cli-env.ts).
const ISO = isolatedCliEnv({ prefix: "ma-e2e-open-responses-home-" })
afterAll(() => ISO.cleanup())

const OR_ARGS = [
  "--bare",
  "--skip-quota",
  "--input-format",
  "open-responses",
  "--output-format",
  "open-responses",
]

interface CliRun {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  return new Response(stream).text()
}

async function runOrCli(
  body: object,
  response: string,
  env: Record<string, string> = {},
): Promise<CliRun> {
  const p = Bun.spawn(["bun", "src/index.ts", ...OR_ARGS], {
    stdin: new Blob([JSON.stringify(body)]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15000,
    env: {
      ...ISO.env,
      NODE_ENV: "test",
      MINIMAL_AGENT_TEST_AUTH: "1",
      MINIMAL_AGENT_TRANSPORT: "test",
      MINIMAL_AGENT_TEST_RESPONSE: response,
      MINIMAL_AGENT_PROVIDER: "opencode-go",
      MINIMAL_AGENT_MODEL: "qwen3.7-plus",
      ...env,
    },
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    p.exited,
    readStream(p.stdout),
    readStream(p.stderr),
  ])
  return { exitCode, stdout, stderr }
}

interface SseFrame {
  readonly event: string
  readonly data: Record<string, unknown>
}

/** Parse SSE frames. Throws when a frame is not `event:` + `data:` JSON. */
function parseSse(stdout: string): SseFrame[] {
  const blocks = stdout.split("\n\n").filter((b) => b.trim() !== "")
  return blocks.map((block) => {
    const lines = block.split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]?.startsWith("event: ")).toBe(true)
    expect(lines[1]?.startsWith("data: ")).toBe(true)
    const event = (lines[0] as string).slice("event: ".length)
    const data = JSON.parse((lines[1] as string).slice("data: ".length)) as Record<string, unknown>
    expect(data.type).toBe(event)
    return { event, data }
  })
}

const SCHEMA_FORMAT = {
  format: {
    type: "json_schema",
    name: "reply",
    schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
  },
}

describe.skipIf(!HAVE_PROVIDER)("open-responses at real CLI stdio", () => {
  it("stream true: SSE frames end in response.completed with the text", async () => {
    const run = await runOrCli({ input: "Say hi.", stream: true }, "hello there")
    expect(run.exitCode).toBe(0)
    const frames = parseSse(run.stdout)
    expect(frames[0]?.event).toBe("response.created")
    expect(frames.at(-1)?.event).toBe("response.completed")
    frames.forEach((f, i) => expect(f.data.sequence_number).toBe(i))
    const deltas = frames.filter((f) => f.event === "response.output_text.delta")
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.map((d) => String(d.data.delta)).join("")).toBe("hello there")
    const final = frames.at(-1)?.data.response as Record<string, unknown>
    expect(final.status).toBe("completed")
    expect(JSON.stringify(final.output)).toContain("hello there")
  })

  it("no stream: one JSON response object, status completed, with the text", async () => {
    const run = await runOrCli({ input: "Say hi." }, "hello there")
    expect(run.exitCode).toBe(0)
    expect(run.stdout.startsWith("event:")).toBe(false)
    const body = JSON.parse(run.stdout) as Record<string, unknown>
    expect(body.object).toBe("response")
    expect(body.status).toBe("completed")
    expect(body.error).toBeNull()
    const output = body.output as Array<{ content: Array<{ type: string; text: string }> }>
    expect(output[0]?.content[0]).toMatchObject({ type: "output_text", text: "hello there" })
  })

  it("no stream, schema mismatch: output_error in metadata, exit 1", async () => {
    const run = await runOrCli({ input: "Say hi.", text: SCHEMA_FORMAT }, "not json")
    expect(run.exitCode).toBe(1)
    const body = JSON.parse(run.stdout) as Record<string, unknown>
    expect(body.object).toBe("response")
    const metadata = body.metadata as Record<string, unknown>
    expect(String(metadata.output_error)).toContain("does not match schema")
  })

  it("stream true, schema mismatch: SSE ends in a terminal event, exit 1", async () => {
    const run = await runOrCli({ input: "Say hi.", stream: true, text: SCHEMA_FORMAT }, "not json")
    expect(run.exitCode).toBe(1)
    const frames = parseSse(run.stdout)
    expect(["response.completed", "response.failed"]).toContain(frames.at(-1)?.event ?? "")
    const final = frames.at(-1)?.data.response as Record<string, unknown>
    const metadata = final.metadata as Record<string, unknown>
    expect(String(metadata.output_error)).toContain("does not match schema")
  })

  it("preflight failure (unknown provider): non-zero exit, no non-OR stdout", async () => {
    // Boot fails before the run, so no OR body is written (stderr only).
    const run = await runOrCli({ input: "Say hi.", stream: true }, "x", {
      MINIMAL_AGENT_PROVIDER: "no-such-provider",
    })
    expect(run.exitCode).not.toBe(0)
    expect(run.stderr).toContain("unknown provider")
    if (run.stdout.trim() !== "") parseSse(run.stdout)
  })
})
