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

function fallback(source: string, attrs: DiagnosticAttrs): string {
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
