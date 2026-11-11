/**
 * Tests for `json-schema-check.ts`. The `validateJson` cases are the same
 * cases as ma-acp-plugin/structured-output.test.ts, so both copies give the
 * same result (SPEC-ONESHOT R12).
 *
 * @module oneshot/json-schema-check.test
 */

import { describe, expect, it } from "bun:test"

import { checkJsonAnswer, correctivePrompt, validateJson } from "./json-schema-check.ts"

describe("validateJson (subset, same cases as the ACP plugin)", () => {
  it("checks type, including integer, number, null, and type arrays", () => {
    expect(validateJson(1, { type: "integer" })).toBeUndefined()
    expect(validateJson(1.5, { type: "integer" })).toContain("expected integer, got number")
    expect(validateJson(1, { type: "number" })).toBeUndefined()
    expect(validateJson(null, { type: ["string", "null"] })).toBeUndefined()
    expect(validateJson(true, { type: ["string", "null"] })).toContain("expected string or null")
    expect(validateJson([], { type: "object" })).toContain("got array")
  })

  it("checks required, properties, additionalProperties false, with a path", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "object", properties: { b: { type: "string" } } } },
      required: ["a"],
      additionalProperties: false,
    }
    expect(validateJson({ a: { b: "x" } }, schema)).toBeUndefined()
    expect(validateJson({}, schema)).toBe('$: missing required property "a"')
    expect(validateJson({ a: { b: 1 } }, schema)).toBe("$.a.b: expected string, got integer")
    expect(validateJson({ a: {}, z: 1 }, schema)).toBe('$: property "z" is not allowed')
  })

  it("checks items, enum, and const", () => {
    expect(validateJson([1, 2], { type: "array", items: { type: "integer" } })).toBeUndefined()
    expect(validateJson([1, "x"], { items: { type: "integer" } })).toBe(
      "$[1]: expected integer, got string",
    )
    expect(validateJson("b", { enum: ["a", "b"] })).toBeUndefined()
    expect(validateJson("c", { enum: ["a", "b"] })).toContain("one of")
    expect(validateJson({ k: [1] }, { const: { k: [1] } })).toBeUndefined()
    expect(validateJson(2, { const: 1 })).toContain("must be 1")
  })

  it("ignores unknown keywords, and handles boolean schemas", () => {
    expect(validateJson("x", { type: "string", pattern: "^y$", minLength: 5 })).toBeUndefined()
    expect(validateJson(1, true)).toBeUndefined()
    expect(validateJson(1, false)).toContain("no value")
  })
})

describe("validateJson limits (same cases as the ACP plugin)", () => {
  const nest = (n: number) => {
    let schema: Record<string, unknown> = { const: { x: 1 } }
    let value: unknown = { x: 1 }
    let constVal: unknown = 1
    for (let i = 0; i < n; i++) {
      schema = { type: "object", properties: { a: schema }, required: ["a"] }
      value = { a: value }
      constVal = [constVal]
    }
    return { schema, value, constVal }
  }
  it("depth 1000 returns an error, no throw", () => {
    const { schema, value } = nest(1000)
    expect(() => validateJson(value, schema)).not.toThrow()
    expect(validateJson(value, schema)).toContain("deeper than 64 levels")
    const r = checkJsonAnswer(JSON.stringify(value), schema)
    expect(r.ok).toBe(false)
  })
  it("a deep const or enum value is not equal, no throw", () => {
    const { constVal } = nest(1000)
    const copy = JSON.parse(JSON.stringify(constVal))
    expect(() => validateJson(copy, { const: constVal })).not.toThrow()
    expect(validateJson(copy, { enum: [constVal] })).toContain("must be one of")
  })
  it("shallow nesting still validates", () => {
    const { schema, value } = nest(10)
    expect(validateJson(value, schema)).toBeUndefined()
  })
  it("required and additionalProperties read own keys only", () => {
    expect(validateJson({}, { required: ["toString"] })).toContain(
      'missing required property "toString"',
    )
    expect(
      validateJson(JSON.parse('{"constructor": 1}'), {
        properties: {},
        additionalProperties: false,
      }),
    ).toContain('property "constructor" is not allowed')
  })
})

describe("checkJsonAnswer (CLI text rules)", () => {
  const schema = { type: "object", required: ["n"] }
  it("parses plain JSON, surrounding whitespace allowed", () => {
    expect(checkJsonAnswer(' {"n": 1} ', schema)).toEqual({ ok: true, value: { n: 1 } })
  })
  it("keeps the old CLI rule: a fenced answer is not valid JSON (no fence strip)", () => {
    const r = checkJsonAnswer('```json\n{"n": 2}\n```', schema)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toContain("not valid JSON")
  })
  it("reports empty text, bad JSON, and a schema miss", () => {
    expect(checkJsonAnswer("  ", schema).ok).toBe(false)
    const bad = checkJsonAnswer("hello", schema)
    expect(!bad.ok && bad.message).toContain("not valid JSON")
    expect(!bad.ok && bad.detail).toStartWith("$: final answer is not valid JSON: ")
    const miss = checkJsonAnswer("{}", schema)
    expect(!miss.ok && miss.message).toBe(
      'the reply does not match the schema: $: missing required property "n"',
    )
    expect(!miss.ok && miss.detail).toBe('$: missing required property "n"')
  })
  it("a bare scalar parses but fails an object schema", () => {
    expect(checkJsonAnswer("42", { type: "object" }).ok).toBe(false)
  })
})

describe("correctivePrompt", () => {
  it("has the same text as the ACP plugin, with the error", () => {
    expect(correctivePrompt("the reply is not valid JSON (x)")).toBe(
      "Your previous reply was rejected: the reply is not valid JSON (x). Reply again with only one JSON value that matches the required JSON Schema. No other text, no code fence.",
    )
  })
})
