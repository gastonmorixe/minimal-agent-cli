/**
 * JSON help output (SPEC-HELP R-30, Q-4, plan M-11).
 *
 * `--help --output-format json` prints the {@link HelpModel} as JSON.
 * `--help --json` is an alias. `--format` is not the switch: it selects the
 * endpoint surface (Q-4). The JSON is the model object exactly, with
 * `contractVersion`, so JSON readers can check the shape. No color, no wrap:
 * the model holds plain text only (R-3).
 *
 * Pure: no I/O, no handler import.
 *
 * @module ui/help/json
 */

import type { HelpModel } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { resolveOutputFormat } from "../../cli/output-format.ts"

/** The value of `--output-format` in raw argv: `--output-format x` or `--output-format=x`. */
function outputFormatValue(raw: readonly string[]): string | undefined {
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i] ?? ""
    if (token === "--output-format") return raw[i + 1]
    if (token.startsWith("--output-format=")) return token.slice("--output-format=".length)
  }
  return undefined
}

/**
 * True when raw argv asks for JSON help. The same precedence as a run
 * (`resolveOutputFormat`): a valid `--output-format` value wins, then the
 * `--json` alias, then text. Only `json` selects JSON help. `text` and
 * `stream-json` give text help. `--format json` gives text help (Q-4).
 */
export function wantsJsonHelp(raw: readonly string[]): boolean {
  const format = resolveOutputFormat({
    outputFormatFlag: outputFormatValue(raw),
    jsonFlag: raw.includes("--json"),
  })
  return format === "json"
}

/** The help model as JSON: two-space indent and a trailing newline. */
export function helpModelJson(model: HelpModel): string {
  return `${JSON.stringify(model, null, 2)}\n`
}
