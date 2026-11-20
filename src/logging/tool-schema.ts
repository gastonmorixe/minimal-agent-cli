/**
 * Turn a tool `input_schema` (JSON Schema, type unknown) into a compact typed
 * list of parameters for the `--debug` request dump.
 *
 * Pure and robust: a missing or bad schema gives an empty list, and no input
 * makes these functions throw.
 *
 * @module logging/tool-schema
 */

/** One parameter row of a tool schema. */
export interface ToolParam {
  /** Property name. */
  readonly name: string
  /** Compact type text, for example `string`, `"a"|"b"`, `integer[]`. */
  readonly type: string
  /** The parent object lists the property in `required`. */
  readonly required: boolean
  /** JSON text of `default`, when the schema has one. */
  readonly default?: string
  /** One-line description. Empty when absent. */
  readonly description: string
  /** Nesting depth. 0 is a top-level parameter. */
  readonly depth: number
}

/** Deepest nesting walked. Deeper schemas show as `object`. */
const MAX_DEPTH = 8

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function safeStr(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    return s === undefined ? String(v) : s
  } catch {
    return "?"
  }
}

function flat(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/** The compact type text of one schema node. */
export function schemaType(node: unknown, depth = 0): string {
  try {
    if (!isObj(node)) return "any"
    if (depth > MAX_DEPTH) return "object"
    if ("const" in node) return safeStr(node.const)
    if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum.map(safeStr).join("|")
    const alt = Array.isArray(node.anyOf)
      ? node.anyOf
      : Array.isArray(node.oneOf)
        ? node.oneOf
        : undefined
    if (alt !== undefined && alt.length > 0) {
      return [...new Set(alt.map((a) => schemaType(a, depth + 1)))].join("|")
    }
    const t = node.type
    const types = Array.isArray(t)
      ? t.filter((x): x is string => typeof x === "string")
      : typeof t === "string"
        ? [t]
        : []
    if (types.length === 0) {
      if (isObj(node.properties)) return "object"
      if ("items" in node) types.push("array")
      else return "any"
    }
    return types
      .map((x) => {
        if (x !== "array") return x
        if (!isObj(node.items)) return "any[]"
        const inner = schemaType(node.items, depth + 1)
        return inner.includes("|") ? `(${inner})[]` : `${inner}[]`
      })
      .join("|")
  } catch {
    return "any"
  }
}

/** The nested object schema of a node (direct, or the `items` of an array), if any. */
function nestedObject(node: Obj): Obj | undefined {
  if (isObj(node.properties)) return node
  if (isObj(node.items) && isObj(node.items.properties)) return node.items
  return undefined
}

function walk(schema: Obj, depth: number, out: ToolParam[]): void {
  const props = schema.properties
  if (!isObj(props)) return
  const req = Array.isArray(schema.required) ? schema.required : []
  for (const name of Object.keys(props)) {
    let node: unknown
    try {
      node = props[name]
    } catch {
      node = undefined
    }
    const n = isObj(node) ? node : {}
    const desc = typeof n.description === "string" ? flat(n.description) : ""
    out.push({
      name,
      type: schemaType(n, depth),
      required: req.includes(name),
      ...("default" in n ? { default: safeStr(n.default) } : {}),
      description: desc,
      depth,
    })
    const nested = depth < MAX_DEPTH ? nestedObject(n) : undefined
    if (nested !== undefined) walk(nested, depth + 1, out)
  }
}

/**
 * The parameters of one tool schema, depth first. Nested object properties
 * follow their parent with `depth + 1`.
 *
 * @param schema - The `input_schema`. Any value.
 * @returns The rows. Empty for a missing or bad schema.
 */
export function schemaParams(schema: unknown): ToolParam[] {
  const out: ToolParam[] = []
  try {
    if (isObj(schema)) walk(schema, 0, out)
  } catch {
    // A hostile schema (throwing getter): keep the rows found so far.
  }
  return out
}

/** `name*` for a required parameter, `name?` for an optional one. */
export function paramLabel(p: ToolParam): string {
  return `${p.name}${p.required ? "*" : "?"}`
}

/**
 * The one-line summary of the top-level parameters, for example
 * `(path*: string, limit?: integer = 10)`. Empty string when there are none.
 */
export function paramSummary(params: readonly ToolParam[]): string {
  const top = params.filter((p) => p.depth === 0)
  if (top.length === 0) return ""
  const items = top.map(
    (p) => `${paramLabel(p)}: ${p.type}${p.default !== undefined ? ` = ${p.default}` : ""}`,
  )
  return `(${items.join(", ")})`
}

/** The columns of one table row, before padding. */
export interface ParamCells {
  /** Indent plus `name*` / `name?`. */
  readonly name: string
  /** Type text. */
  readonly type: string
  /** `required` or `optional`. */
  readonly req: string
  /** Description, plus `(default: X)` when present. */
  readonly desc: string
}

/** The cells of each row, for an aligned table. */
export function paramCells(params: readonly ToolParam[]): ParamCells[] {
  return params.map((p) => ({
    name: `${"  ".repeat(p.depth)}${paramLabel(p)}`,
    type: p.type,
    req: p.required ? "required" : "optional",
    desc: [p.description, p.default !== undefined ? `(default: ${p.default})` : ""]
      .filter((s) => s !== "")
      .join(" "),
  }))
}

/** Column widths of {@link paramCells}. */
export function cellWidths(cells: readonly ParamCells[]): {
  name: number
  type: number
  req: number
} {
  let name = 0
  let type = 0
  let req = 0
  for (const c of cells) {
    name = Math.max(name, c.name.length)
    type = Math.max(type, c.type.length)
    req = Math.max(req, c.req.length)
  }
  return { name, type, req }
}

/** Plain aligned table lines (no indent), one per parameter. */
export function paramTable(params: readonly ToolParam[]): string[] {
  const cells = paramCells(params)
  const w = cellWidths(cells)
  return cells.map((c) =>
    `${c.name.padEnd(w.name)}  ${c.type.padEnd(w.type)}  ${c.req.padEnd(w.req)}  ${c.desc}`.trimEnd(),
  )
}
