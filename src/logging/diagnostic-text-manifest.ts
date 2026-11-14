/**
 * Renderers for the typed manifest warn codes (S14.2). Core sends the old
 * message AND attrs (dual-write), so these renderers do not run yet. They
 * render when the message is empty, which is the later step. One renderer per
 * source switches on `attrs.code`. An unknown or missing code gives the generic
 * fallback, never an empty string.
 *
 * @module logging/diagnostic-text-manifest
 */

import { type DiagnosticAttrs, fallback, registerDiagnosticText } from "./diagnostic-text.ts"

const str = (a: DiagnosticAttrs, k: string): string => String(a[k] ?? "")

function renderManifest(a: DiagnosticAttrs): string {
  const path = str(a, "manifestPath")
  const idx = str(a, "index")
  switch (a.code) {
    case "mode_color_ignored":
      return `${path}: mode "${str(a, "modeId")}" declares both \`color\` and \`style\`; \`style\` takes precedence and \`color\` will be ignored.`
    case "sideband_entry_not_object":
      return `sideband[${idx}]:entry`
    case "sideband_entry_invalid":
      return `sideband[${idx}]:${str(a, "field")}`
    case "sideband_owner_ignored":
      return `sideband[${idx}].owner is ignored`
    case "error_renderers_not_array":
      return "errorRenderers:not_array"
    case "error_renderer_not_object":
      return `errorRenderers[${idx}]:not_object`
    case "error_renderer_id_invalid":
      return `errorRenderers[${idx}]:id`
    case "error_renderer_entry_invalid":
      return `errorRenderers[${idx}]:entry`
    case "error_renderer_export_invalid":
      return `errorRenderers[${idx}]:export`
    case "error_renderer_duplicate_id":
      return `errorRenderers[${idx}]:duplicate_id`
    case "host_mode_description_dropped":
      return `${path}: hostModes[${idx}].description dropped (host mode still loads): ${str(a, "reason")}`
    case "cli_block_dropped":
      return `${path}: cli block dropped (plugin still loads): ${str(a, "reason")}`
    case "host_mode_field_dropped":
      return `${path}: hostModes[${idx}].${str(a, "field")} dropped (host mode still loads): ${str(a, "reason")}`
    default:
      return fallback("plugin.manifest", a)
  }
}

function renderLoader(a: DiagnosticAttrs): string {
  if (a.code === "plugin_declares_no_contributions") {
    return `${str(a, "dir")}: plugin "${str(a, "pluginId")}" declares no contributions (${str(a, "keys")}) and ships no PROMPT.md; it will load but do nothing`
  }
  return fallback("plugin-loader", a)
}

/** Register the manifest warn renderers. Safe to call more than once. */
export function registerManifestDiagnosticText(): void {
  registerDiagnosticText("plugin.manifest", (a) => renderManifest(a))
  registerDiagnosticText("plugin-loader", (a) => renderLoader(a))
}
