/**
 * Tests for the one-shot option plan (SPEC-ONESHOT R6-R9) and the
 * feature-detect path for an older core (risk K1).
 *
 * @module oneshot/oneshot-options.test
 */

import { describe, expect, test } from "bun:test"

import { withAppendContributor } from "../interactive-session.ts"
import { agentCoreOf, armOneShotRun } from "./arm-run.ts"
import {
  detectOneShotCapabilities,
  isFullOverrideActive,
  isInlineSchema,
  type OneShotCapabilities,
  type OneShotFlags,
  planOneShot,
  setupOneShot,
} from "./oneshot-options.ts"

const ALL: OneShotCapabilities = { appendSystemPrompt: true, temperature: true, strict: true }
const NONE: OneShotCapabilities = { appendSystemPrompt: false, temperature: false, strict: false }
const NO_FLAGS: OneShotFlags = {
  outputSchemaArg: undefined,
  strict: false,
  appendSystemPrompt: undefined,
  appendSystemPromptFile: undefined,
  temperature: undefined,
}

function fakeFs(files: Record<string, string>): (path: string) => string {
  return (path) => {
    const body = files[path]
    if (body === undefined) throw new Error(`ENOENT: no such file, open '${path}'`)
    return body
  }
}

function plan(
  flags: Partial<OneShotFlags>,
  opts: {
    caps?: OneShotCapabilities
    files?: Record<string, string>
    full?: boolean
  } = {},
) {
  return planOneShot({
    flags: { ...NO_FLAGS, ...flags },
    capabilities: opts.caps ?? ALL,
    fullOverrideActive: opts.full ?? false,
    readFile: fakeFs(opts.files ?? {}),
  })
}

describe("--output-schema inline vs file (R7)", () => {
  test("isInlineSchema: a leading `{` after trim", () => {
    expect(isInlineSchema('  {"type":"object"}')).toBe(true)
    expect(isInlineSchema("schema.json")).toBe(false)
  })

  test("inline JSON is parsed, no file read", () => {
    const r = plan({ outputSchemaArg: ' {"type":"object"} ' })
    expect(r.ok && r.outputSchema).toEqual({ type: "object" })
  })

  test("a path is read as a file", () => {
    const r = plan(
      { outputSchemaArg: "s.json" },
      { files: { "s.json": '{"type":"object","required":["a"]}' } },
    )
    expect(r.ok && r.outputSchema).toEqual({ type: "object", required: ["a"] })
  })

  test("bad inline JSON → exit 2 with a clear message", () => {
    const r = plan({ outputSchemaArg: "{not json" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.exitCode).toBe(2)
      expect(r.message).toContain("--output-schema (inline JSON)")
      expect(r.message).toContain("not valid JSON")
    }
  })

  test("a missing schema file keeps the old exit 1", () => {
    const r = plan({ outputSchemaArg: "missing.json" })
    expect(!r.ok && r.exitCode).toBe(1)
  })
})

describe("--strict (R6)", () => {
  test("with a schema → strict run option", () => {
    const r = plan({ strict: true, outputSchemaArg: "{}" })
    expect(r.ok && r.runOptions).toEqual({ outputStrict: true })
    expect(r.ok && r.notes).toEqual([])
  })

  test("without a schema → one note, no option, run goes on", () => {
    const r = plan({ strict: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.runOptions).toEqual({})
      expect(r.notes).toEqual([
        "[minimal-agent] note: --strict has no effect without --output-schema\n",
      ])
    }
  })
})

describe("--append-system-prompt(-file) (R8)", () => {
  test("text and file join with a blank line, text first", () => {
    const r = plan(
      { appendSystemPrompt: "Be short.", appendSystemPromptFile: "x.md" },
      { files: { "x.md": "Use JSON." } },
    )
    expect(r.ok && r.appendSystemPrompt).toBe("Be short.\n\nUse JSON.")
  })

  test("file only", () => {
    const r = plan({ appendSystemPromptFile: "x.md" }, { files: { "x.md": "Use JSON." } })
    expect(r.ok && r.appendSystemPrompt).toBe("Use JSON.")
  })

  test("a missing file → exit 2", () => {
    const r = plan({ appendSystemPromptFile: "nope.md" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.exitCode).toBe(2)
      expect(r.message).toContain('--append-system-prompt-file: cannot read "nope.md"')
    }
  })

  test("with a full --system-prompt override → one warn, append dropped", () => {
    const r = plan({ appendSystemPrompt: "Be short." }, { full: true })
    expect(r.ok && r.appendSystemPrompt).toBeUndefined()
    expect(r.ok && r.notes).toEqual([
      "[minimal-agent] warn: --append-system-prompt ignored, a full --system-prompt override is active\n",
    ])
  })

  test("isFullOverrideActive: replace and omit count, default does not", () => {
    expect(isFullOverrideActive(undefined)).toBe(false)
    expect(isFullOverrideActive({})).toBe(false)
    expect(isFullOverrideActive({ full: { kind: "default" } })).toBe(false)
    expect(isFullOverrideActive({ full: { kind: "replace" } })).toBe(true)
    expect(isFullOverrideActive({ full: { kind: "omit" } })).toBe(true)
  })

  test("InteractiveSession route: the append becomes a second contributor", () => {
    const base = { name: "plugins" }
    expect(withAppendContributor(base, {})).toEqual([base])
    expect(withAppendContributor(base, { appendSystemPrompt: "   " })).toEqual([base])
    const list = withAppendContributor(base, { appendSystemPrompt: " Be short. " })
    expect(list).toHaveLength(2)
    const extra = list[1] as { afterInstructionsBlocks: () => unknown }
    expect(extra.afterInstructionsBlocks()).toEqual([{ type: "text", text: "Be short." }])
  })
})

