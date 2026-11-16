/**
 * `--input-format open-responses` (SPEC-ONESHOT R15): request parsing,
 * the argv mapping with flag precedence, the append merge with
 * `--append-system-prompt`, and the exit 2 paths (in process and through
 * the real entry point).
 *
 * @module oneshot/or-input.test
 */

import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"

import { normalizeArgs } from "../cli/cli-args.ts"
import { CliFlagError, parseCliOptions } from "../cli/parse-argv.ts"
import { isolatedCliEnv } from "../test-utils/isolated-cli-env.ts"
import { planOneShot } from "./oneshot-options.ts"
import { type OrRequest, parseOrRequest, planOrArgv, prepareOrInput } from "./or-input.ts"

/** A real request body from `@ai-sdk/open-responses` 2.0.79 (r14-proof/proof-output.txt line 3). */
const AI_SDK_BODY =
  '{"model":"fake-model","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Say hello"}]}],"instructions":"Be brief.","max_output_tokens":64,"temperature":0.2,"tool_choice":"auto"}'

/** `Output.object({schema, name: "weather"})` text field (proof-output.txt line 8). */
const WEATHER_TEXT = {
  format: {
    type: "json_schema",
    name: "weather",
    schema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { city: { type: "string" }, tempC: { type: "number" } },
      required: ["city", "tempC"],
      additionalProperties: false,
    },
    strict: true,
  },
}

function ok(json: string): OrRequest {
  const r = parseOrRequest(json)
  if (!r.ok) throw new Error(`expected ok, got ${r.message}`)
  return r
}

const NOOP_FORMATTER = (raw: string): string[] => [raw]

describe("parseOrRequest", () => {
  test("AI SDK request body maps to prompt, append, model, temperature", () => {
    const r = ok(AI_SDK_BODY)
    expect(r.prompt).toBe("Say hello")
    expect(r.appendSystemPrompt).toBe("Be brief.")
    expect(r.model).toBe("fake-model")
    expect(r.temperature).toBe(0.2)
    expect(r.stream).toBe(false)
    expect(r.outputSchema).toBeUndefined()
    // max_output_tokens warns. tool_choice "auto" is silent.
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain("max_output_tokens")
    expect(r.warnings.join("")).not.toContain("tool_choice")
  })

  test("string input is the prompt, stream true is kept", () => {
    const r = ok('{"input":"hi there","stream":true}')
    expect(r.prompt).toBe("hi there")
    expect(r.stream).toBe(true)
    expect(r.warnings).toEqual([])
  })

  test("several messages: blank lines, assistant prefix, system to append", () => {
    const r = ok(
      JSON.stringify({
        instructions: "Rule A.",
        input: [
          { type: "message", role: "developer", content: "Rule B." },
          { type: "message", role: "user", content: [{ type: "input_text", text: "Q1" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "A1" }] },
          { role: "user", content: "Q2" },
        ],
      }),
    )
    expect(r.prompt).toBe("Q1\n\nAssistant: A1\n\nQ2")
    expect(r.appendSystemPrompt).toBe("Rule A.\n\nRule B.")
  })

  test("image and file parts warn and are skipped", () => {
    const r = ok(
      JSON.stringify({
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "look" },
              { type: "input_image", image_url: "x" },
              { type: "input_file", file_data: "y" },
            ],
          },
        ],
      }),
    )
    expect(r.prompt).toBe("look")
    expect(r.warnings.some((l) => l.includes("input_image"))).toBe(true)
    expect(r.warnings.some((l) => l.includes("input_file"))).toBe(true)
  })

  test("json_schema: name goes to title when absent, strict kept", () => {
    const r = ok(JSON.stringify({ input: "x", text: WEATHER_TEXT }))
    expect(r.strict).toBe(true)
    expect((r.outputSchema as { title?: string }).title).toBe("weather")
    expect((r.outputSchema as { required?: string[] }).required).toEqual(["city", "tempC"])
  })

  test("json_schema: an existing title is kept, strict false gives no strict", () => {
    const text = {
      format: { type: "json_schema", name: "n", schema: { title: "Mine" }, strict: false },
    }
    const r = ok(JSON.stringify({ input: "x", text }))
    expect((r.outputSchema as { title?: string }).title).toBe("Mine")
    expect(r.strict).toBeUndefined()
  })

  test("json_object warns and runs as text", () => {
    const r = ok(JSON.stringify({ input: "x", text: { format: { type: "json_object" } } }))
    expect(r.outputSchema).toBeUndefined()
    expect(r.warnings.join("")).toContain("json_object")
  })

  test("reasoning.effort: none maps to low, max passes, bad value warns", () => {
    expect(ok('{"input":"x","reasoning":{"effort":"none"}}').effort).toBe("low")
    expect(ok('{"input":"x","reasoning":{"effort":"max"}}').effort).toBe("max")
    const bad = ok('{"input":"x","reasoning":{"effort":"ultra"}}')
    expect(bad.effort).toBeUndefined()
    expect(bad.warnings.join("")).toContain("ultra")
  })

  test("unsupported fields warn once each, silent fields stay silent", () => {
    const r = ok(
      JSON.stringify({
        input: "x",
        top_p: 0.9,
        previous_response_id: "resp_1",
        presence_penalty: 1,
        tools: [{ type: "function", name: "f" }],
        tool_choice: "auto",
        store: false,
        metadata: { a: "b" },
        user: "u",
      }),
    )
    const all = r.warnings.join("")
    expect(all).toContain("top_p")
    expect(all).toContain("previous_response_id")
    expect(all).toContain("presence_penalty")
    for (const silent of ["tools", "tool_choice", "store", "metadata", '"user"']) {
      expect(all).not.toContain(silent)
    }
    expect(r.warnings).toHaveLength(3)
  })

  test("bad JSON, non-object, missing input, empty input: error", () => {
    for (const body of ["{nope", "[1]", '{"model":"m"}', '{"input":""}', '{"input":[]}']) {
      const r = parseOrRequest(body)
      expect(r.ok).toBe(false)
    }
    const bad = parseOrRequest("{nope")
    expect(!bad.ok && bad.message).toContain("not valid JSON")
  })
})

