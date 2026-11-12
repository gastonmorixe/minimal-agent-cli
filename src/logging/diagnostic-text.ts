/**
 * Host text of a diagnostic event (S14.2 step 0).
 *
 * The CLI reads this helper instead of `LogEvent.message`. While `message` is
 * a non-empty string, the helper returns it unchanged, so every output stays
 * byte-equal. When core empties the message of a source, the helper renders
 * the text from `diagnostic.source`, `level` and `attrs` through a registry.
 *
 * Dedupe keys (scrollback, diagnostic surface) still read the message value.
 * They move to source + attrs in the same commit that empties the message of
 * an area.
 *
 * @module logging/diagnostic-text
 */

import type { CoreDiagnosticLevel, LogEvent } from "@minimal-agent/core/host/diagnostics"

/** Attributes of a typed diagnostic. */
export type DiagnosticAttrs = Readonly<Record<string, string | number | boolean | null>>

/** Renders the text of one source from its attrs and level. */
export type DiagnosticRenderer = (attrs: DiagnosticAttrs, level: CoreDiagnosticLevel) => string

const registry = new Map<string, DiagnosticRenderer>()

/** Register a renderer for a source. Later steps add one entry per source. */
export function registerDiagnosticText(source: string, render: DiagnosticRenderer): void {
  registry.set(source, render)
}

/** Generic render `source: k=v` (sorted keys) for a source with no renderer. */
export function fallback(source: string, attrs: DiagnosticAttrs): string {
  const pairs = Object.keys(attrs)
    .sort()
    .map((k) => `${k}=${String(attrs[k])}`)
  return pairs.length > 0 ? `${source}: ${pairs.join(" ")}` : source
}

/**
 * Text of an event for a CLI renderer. Message first: a non-empty message is
 * returned as is. Otherwise render from the registry, or the fallback.
 */
export function diagnosticText(e: LogEvent): string {
  if (e.message !== "") return e.message
  const d = e.diagnostic
  if (d === undefined) return e.message
  const render = registry.get(d.source)
  return render ? render(d.attrs, d.level) : fallback(d.source, d.attrs)
}

/** True when a renderer is registered for the source. */
export function hasDiagnosticText(source: string): boolean {
  return registry.has(source)
}

/**
 * Volatile attr names: values that differ between two identical repeats.
 * Dedupe keys skip them. Names come from the attrs that core emits
 * (api.retry, api.stream-stalled, api.retry-terminal-less-stop):
 * - attempt, attempts, retries, retry: attempt counters.
 * - reset-at, ts, timestamp, time: clock values.
 * - completed-tool-calls, count: progress counters.
 * - duration, elapsed, delay, idle, bytes, size: measures.
 * Names are compared in kebab-case, so camelCase and snake_case match too.
 * A name that ends in `-ms`, `-bytes`, `-seconds` or `-at` is volatile too.
 */
const VOLATILE_NAMES: ReadonlySet<string> = new Set([
  "attempt",
  "attempts",
  "retries",
  "retry",
  "reset-at",
  "ts",
  "timestamp",
  "time",
  "completed-tool-calls",
  "count",
  "duration",
  "elapsed",
  "delay",
  "idle",
  "bytes",
  "size",
])
const VOLATILE_SUFFIX = /-(ms|bytes|seconds|at)$/

/** True when an attr or structuredData key is volatile (not part of the dedupe key). */
export function isVolatileDiagnosticKey(name: string): boolean {
  const kebab = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase()
  return VOLATILE_NAMES.has(kebab) || VOLATILE_SUFFIX.test(kebab)
}

/**
 * Dedupe key of an event. A set message is the key. An empty message keys on
 * the source, the code (if any) and the stable attrs (sorted, volatile keys
 * dropped). Attrs come from `diagnostic`, else from `structuredData`.
 */
export function diagnosticKey(e: LogEvent): string {
  if (e.message !== "") return e.message
  const attrs: Readonly<Record<string, unknown>> | undefined =
    e.diagnostic?.attrs ?? e.structuredData
  if (attrs === undefined) return e.message
  const source = e.diagnostic?.source ?? e.source
  const stable = Object.keys(attrs)
    .filter((k) => !isVolatileDiagnosticKey(k))
    .sort()
    .map((k) => [k, attrs[k]])
  return `\u0000${JSON.stringify([source, attrs.code ?? null, stable])}`
}
