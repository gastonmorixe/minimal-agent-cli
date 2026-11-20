import { describe, expect, test } from "bun:test"

import { paramSummary, paramTable, schemaParams, schemaType } from "./tool-schema.ts"

describe("schemaType", () => {
  test("enum", () => expect(schemaType({ type: "string", enum: ["a", "b"] })).toBe('"a"|"b"'))
  test("array", () =>
    expect(schemaType({ type: "array", items: { type: "integer" } })).toBe("integer[]"))
  test("array of union", () =>
    expect(
      schemaType({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }),
    ).toBe("(string|number)[]"))
  test("type array", () => expect(schemaType({ type: ["string", "null"] })).toBe("string|null"))
  test("anyOf and oneOf", () => {
    expect(schemaType({ anyOf: [{ type: "string" }, { type: "boolean" }] })).toBe("string|boolean")
    expect(schemaType({ oneOf: [{ const: "x" }, { type: "null" }] })).toBe('"x"|null')
  })
  test("bad input", () => {
    expect(schemaType(undefined)).toBe("any")
    expect(schemaType(42)).toBe("any")
    expect(schemaType({})).toBe("any")
  })
})

describe("schemaParams", () => {
  test("missing or bad schema gives no rows and does not throw", () => {
    expect(schemaParams(undefined)).toEqual([])
    expect(schemaParams(null)).toEqual([])
    expect(schemaParams("x")).toEqual([])
    expect(schemaParams({ type: "object", properties: 5 })).toEqual([])
    const hostile = {
      properties: {
        get a() {
          throw new Error("no")
        },
      },
    }
    expect(() => schemaParams(hostile)).not.toThrow()
  })

  const schema = {
    type: "object",
    properties: {
      path: { type: "string", description: "File\n path." },
      limit: { type: "integer", default: 10 },
      mode: { enum: ["a", "b"] },
      opts: {
        type: "object",
        required: ["deep"],
        properties: { deep: { type: "boolean" }, tag: { type: ["string", "null"] } },
      },
    },
    required: ["path"],
  }

  test("required, optional, default, nested", () => {
    const rows = schemaParams(schema)
    expect(rows.map((r) => [r.name, r.type, r.required, r.depth, r.default])).toEqual([
      ["path", "string", true, 0, undefined],
      ["limit", "integer", false, 0, "10"],
      ["mode", '"a"|"b"', false, 0, undefined],
      ["opts", "object", false, 0, undefined],
      ["deep", "boolean", true, 1, undefined],
      ["tag", "string|null", false, 1, undefined],
    ])
    expect(rows[0].description).toBe("File path.")
  })

  test("summary and table", () => {
    const rows = schemaParams(schema)
    expect(paramSummary(rows)).toBe(
      '(path*: string, limit?: integer = 10, mode?: "a"|"b", opts?: object)',
    )
    expect(paramSummary([])).toBe("")
    expect(paramTable(rows)).toEqual([
      "path*    string       required  File path.",
      "limit?   integer      optional  (default: 10)",
      'mode?    "a"|"b"      optional',
      "opts?    object       optional",
      "  deep*  boolean      required",
      "  tag?   string|null  optional",
    ])
  })
})

describe("paramTable nesting", () => {
  test("indents nested properties; a nested name equal to a top-level name is distinct", () => {
    const rows = schemaParams({
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        opts: {
          type: "object",
          properties: { name: { type: "integer" }, inner: { type: "object", properties: { x: { type: "boolean" } } } },
        },
      },
    })
    const lines = paramTable(rows)
    const top = lines.filter((l) => /^name/.test(l))
    const nested = lines.filter((l) => /^ {2}name/.test(l))
    expect(top).toHaveLength(1)
    expect(top[0]).toContain("string")
    expect(nested).toHaveLength(1)
    expect(nested[0]).toContain("integer")
    expect(lines.some((l) => /^ {2}inner/.test(l))).toBe(true)
    expect(lines.some((l) => /^ {4}x/.test(l))).toBe(true)
  })
})