describe("--temperature (R9)", () => {
  test("a run option when the core supports it", () => {
    const r = plan({ temperature: 0.3 })
    expect(r.ok && r.runOptions).toEqual({ temperature: 0.3 })
  })
})

describe("feature detect (K1): an older core", () => {
  test("every unsupported feature → one warn each, no throw, no value", () => {
    const r = plan(
      { temperature: 0.3, strict: true, outputSchemaArg: "{}", appendSystemPrompt: "x" },
      { caps: NONE },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.appendSystemPrompt).toBeUndefined()
      expect(r.runOptions).toEqual({})
      expect(r.notes).toEqual([
        "[minimal-agent] warn: this core does not support --append-system-prompt; running without it\n",
        "[minimal-agent] warn: this core does not support --strict; running without it\n",
        "[minimal-agent] warn: this core does not support --temperature; running without it\n",
      ])
    }
  })

  test("detectOneShotCapabilities never throws and gives booleans", () => {
    const caps = detectOneShotCapabilities()
    for (const v of Object.values(caps)) expect(typeof v).toBe("boolean")
  })

  test("armOneShotRun: a core with no setters → nothing called, no throw", () => {
    expect(armOneShotRun({}, { temperature: 0.5, outputStrict: true })).toEqual([])
    expect(armOneShotRun(undefined, { temperature: 0.5 })).toEqual([])
  })

  test("armOneShotRun: a core with setters → both armed with the values", () => {
    const calls: Array<[string, unknown]> = []
    const core = {
      setNextRunTemperature(t: unknown) {
        calls.push(["temperature", t])
      },
      setNextRunOutputStrict(s: unknown) {
        calls.push(["strict", s])
      },
    }
    expect(armOneShotRun(core, { temperature: 0.5, outputStrict: true })).toEqual([
      "setNextRunTemperature",
      "setNextRunOutputStrict",
    ])
    expect(calls).toEqual([
      ["temperature", 0.5],
      ["strict", true],
    ])
    expect(armOneShotRun(core, {})).toEqual([])
  })

  test("agentCoreOf: reads agentCore(), else undefined", () => {
    const core = {}
    expect(agentCoreOf({ agentCore: () => core })).toBe(core)
    expect(agentCoreOf({})).toBeUndefined()
    expect(
      agentCoreOf({
        agentCore: () => {
          throw new Error("closed")
        },
      }),
    ).toBeUndefined()
  })
})

describe("setupOneShot (entry-point glue)", () => {
  const OPTS = {
    outputSchemaPath: undefined,
    strict: false,
    appendSystemPrompt: undefined,
    appendSystemPromptFile: undefined,
    temperature: undefined,
  }
  const throwExit = ((code: number) => {
    throw new Error(`exit ${code}`)
  }) as (code: number) => never

  test("bad inline JSON → message on stderr and exit 2", () => {
    const err: string[] = []
    expect(() =>
      setupOneShot(
        { ...OPTS, outputSchemaPath: "{bad" },
        fakeFs({}),
        throwExit,
        (c) => err.push(c),
        ALL,
      ),
    ).toThrow("exit 2")
    expect(err.join("")).toContain("--output-schema (inline JSON)")
  })

  test("notes go to stderr, appendDeps is spreadable", () => {
    const err: string[] = []
    const r = setupOneShot(
      { ...OPTS, strict: true, appendSystemPrompt: "Be short." },
      fakeFs({}),
      throwExit,
      (c) => err.push(c),
      ALL,
    )
    expect(r.appendDeps).toEqual({ appendSystemPrompt: "Be short." })
    expect(err).toEqual(["[minimal-agent] note: --strict has no effect without --output-schema\n"])
  })

  test("open-responses orStream: carried in runOptions only when true", () => {
    const err: string[] = []
    const on = setupOneShot(
      { ...OPTS, orStream: true },
      fakeFs({}),
      throwExit,
      (c) => err.push(c),
      ALL,
    )
    expect(on.runOptions).toEqual({ orStream: true })
    const off = setupOneShot(
      { ...OPTS, orStream: false },
      fakeFs({}),
      throwExit,
      (c) => err.push(c),
      ALL,
    )
    expect(off.runOptions).toEqual({})
    expect(err).toEqual([])
  })

  test("--schema-retries: carried in runOptions with a schema, a note without one", () => {
    const err: string[] = []
    const withSchema = setupOneShot(
      { ...OPTS, outputSchemaPath: '{"type":"object"}', schemaRetries: 2 },
      fakeFs({}),
      throwExit,
      (c) => err.push(c),
      ALL,
    )
    expect(withSchema.runOptions).toEqual({ schemaRetries: 2 })
    expect(err).toEqual([])
    const without = setupOneShot(
      { ...OPTS, schemaRetries: 2 },
      fakeFs({}),
      throwExit,
      (c) => err.push(c),
      ALL,
    )
    expect(without.runOptions).toEqual({})
    expect(err).toEqual([
      "[minimal-agent] note: --schema-retries has no effect without --output-schema\n",
    ])
    const zero = setupOneShot(
      { ...OPTS, outputSchemaPath: '{"type":"object"}', schemaRetries: 0 },
      fakeFs({}),
      throwExit,
      () => {},
      ALL,
    )
    expect(zero.runOptions).toEqual({})
  })

  test("older core: --temperature warns once and the run is planned without it", () => {
    const err: string[] = []
    const r = setupOneShot(
      { ...OPTS, temperature: 0.5 },
      fakeFs({}),
      throwExit,
      (c) => err.push(c),
      NONE,
    )
    expect(r.runOptions).toEqual({})
    expect(r.appendDeps).toEqual({})
    expect(err).toEqual([
      "[minimal-agent] warn: this core does not support --temperature; running without it\n",
    ])
  })
})
