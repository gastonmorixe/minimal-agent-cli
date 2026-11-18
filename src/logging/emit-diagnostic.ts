/**
 * One-line emit on the process-wide diagnostic bus, for CLI modules that used
 * to write a diagnostic line straight to `process.stderr`.
 *
 * A direct stderr write tears the live area while the REPL is up. A bus event
 * lands in the file log, the scrollback chip (Warning and above) and the TUI
 * footer surface, and in the plain stderr mirror of print/protocol mode with
 * `--debug`.
 *
 * Sinks attach in `src/main.ts` (`attachStartupDiagnosticSinks`), after the
 * subcommand dispatch. An event emitted before that point reaches no sink, so
 * subcommand code must not use this helper for lines the user has to see.
 *
 * @module logging/emit-diagnostic
 */

import { Facility, getDiagnosticBus, type Severity } from "@minimal-agent/core/host/diagnostics"

/**
 * Emit one diagnostic on the process-wide bus under `Facility.User`.
 *
 * Never throws: a diagnostic must not take its caller down, and the bus
 * itself already swallows sink errors.
 *
 * @param severity - RFC 5424 severity. `Severity.Warning` and above reach the scrollback.
 * @param source - Dotted-kebab id, `<subsystem>.<event>`. It is the MSGID of the file log.
 * @param message - One line of text.
 * @param data - Optional structured data (string, number or boolean values).
 */
export function emitDiagnostic(
  severity: Severity,
  source: string,
  message: string,
  data?: Record<string, string | number | boolean>,
): void {
  try {
    getDiagnosticBus().emit({
      ts: Date.now(),
      severity,
      facility: Facility.User,
      source,
      message,
      structuredData: data,
    })
  } catch {
    // Best-effort: a failing bus must never break the caller.
  }
}

/**
 * Plain, one-line text for a diagnostic whose wording is not ours: styled
 * output of another module, or a line a plugin process wrote.
 *
 * The scrollback sink writes the message to the terminal as it is, so escape
 * sequences in it would run in the user's terminal. This strips ANSI/OSC
 * sequences, turns every other control character (C0, DEL, C1, newline, tab)
 * into a space, collapses runs of whitespace and trims.
 *
 * @param text - Raw text.
 * @returns Single-line text with no control characters.
 */
export function plainDiagnosticText(text: string): string {
  let out = ""
  for (const ch of Bun.stripANSI(text)) {
    const cp = ch.codePointAt(0) ?? 0
    out += cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) ? " " : ch
  }
  return out.replace(/\s+/g, " ").trim()
}
