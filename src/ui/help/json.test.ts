/**
 * JSON help (SPEC-HELP R-30, Q-4, V-13, plan M-11): the flag switch and the
 * serialized model.
 *
 * @module ui/help/json.test
 */

import { describe, expect, test } from "bun:test"
import {
  CLI_CONTRACT_VERSION,
  type HelpModel,
} from "@minimal-agent/core/plugin-api/types/cli-contract"

import { builtinRegistry } from "../../cli/registry/index.ts"
import { helpModelJson, wantsJsonHelp } from "./json.ts"
import { buildHelpModel, COMMAND_SECTION_ORDER, ROOT_SECTION_ORDER } from "./model.ts"

/** Every string value in a parsed JSON value, depth first. */
function jsonStrings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(jsonStrings)
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [k, ...jsonStrings(v)])
  }
  return []
}

/** ESC or any other C0 control char (tab and newline included). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the test looks for control chars
const CONTROL = /[\u0000-\u001f\u007f]/u

const reg = builtinRegistry()

describe("wantsJsonHelp (Q-4)", () => {
  test("--json and --output-format json select JSON", () => {
    expect(wantsJsonHelp(["--help", "--json"])).toBe(true)
    expect(wantsJsonHelp(["--help", "--output-format", "json"])).toBe(true)
    expect(wantsJsonHelp(["--help", "--output-format=json"])).toBe(true)
  })

  test("no flag, text, stream-json, and --format json select text", () => {
    expect(wantsJsonHelp(["--help"])).toBe(false)
    expect(wantsJsonHelp(["--help", "--output-format", "text"])).toBe(false)
    expect(wantsJsonHelp(["--help", "--output-format", "stream-json"])).toBe(false)
    expect(wantsJsonHelp(["--help", "--format", "json"])).toBe(false)
    expect(wantsJsonHelp(["--help", "--format=json"])).toBe(false)
  })

  test("a valid --output-format value wins over --json, like a run", () => {
    expect(wantsJsonHelp(["--help", "--json", "--output-format", "text"])).toBe(false)
    expect(wantsJsonHelp(["--help", "--json", "--output-format", "bogus"])).toBe(true)
  })
})

describe("helpModelJson (R-30)", () => {
  const model = buildHelpModel(reg, { program: { name: "minimal-agent", version: "9.9.9" } })
  const text = helpModelJson(model)

  test("is the model with a two-space indent and one trailing newline", () => {
    expect(text).toBe(`${JSON.stringify(model, null, 2)}\n`)
    expect(text.endsWith("}\n")).toBe(true)
    expect(text.endsWith("\n\n")).toBe(false)
  })

  test("root JSON parses, kind root, the core contract version", () => {
    const parsed = JSON.parse(text) as HelpModel
    expect(parsed).toEqual(model)
    expect(parsed.kind).toBe("root")
    expect(parsed.contractVersion).toBe(CLI_CONTRACT_VERSION)
    expect(Object.keys(parsed)).toEqual(["contractVersion", "kind", "program", "path", "sections"])
    const order: readonly string[] = ROOT_SECTION_ORDER
    const ids = parsed.sections.map((s) => s.id as string)
    expect(ids).toEqual(order.filter((id) => ids.includes(id)))
  })

  test("command JSON keeps the spec 8.5 section order", () => {
    const parsed = JSON.parse(helpModelJson(buildHelpModel(reg, { path: ["sessions"] })))
    const ids = (parsed as HelpModel).sections.map((s) => s.id as string)
    const order: readonly string[] = COMMAND_SECTION_ORDER
    expect(ids).toEqual(order.filter((id) => ids.includes(id)))
  })

  test("no string holds ESC or a C0 control char", () => {
    for (const s of jsonStrings(JSON.parse(text))) expect(s).not.toMatch(CONTROL)
  })
})
