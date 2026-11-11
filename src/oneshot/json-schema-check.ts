/**
 * Copy of ma-acp-plugin/structured-output.ts validateJson. Move both to core
 * plugin-api after the core pin bump (SPEC-ONESHOT R12).
 *
 * The `--output-schema` check of the one-shot CLI run. Same subset and
 * rules as the ACP plugin, so a schema gives the same result on both
 * surfaces:
 *
 * - Keywords checked: `type` (a name or an array of names: `object`,
 *   `array`, `string`, `number`, `integer`, `boolean`, `null`),
 *   `properties`, `required`, `items` (one schema for every item), `enum`,
 *   `const`, and `additionalProperties: false`.
 * - Every other keyword (`$ref`, `anyOf`, `oneOf`, `allOf`, `pattern`,
 *   `minimum`, `minLength`, `format`, tuple `items`, ...) is IGNORED.
 * - A boolean schema: `true` accepts all, `false` rejects all.
 * - Nesting deeper than {@link MAX_SCHEMA_DEPTH} is an error, not a throw.
 *
 * One CLI rule stays stricter than the plugin: the answer text is parsed
 * with `JSON.parse` as it is. The plugin strips one Markdown code fence
 * first. The CLI does not, because the old CLI check (core
 * `validateJsonAnswer`) did not, and this change must not weaken it.
 *
 * Pure. No I/O. No imports. Never throws.
 *
 * @module oneshot/json-schema-check
 */

type Json = unknown

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** The JSON type name of a value, `integer` for whole numbers. */
function typeName(v: Json): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number"
  return typeof v
}

function typeMatches(v: Json, want: string): boolean {
  const got = typeName(v)
  if (want === "number") return got === "number" || got === "integer"
  return got === want
}

/**
 * Max nesting depth that `validateJson` and `jsonEqual` walk. Without a cap
 * a deep schema and value pair can overflow the stack. Deeper input is a
 * validation error, not a throw.
 */
export const MAX_SCHEMA_DEPTH = 64

/** Deep equality for JSON values (for `enum` and `const`). Too deep: not equal. */
function jsonEqual(a: Json, b: Json, depth = 0): boolean {
  if (a === b) return true
  if (depth >= MAX_SCHEMA_DEPTH) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i], depth + 1))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return (
      ka.length === kb.length &&
      ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k], depth + 1))
    )
  }
  return false
}

/**
 * Check `value` against `schema` (the subset above). Returns the first
 * error as one line with a JSON path (`$.a[0]`), or `undefined` when valid.
 */
export function validateJson(value: Json, schema: unknown, path = "$"): string | undefined {
  return validateAt(value, schema, path, 0)
}

function validateAt(value: Json, schema: unknown, path: string, depth: number): string | undefined {
  if (schema === true || schema === undefined) return undefined
  if (depth > MAX_SCHEMA_DEPTH) {
    return `${path}: nesting is deeper than ${MAX_SCHEMA_DEPTH} levels`
  }
  if (schema === false) return `${path}: no value is allowed here`
  if (!isPlainObject(schema)) return undefined
  const { type } = schema
  if (typeof type === "string" || Array.isArray(type)) {
    const wants = (Array.isArray(type) ? type : [type]).filter(
      (t): t is string => typeof t === "string",
    )
    if (wants.length > 0 && !wants.some((t) => typeMatches(value, t))) {
      return `${path}: expected ${wants.join(" or ")}, got ${typeName(value)}`
    }
  }
  if (Object.hasOwn(schema, "const") && !jsonEqual(value, schema.const)) {
    return `${path}: must be ${JSON.stringify(schema.const)}`
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => jsonEqual(value, e))) {
    return `${path}: must be one of ${JSON.stringify(schema.enum)}`
  }
  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) {
          return `${path}: missing required property "${key}"`
        }
      }
    }
    const props = isPlainObject(schema.properties) ? schema.properties : {}
    for (const [key, sub] of Object.entries(props)) {
      if (!Object.hasOwn(value, key)) continue
      const err = validateAt(value[key], sub, `${path}.${key}`, depth + 1)
      if (err) return err
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((k) => !Object.hasOwn(props, k))
      if (extra !== undefined) return `${path}: property "${extra}" is not allowed`
    }
  }
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    for (let i = 0; i < value.length; i++) {
      const err = validateAt(value[i], schema.items, `${path}[${i}]`, depth + 1)
      if (err) return err
    }
  }
  return undefined
}

/**
 * The outcome of {@link checkJsonAnswer}. On a failure, `message` is the
 * plugin-style text (for the corrective prompt) and `detail` is the one
 * stderr line with the JSON path.
 */
export type JsonAnswerCheck =
  | { readonly ok: true; readonly value: Json }
  | { readonly ok: false; readonly message: string; readonly detail: string }

/** Parse `text` as JSON (no fence strip, see the module doc) and check it. */
export function checkJsonAnswer(text: string, schema: object): JsonAnswerCheck {
  let value: Json
  try {
    value = JSON.parse(text)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      message: `the reply is not valid JSON (${reason})`,
      detail: `$: final answer is not valid JSON: ${reason}`,
    }
  }
  let err: string | undefined
  try {
    err = validateJson(value, schema)
  } catch (e) {
    err = `$: the schema check failed (${e instanceof Error ? e.message : String(e)})`
  }
  return err === undefined
    ? { ok: true, value }
    : { ok: false, message: `the reply does not match the schema: ${err}`, detail: err }
}

/**
 * The user message for a `--schema-retries` attempt. Same text as the ACP
 * plugin `correctivePrompt`: short, and it has the validation error.
 */
export function correctivePrompt(message: string): string {
  return `Your previous reply was rejected: ${message}. Reply again with only one JSON value that matches the required JSON Schema. No other text, no code fence.`
}

/** The largest `--schema-retries` value. */
export const MAX_SCHEMA_RETRIES = 5
