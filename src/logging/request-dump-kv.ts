/**
 * The `headers` and `body` sections of the `--debug` request dump: aligned
 * `key value` rows, built from the redacted `headers` and `body` fields of
 * core's request snapshot. Pure data: no ANSI, no I/O.
 *
 * Core masks each secret before the event exists. This module only marks a
 * masked value (`redacted`), so a renderer can draw it dim and italic.
 *
 * @module logging/request-dump-kv
 */

import type { RequestSnapshot } from "@minimal-agent/core/host/request-inspector"

/** A `headers` or `body` section name. */
export type DumpKvSectionName = "headers" | "body"

/** One `key value` row. */
export interface DumpKvRow {
  /** Header name (lowercase) or top-level body key. */
  readonly key: string
  /** One-line value: a string as is, any other value as compact JSON. */
  readonly value: string
  /** Pretty JSON lines of an object or array value (verbose). Absent for a scalar. */
  readonly pretty?: readonly string[]
  /** True when core masked the value. */
  readonly redacted: boolean
}

/** One `headers` or `body` section. */
export interface DumpKvSection {
  /** Section name. */
  readonly name: DumpKvSectionName
  /** Rows, sorted by key. */
  readonly rows: readonly DumpKvRow[]
}

/** The form of a mask that core writes (`<redacted:N chars>`, `…abcd`, `Bearer …abcd`). */
const MASK = /^(?:[A-Za-z][A-Za-z0-9-]*\s+)?(?:<redacted:\d+ chars>|….{0,4})$/

/** True when `value` is a mask that core wrote. */
export function isRedacted(value: string): boolean {
  return MASK.test(value)
}

/** A JSON text that never throws. */
function json(value: unknown, indent?: number): string {
  try {
    return JSON.stringify(value, null, indent) ?? String(value)
  } catch {
    return "[unserializable]"
  }
}

/** One row of a value. */
function row(key: string, value: unknown): DumpKvRow {
  if (typeof value === "string") return { key, value, redacted: isRedacted(value) }
  const isObject = value !== null && typeof value === "object"
  return {
    key,
    value: json(value),
    ...(isObject ? { pretty: json(value, 2).split("\n") } : {}),
    redacted: false,
  }
}

/** Sort by key, in code-unit order (stable across locales). */
const byKey = (a: DumpKvRow, b: DumpKvRow): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

/**
 * The `headers` and `body` sections of a snapshot. A section with no rows is
 * left out.
 *
 * @param req - The redacted request snapshot.
 * @returns `headers` first, then `body`.
 */
export function kvSections(req: RequestSnapshot): DumpKvSection[] {
  const out: DumpKvSection[] = []
  const headers = Object.entries(req.headers ?? {}).map(([k, v]) => row(k.toLowerCase(), v))
  if (headers.length > 0) out.push({ name: "headers", rows: headers.sort(byKey) })
  const body = Object.entries(req.body ?? {}).map(([k, v]) => row(k, v))
  if (body.length > 0) out.push({ name: "body", rows: body.sort(byKey) })
  return out
}

/** The width of the widest key of a section. */
export function keyWidth(section: DumpKvSection): number {
  return section.rows.reduce((m, r) => Math.max(m, r.key.length), 0)
}

/** The unit word of a section count. */
export function kvUnit(name: DumpKvSectionName): string {
  return name === "headers" ? "header(s)" : "field(s)"
}
