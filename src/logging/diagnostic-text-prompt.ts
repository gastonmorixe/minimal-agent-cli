/**
 * Renderers for the typed system prompt base diagnostics. These events have no
 * old core sentence, so the text here is a new design. One renderer per source.
 * The load failure renderer switches on `attrs.code`. An unknown or missing code
 * gives the generic fallback, never an empty string.
 *
 * @module logging/diagnostic-text-prompt
 */

import { type DiagnosticAttrs, fallback, registerDiagnosticText } from "./diagnostic-text.ts"

const LOAD_FAILED = "prompt.system_base_load_failed"
const SLOT_CONFLICT = "prompt.system_base_slot_conflict"

const str = (a: DiagnosticAttrs, k: string): string => String(a[k] ?? "")

function renderLoadFailed(a: DiagnosticAttrs): string {
  const abs = str(a, "abs")
  let detail: string
  switch (a.code) {
    case "module_not_found":
      detail = `module not found: ${abs}`
      break
    case "no_provider_export":
      detail = `${abs} has no provider export`
      break
    case "load_failed":
      detail = str(a, "reason") || "load failed"
      break
    default:
      return fallback(LOAD_FAILED, a)
  }
  return `${str(a, "packageDir")}: systemPromptBase failed: ${detail}`
}

function renderSlotConflict(a: DiagnosticAttrs): string {
  return `system prompt slot "${str(a, "slot")}" is owned by plugin "${str(a, "owner")}": plugin "${str(a, "refused")}" was refused`
}

/** Register the system prompt base renderers. Safe to call more than once. */
export function registerPromptDiagnosticText(): void {
  registerDiagnosticText(LOAD_FAILED, (a) => renderLoadFailed(a))
  registerDiagnosticText(SLOT_CONFLICT, (a) => renderSlotConflict(a))
}