describe("planOrArgv", () => {
  test("injects flags and the stdin sentinel", () => {
    const req = ok(JSON.stringify({ ...JSON.parse(AI_SDK_BODY), text: WEATHER_TEXT }))
    const plan = planOrArgv(["--input-format", "open-responses"], req)
    const args = normalizeArgs([...plan.argv])
    const opts = parseCliOptions(args, {}, {}, NOOP_FORMATTER)
    expect(opts.inputFormat).toBe("open-responses")
    expect(opts.model).toBe("fake-model")
    expect(opts.temperature).toBe(0.2)
    expect(opts.strict).toBe(true)
    expect(JSON.parse(opts.outputSchemaPath ?? "{}").title).toBe("weather")
    expect(args).toContain("-")
    expect(plan.notes).toEqual([])
  })

  test("a CLI flag wins over the request value, with a note", () => {
    const req = ok(
      '{"input":"x","model":"req-model","temperature":0.2,"reasoning":{"effort":"high"}}',
    )
    const plan = planOrArgv(
      [
        "--model",
        "cli-model",
        "--temperature=0.9",
        "--effort",
        "low",
        "--input-format",
        "open-responses",
      ],
      req,
    )
    const opts = parseCliOptions(normalizeArgs([...plan.argv]), {}, {}, NOOP_FORMATTER)
    expect(opts.model).toBe("cli-model")
    expect(opts.temperature).toBe(0.9)
    expect(opts.effort).toBe("low")
    expect(plan.notes).toHaveLength(3)
    expect(plan.notes[0]).toContain("--model flag wins")
  })
})

describe("append merge (planOneShot)", () => {
  const caps = { appendSystemPrompt: true, temperature: true, strict: true }
  const flags = {
    outputSchemaArg: undefined,
    strict: false,
    appendSystemPrompt: "Flag text.",
    appendSystemPromptFile: undefined,
    temperature: undefined,
  }

  test("flag text first, then the request instructions, blank line between", () => {
    const plan = planOneShot({
      flags: { ...flags, orAppendSystemPrompt: "Be brief." },
      capabilities: caps,
      fullOverrideActive: false,
      readFile: () => "",
    })
    expect(plan.ok && plan.appendSystemPrompt).toBe("Flag text.\n\nBe brief.")
  })

  test("request instructions alone", () => {
    const plan = planOneShot({
      flags: { ...flags, appendSystemPrompt: undefined, orAppendSystemPrompt: "Be brief." },
      capabilities: caps,
      fullOverrideActive: false,
      readFile: () => "",
    })
    expect(plan.ok && plan.appendSystemPrompt).toBe("Be brief.")
  })
})

