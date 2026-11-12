/**
 * Parity test (S14.2, manifest warns): the registry renders the old text of the
 * 14 typed manifest warn codes from attrs when the message is empty. The
 * expected strings are inline literals copied from the core literal test
 * `manifest-warn-attrs.test.ts` (commit 2fb2bbc). The renderer is not used to
 * build any expectation.
 *
 * @module logging/diagnostic-text-manifest.parity.test
 */

import { describe, expect, test } from "bun:test"

import { Facility, type LogEvent, Severity } from "@minimal-agent/core/host/diagnostics"

import { diagnosticKey, diagnosticText } from "./diagnostic-text.ts"
import { registerManifestDiagnosticText } from "./diagnostic-text-manifest.ts"

registerManifestDiagnosticText()

type Attrs = Record<string, string | number | boolean | null>

function ev(source: string, attrs: Attrs): LogEvent {
  return {
    ts: 0,
    severity: Severity.Warning,
    facility: Facility.User,
    source,
    message: "",
    diagnostic: { source, level: "warn", attrs },
  }
}

const P = "/x/manifest.json"
const man = (attrs: Attrs): LogEvent => ev("plugin.manifest", { manifestPath: P, ...attrs })

const SIDEBAND_FIELDS = [
  "kind",
  "direction",
  "placement",
  "body",
  "trust",
  "layout",
  "attrs",
  "attrs.type",
  "summary",
  "legacy",
  "legacyBodyEscaped",
  "example",
]

const CASES: readonly { name: string; e: LogEvent; old: string }[] = [
  {
    name: "1 mode_color_ignored",
    e: man({ code: "mode_color_ignored", modeId: "m" }),
    old: '/x/manifest.json: mode "m" declares both `color` and `style`; `style` takes precedence and `color` will be ignored.',
  },
  {
    name: "2 sideband_entry_not_object",
    e: man({ code: "sideband_entry_not_object", index: 0 }),
    old: "sideband[0]:entry",
  },
  {
    name: "4 sideband_owner_ignored",
    e: man({ code: "sideband_owner_ignored", index: 0 }),
    old: "sideband[0].owner is ignored",
  },
  {
    name: "5 error_renderers_not_array",
    e: man({ code: "error_renderers_not_array" }),
    old: "errorRenderers:not_array",
  },
  {
    name: "6 error_renderer_not_object",
    e: man({ code: "error_renderer_not_object", index: 0 }),
    old: "errorRenderers[0]:not_object",
  },
  {
    name: "7 error_renderer_id_invalid",
    e: man({ code: "error_renderer_id_invalid", index: 0 }),
    old: "errorRenderers[0]:id",
  },
  {
    name: "8 error_renderer_entry_invalid",
    e: man({ code: "error_renderer_entry_invalid", index: 0 }),
    old: "errorRenderers[0]:entry",
  },
  {
    name: "9 error_renderer_export_invalid",
    e: man({ code: "error_renderer_export_invalid", index: 0 }),
    old: "errorRenderers[0]:export",
  },
  {
    name: "10 error_renderer_duplicate_id",
    e: man({ code: "error_renderer_duplicate_id", index: 1 }),
    old: "errorRenderers[1]:duplicate_id",
  },
  {
    name: "11 host_mode_description_dropped",
    e: man({ code: "host_mode_description_dropped", index: 0, reason: "too long" }),
    old: "/x/manifest.json: hostModes[0].description dropped (host mode still loads): too long",
  },
  {
    name: "12 cli_block_dropped",
    e: man({ code: "cli_block_dropped", reason: "bad contractVersion" }),
    old: "/x/manifest.json: cli block dropped (plugin still loads): bad contractVersion",
  },
  {
    name: "13 host_mode_field_dropped args",
    e: man({ code: "host_mode_field_dropped", index: 2, field: "args", reason: "not an array" }),
    old: "/x/manifest.json: hostModes[2].args dropped (host mode still loads): not an array",
  },
  {
    name: "13 host_mode_field_dropped examples",
    e: man({ code: "host_mode_field_dropped", index: 0, field: "examples", reason: "x" }),
    old: "/x/manifest.json: hostModes[0].examples dropped (host mode still loads): x",
  },
  {
    name: "14 plugin_declares_no_contributions",
    e: ev("plugin-loader", {
      code: "plugin_declares_no_contributions",
      dir: "/h/plugins/empty",
      pluginId: "empty",
      keys: "tools, modes",
    }),
    old: '/h/plugins/empty: plugin "empty" declares no contributions (tools, modes) and ships no PROMPT.md; it will load but do nothing',
  },
]

describe("manifest warn renderers: old bytes from attrs", () => {
  for (const c of CASES) {
    test(c.name, () => {
      expect(diagnosticText(c.e)).toBe(c.old)
    })
  }
})

describe("code 3 sideband_entry_invalid: every field value", () => {
  for (const field of SIDEBAND_FIELDS) {
    test(field, () => {
      const e = man({ code: "sideband_entry_invalid", index: 1, field })
      expect(diagnosticText(e)).toBe(`sideband[1]:${field}`)
    })
  }
  test("the field list is the closed set of 12", () => {
    expect(SIDEBAND_FIELDS).toHaveLength(12)
  })
})

describe("unknown or missing code: generic fallback, never empty", () => {
  test("plugin.manifest unknown code", () => {
    expect(diagnosticText(man({ code: "zzz" }))).toBe("code=zzz manifestPath=/x/manifest.json")
  })
  test("plugin.manifest missing code", () => {
    expect(diagnosticText(man({ index: 1 }))).toBe("index=1 manifestPath=/x/manifest.json")
  })
  test("plugin-loader unknown code", () => {
    expect(diagnosticText(ev("plugin-loader", { code: "other", dir: "/d" }))).toBe(
      "code=other dir=/d",
    )
  })
  test("plugin-loader missing code", () => {
    expect(diagnosticText(ev("plugin-loader", { dir: "/d" }))).toBe("dir=/d")
  })
})

describe("dedupe key", () => {
  test("code 3 events with different field differ", () => {
    const a = man({ code: "sideband_entry_invalid", index: 1, field: "kind" })
    const b = man({ code: "sideband_entry_invalid", index: 1, field: "body" })
    expect(diagnosticKey(a)).not.toBe(diagnosticKey(b))
  })
  test("events that differ only in a volatile key are equal", () => {
    const a = man({ code: "sideband_owner_ignored", index: 0, attempt: 1 })
    const b = man({ code: "sideband_owner_ignored", index: 0, attempt: 2 })
    expect(diagnosticKey(a)).toBe(diagnosticKey(b))
  })
  test("index is stable: different index differs", () => {
    const a = man({ code: "sideband_owner_ignored", index: 0 })
    const b = man({ code: "sideband_owner_ignored", index: 1 })
    expect(diagnosticKey(a)).not.toBe(diagnosticKey(b))
  })
})
