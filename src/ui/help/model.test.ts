import { describe, expect, test } from "bun:test"
import type { HelpModelRow } from "@minimal-agent/core/plugin-api/types/cli-contract"
import { CLI_CONTRACT_VERSION } from "@minimal-agent/core/plugin-api/types/cli-contract"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { builtinRegistry } from "../../cli/registry/index.ts"
import { LEGACY_TERM_OVERRIDES, renderLegacyRoot } from "./legacy-root.ts"
import { buildHelpModel, flagTerm } from "./model.ts"
import { styleSummary, styleTerm, styleTitle } from "./style.ts"

const reg = builtinRegistry()
const model = buildHelpModel(reg, { program: { name: "minimal-agent", version: "9.9.9" } })

function allRows(): HelpModelRow[] {
  return model.sections.flatMap((s) => [
    ...(s.rows ?? []),
    ...(s.groups ?? []).flatMap((g) => g.rows),
  ])
}

describe("root help model (M-8c)", () => {
  test("is a root model of the current contract version", () => {
    expect(model.contractVersion).toBe(CLI_CONTRACT_VERSION)
    expect(model.kind).toBe("root")
    expect(model.path).toEqual([])
    expect(model.program).toEqual({ name: "minimal-agent", version: "9.9.9" })
  })

  test("section ids are in the legacy order", () => {
    expect(model.sections.map((s) => s.id)).toEqual([
      "header",
      "examples",
      "commands",
      "flags",
      "environment",
      "plugin-notes",
      "learn-more",
    ])
  })

  test("every row has source builtin", () => {
    const rows = allRows()
    expect(rows.length).toBeGreaterThan(100)
    for (const r of rows) expect(r.source).toBe("builtin")
  })

  test("every non-hidden global flag has exactly one row", () => {
    const terms = allRows().map((r) => r.term)
    for (const spec of reg.globalFlags.filter((f) => f.hidden !== true)) {
      const term =
        spec.name === LEGACY_TERM_OVERRIDES.helpRow.flag
          ? LEGACY_TERM_OVERRIDES.helpRow.term
          : flagTerm(spec)
      expect(terms.filter((t) => t === term)).toHaveLength(1)
    }
  })

  test("no hidden global flag has a row", () => {
    const terms = new Set(allRows().map((r) => r.term))
    for (const spec of reg.globalFlags.filter((f) => f.hidden === true)) {
      expect(terms.has(flagTerm(spec))).toBe(false)
    }
  })

  test("the legacy term override list has exactly 4 kinds (it only shrinks)", () => {
    expect(Object.keys(LEGACY_TERM_OVERRIDES)).toEqual([
      "stdinExample",
      "helpRow",
      "envValueSuffix",
      "envWildcard",
    ])
    expect(Object.keys(LEGACY_TERM_OVERRIDES)).toHaveLength(4)
  })

  test("the model is plain text: no ESC or C0 in any string", () => {
    const strings = [
      ...model.sections.flatMap((s) => [
        s.title,
        ...(s.text ?? []),
        ...(s.groups ?? []).map((g) => g.title),
      ]),
      ...allRows().flatMap((r) => [r.term, r.summary]),
    ]
    for (const s of strings) expect(s).not.toMatch(/[\u0000-\u001f]/u)
  })

  test("env rows: value suffix and one wildcard row for the hidden system-prompt names", () => {
    const env = model.sections.find((s) => s.id === "environment")?.rows ?? []
    const terms = env.map((r) => r.term)
    expect(terms).toContain("DEBUG=1")
    expect(terms).toContain("MINIMAL_AGENT_AUTO_ASK=0")
    expect(terms).toContain(LEGACY_TERM_OVERRIDES.envWildcard.name)
    expect(terms.filter((t) => t.startsWith("MINIMAL_AGENT_SYSTEM_"))).toEqual([
      LEGACY_TERM_OVERRIDES.envWildcard.name,
    ])
    expect(env).toHaveLength(reg.env.filter((e) => e.hidden !== true).length)
  })

  test("the command map joins the root group members", () => {
    const rows = model.sections.find((s) => s.id === "commands")?.rows ?? []
    expect(rows.map((r) => r.term)).toEqual([
      "providers · providers models · providers models-live",
      "sessions · sessions dump · resume · usage",
      "provider <id> login · logout · auth-status",
      "plugins · flags · spinners · help",
    ])
  })

  test("the catalog option is accepted and changes nothing in M-8c", () => {
    const withCatalog = buildHelpModel(reg, {
      program: { name: "minimal-agent", version: "9.9.9" },
      catalog: [],
    })
    expect(withCatalog).toEqual(model)
  })
})

describe("flagTerm", () => {
  test("short, aliases, value, optional, and negatable forms", () => {
    expect(
      flagTerm({ name: "model", short: "m", type: "string", valueName: "id", summary: "" }),
    ).toBe("-m, --model <id>")
    expect(flagTerm({ name: "format", aliases: ["surface"], type: "string", summary: "" })).toBe(
      "--format, --surface <value>",
    )
    expect(
      flagTerm({ name: "x", type: "string", value: "optional", valueName: "id", summary: "" }),
    ).toBe("--x [<id>]")
    expect(flagTerm({ name: "header", type: "boolean", negatable: true, summary: "" })).toBe(
      "--header / --no-header",
    )
    expect(flagTerm({ name: "fast", short: "F", type: "boolean", summary: "" })).toBe("-F, --fast")
  })
})

describe("renderLegacyRoot", () => {
  test("color and plain output have the same visible text", () => {
    const colored = renderLegacyRoot(model, { width: 80 })
    const plain = renderLegacyRoot(model, { width: 80, color: false })
    expect(colored.map(stripAnsi)).toEqual(plain)
    expect(plain.join("\n")).not.toMatch(/\u001b/u)
  })

  test("the header uses the program version", () => {
    const plain = renderLegacyRoot(model, { color: false })
    expect(plain[1]).toBe("  minimal-agent v9.9.9")
  })
})

describe("style", () => {
  test("styles keep the visible text", () => {
    for (const s of ["-m, --model <id>", "$ minimal-agent -", "a / b · c | d", "x, y"]) {
      expect(stripAnsi(styleTerm(s))).toBe(s)
    }
    for (const s of ["Sum (a (b) c)", "Sum", "(only)", "f(x)", "a) b"]) {
      expect(stripAnsi(styleSummary(s))).toBe(s)
    }
    for (const s of ["Env", "Auth (note)"]) expect(stripAnsi(styleTitle(s))).toBe(s)
  })

  test("a trailing note in a summary is dim, the text before it is plain", () => {
    expect(styleSummary("Sum (a, b)")).toBe("Sum \u001b[2m(a, b)\u001b[22m")
    expect(styleSummary("f(x)")).toBe("f(x)")
  })
})
