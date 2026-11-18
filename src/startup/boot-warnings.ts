/**
 * Boot warnings of `src/main.ts` that used to be raw `console.error` lines.
 *
 * A raw stderr line tears the startup tree (the formatter warning fires while
 * the banner is open) and the live area (the spinner warning fires right
 * before the REPL mounts). Both now go through the diagnostic bus: the
 * scrollback sink buffers them during the banner and prints a Warning chip
 * after it, the footer surface shows them, and the file log keeps them.
 *
 * Both run after `attachStartupDiagnosticSinks` in `main()`, so a sink is
 * attached when they fire. They live in their own module because `main.ts`
 * sits at its `max-lines` budget.
 *
 * @module startup/boot-warnings
 */

import { Severity } from "@minimal-agent/core/host/diagnostics"
import { emitDiagnostic, plainDiagnosticText } from "../logging/emit-diagnostic.ts"

/**
 * The markdown formatter could not be resolved or installed, so the REPL
 * renders plain text.
 *
 * @param warn - The `warn` text of `resolveFormatter` (styled, may hold ANSI).
 */
export function warnFormatterUnavailable(warn: string): void {
  emitDiagnostic(
    Severity.Warning,
    "formatter.unavailable",
    "markdown formatter unavailable; output stays plain",
    { reason: plainDiagnosticText(warn) },
  )
}

/**
 * `--spinner` named a preset that does not exist; the REPL uses its default.
 *
 * @param line - The styled warning line of `resolveSpinnerPreset`. It starts
 *   with its own `warn` label, which the chip already shows, so that label is dropped.
 */
export function warnUnknownSpinnerPreset(line: string): void {
  emitDiagnostic(
    Severity.Warning,
    "spinner.unknown-preset",
    plainDiagnosticText(line).replace(/^warn /, ""),
  )
}