/** An in-memory stdin. */
async function* stdinOf(text: string): AsyncIterable<string> {
  yield text
}

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

function io(argv: string[], stdin: string) {
  const err: string[] = []
  return {
    err,
    io: {
      argv,
      stdin: stdinOf(stdin),
      stderr: { write: (s: string) => err.push(s) },
      exit: (code: number): never => {
        throw new Exit(code)
      },
    },
  }
}

describe("prepareOrInput (wiring)", () => {
  test("text input format: argv unchanged, stdin not read", async () => {
    const t = io(["-p", "hi"], "not json")
    const r = await prepareOrInput(t.io)
    expect(r.argv).toEqual(["-p", "hi"])
    expect(r.prompt).toBeUndefined()
    expect(r.stream).toBe(false)
    expect(r.withAppend({ a: 1 })).toEqual({ a: 1 })
  })

  test("open-responses: prompt, argv, warnings, append for the one-shot setup", async () => {
    const t = io(["--input-format", "open-responses", "--bare"], AI_SDK_BODY)
    const r = await prepareOrInput(t.io)
    expect(r.prompt).toBe("Say hello")
    expect(r.argv).toEqual([
      "--input-format",
      "open-responses",
      "--bare",
      "--model",
      "fake-model",
      "--temperature",
      "0.2",
      "-",
    ])
    expect(r.withAppend({ a: 1 })).toEqual({ a: 1, orAppendSystemPrompt: "Be brief." })
    expect(t.err.join("")).toContain("max_output_tokens")
  })

  test("open-responses stream true: withAppend carries orStream", async () => {
    const t = io(["--input-format", "open-responses"], '{"input":"hi","stream":true}')
    const r = await prepareOrInput(t.io)
    expect(r.stream).toBe(true)
    expect(r.withAppend({ a: 1 })).toEqual({ a: 1, orStream: true })
  })

  test("invalid JSON: exit 2", async () => {
    const t = io(["--input-format", "open-responses"], "{nope")
    await expect(prepareOrInput(t.io)).rejects.toEqual(new Exit(2))
    expect(t.err.join("")).toContain("not valid JSON")
  })

  test("-p or a positional prompt: exit 2", async () => {
    for (const argv of [
      ["--input-format", "open-responses", "-p", "x"],
      ["--input-format=open-responses", "hello"],
    ]) {
      const t = io(argv, AI_SDK_BODY)
      await expect(prepareOrInput(t.io)).rejects.toEqual(new Exit(2))
      expect(t.err.join("")).toContain("the prompt comes from the request on stdin")
    }
  })

  test("bad --input-format value is a usage error in parseCliOptions", () => {
    expect(() => parseCliOptions(["--input-format", "xml"], {}, {}, NOOP_FORMATTER)).toThrow(
      CliFlagError,
    )
  })
})

describe("entry point (subprocess)", () => {
  const entry = join(import.meta.dir, "..", "index.ts")
  // A temp agent home, never the real ~/.minimal-agent of the developer.
  const iso = isolatedCliEnv({ prefix: "ma-or-input-home-" })
  afterAll(() => iso.cleanup())

  async function run(argv: string[], stdin: string) {
    const proc = Bun.spawn(["bun", entry, ...argv], {
      stdin: new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
      env: iso.env,
    })
    const code = await proc.exited
    return { code, stderr: await new Response(proc.stderr).text() }
  }

  test("invalid JSON on stdin exits 2", async () => {
    const r = await run(["--input-format", "open-responses"], "{nope")
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("not valid JSON")
  })

  test("-p with open-responses exits 2", async () => {
    const r = await run(["--input-format", "open-responses", "-p", "x"], AI_SDK_BODY)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("the prompt comes from the request on stdin")
  })
})
