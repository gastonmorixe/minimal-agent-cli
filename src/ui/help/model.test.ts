import { describe, expect, test } from "bun:test"
import type {
  HelpModel,
  HelpModelRow,
  HelpModelSection,
} from "@minimal-agent/core/plugin-api/types/cli-contract"
import { CLI_CONTRACT_VERSION } from "@minimal-agent/core/plugin-api/types/cli-contract"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { builtinRegistry } from "../../cli/registry/index.ts"
import { LEGACY_TERM_OVERRIDES, renderLegacyRoot } from "./legacy-root.ts"
import {
  buildCommandHelpModel,
  buildHelpModel,
  COMMAND_SECTION_ORDER,
  flagTerm,
  visibleCommandPaths,
} from "./model.ts"
import { renderModel } from "./render-model.ts"
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

describe("command help model (M-9b, spec 8.5)", () => {
  const program = { name: "minimal-agent", version: "9.9.9" }
  const cmd = (path: string[]): HelpModel => buildHelpModel(reg, { program, path })
  const section = (m: HelpModel, id: string): HelpModelSection | undefined =>
    m.sections.find((s) => s.id === id)

  test("a non-empty path gives a command model with the canonical path", () => {
    const m = cmd(["sessions"])
    expect(m.kind).toBe("command")
    expect(m.path).toEqual(["sessions"])
    expect(m.contractVersion).toBe(CLI_CONTRACT_VERSION)
    expect(buildCommandHelpModel(reg, ["sessions"], program)).toEqual(m)
  })

  test("section ids of every visible path follow the 8.5 order", () => {
    const paths = visibleCommandPaths(reg)
    expect(paths.length).toBeGreaterThan(20)
    for (const path of paths) {
      const ids = cmd(path).sections.map((s) => s.id)
      const ranks = ids.map((id) => COMMAND_SECTION_ORDER.indexOf(id as never))
      expect(ranks.every((r) => r >= 0)).toBe(true)
      expect(ranks).toEqual(ranks.toSorted((a, b) => a - b))
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids[0]).toBe("header")
      expect(ids).toContain("usage")
      expect(ids).toContain("global-flags")
    }
  })

  test("the order constant is the spec 8.5 list", () => {
    expect([...COMMAND_SECTION_ORDER]).toEqual([
      "header",
      "usage",
      "arguments",
      "commands",
      "flags",
      "global-flags",
      "environment",
      "examples",
      "see-also",
    ])
  })

  test("a path with every section keeps the full 8.5 order", () => {
    // `models` (hidden) has args, children, flags, env, and seeAlso. Only
    // examples are missing, so check that one apart on `sessions`.
    expect(cmd(["models"]).sections.map((s) => s.id)).toEqual([
      "header",
      "usage",
      "arguments",
      "commands",
      "flags",
      "global-flags",
      "environment",
      "see-also",
    ])
    expect(cmd(["sessions"]).sections.map((s) => s.id)).toEqual([
      "header",
      "usage",
      "arguments",
      "commands",
      "global-flags",
      "examples",
    ])
  })

  test("empty sections are left out", () => {
    const ids = cmd(["flags", "list"]).sections.map((s) => s.id)
    expect(ids).toEqual(["header", "usage", "global-flags"])
  })

  test("header: program and path, then summary and description", () => {
    const h = section(cmd(["resume"]), "header")
    expect(h?.title).toBe("minimal-agent resume")
    expect(h?.text?.[0]).toBe("Resume a saved session")
    expect(h?.text?.length).toBe(3)
  })

  test("usage: the spec override with the program prefix, plus a command line for children", () => {
    expect(section(cmd(["sessions"]), "usage")?.text).toEqual([
      "minimal-agent sessions [list|query]",
      "minimal-agent sessions <command> [args] [flags]",
    ])
    expect(section(cmd(["provider"]), "usage")?.text).toEqual([
      "minimal-agent provider <id> <command>",
    ])
  })

  test("usage: generated from args and flags when no override", () => {
    const spec = { name: "x", summary: "X" }
    const r = {
      ...reg,
      root: {
        ...reg.root,
        commands: [
          {
            name: "demo",
            summary: "Demo",
            args: [
              { name: "a", summary: "A", required: true },
              { name: "b", summary: "B", variadic: true },
            ],
            flags: [{ name: "f", type: "boolean" as const, summary: "F" }],
            commands: [spec],
          },
        ],
      },
    }
    expect(section(buildCommandHelpModel(r, ["demo"], program), "usage")?.text).toEqual([
      "minimal-agent demo <a> [<b>...] [flags]",
      "minimal-agent demo <a> <command> [args] [flags]",
    ])
    expect(section(buildCommandHelpModel(r, ["demo", "x"], program), "usage")?.text).toEqual([
      "minimal-agent demo <a> x",
    ])
  })

  test("arguments list choices after the summary", () => {
    const rows = section(cmd(["usage"]), "arguments")?.rows ?? []
    expect(rows).toHaveLength(1)
    expect(rows[0]?.term).toBe("period")
    expect(rows[0]?.summary).toMatch(/^Time window of the stats \(one of: /u)
  })

  test("commands: visible children with required args, hidden children left out", () => {
    const terms = (section(cmd(["sessions"]), "commands")?.rows ?? []).map((r) => r.term)
    expect(terms).toEqual(["list", "dump <sid>", "resume <sid>", "resume-same <sid>"])
    const r = {
      ...reg,
      root: {
        ...reg.root,
        commands: [
          {
            name: "p",
            summary: "P",
            commands: [
              { name: "shown", summary: "S" },
              { name: "secret", summary: "H", hidden: true },
            ],
          },
        ],
      },
    }
    const rows = section(buildCommandHelpModel(r, ["p"], program), "commands")?.rows ?? []
    expect(rows.map((x) => x.term)).toEqual(["shown"])
    expect(buildCommandHelpModel(r, ["p", "secret"], program).path).toEqual(["p", "secret"])
  })

  test("a hidden top-level command renders by path but is not a visible path", () => {
    expect(cmd(["models"]).path).toEqual(["models"])
    const visible = visibleCommandPaths(reg).map((p) => p.join(" "))
    expect(visible).not.toContain("models")
    expect(visible).not.toContain("models-live")
    expect(visible).toContain("providers models")
  })

  test("flags: one plain list when the flags have one group or none", () => {
    const f = section(cmd(["auth-status", "plan"]), "flags")
    expect(f?.groups).toBeUndefined()
    expect((f?.rows ?? []).map((r) => r.term)).toEqual([
      "--all",
      "--table",
      "--parallel <n>",
      "--name <n>",
    ])
  })

  test("flags: two or more groups render as titled groups in flagGroups order", () => {
    const r = {
      ...reg,
      root: {
        ...reg.root,
        commands: [
          {
            name: "g",
            summary: "G",
            flags: [
              { name: "plain", type: "boolean" as const, summary: "P" },
              { name: "dbg", type: "boolean" as const, summary: "D", group: "debug" },
              { name: "mdl", type: "string" as const, summary: "M", group: "model" },
              { name: "gone", type: "boolean" as const, summary: "H", hidden: true },
            ],
          },
        ],
      },
    }
    const f = section(buildCommandHelpModel(r, ["g"], program), "flags")
    expect((f?.rows ?? []).map((x) => x.term)).toEqual(["--plain"])
    expect((f?.groups ?? []).map((g) => [g.title, g.rows.map((x) => x.term)])).toEqual([
      ["Model", ["--mdl <value>"]],
      ["Debug", ["--dbg"]],
    ])
  })

  test("global flags: the pointer line plus -h and -d", () => {
    const g = section(cmd(["sessions", "dump"]), "global-flags")
    expect(g?.text).toEqual(["See minimal-agent --help for all global flags."])
    expect((g?.rows ?? []).map((r) => r.term)).toEqual(["-h, --help", "-d, --debug"])
  })

  test("environment: env that backs a command flag", () => {
    const rows = section(cmd(["providers", "models"]), "environment")?.rows ?? []
    expect(rows.map((r) => r.term)).toEqual(["MINIMAL_AGENT_PRINT_FORMAT"])
    const plugins = section(cmd(["plugins"]), "environment")?.rows ?? []
    expect(plugins.map((r) => r.term)).toEqual([
      "MINIMAL_AGENT_DISABLE_PLUGINS",
      "MINIMAL_AGENT_ENABLE_PLUGINS",
    ])
  })

  test("examples and see also carry the program name", () => {
    const ex = section(cmd(["sessions"]), "examples")?.rows ?? []
    expect(ex.map((r) => r.term)).toEqual([
      "minimal-agent sessions auth",
      "minimal-agent sessions dump last",
    ])
    expect(section(cmd(["models"]), "see-also")?.text).toEqual(["minimal-agent providers models"])
  })

  test("every row has source builtin and the model is plain text", () => {
    for (const path of visibleCommandPaths(reg)) {
      for (const s of cmd(path).sections) {
        const rows = [...(s.rows ?? []), ...(s.groups ?? []).flatMap((g) => g.rows)]
        for (const r of rows) expect(r.source).toBe("builtin")
        const strings = [s.title, ...(s.text ?? []), ...rows.flatMap((r) => [r.term, r.summary])]
        for (const str of strings) expect(str).not.toMatch(/[\u0000-\u001f]/u)
      }
    }
  })

  test("an unknown path throws", () => {
    expect(() => cmd(["bogus"])).toThrow(/no command at "bogus"/u)
  })

  test("an empty path still gives the root model", () => {
    expect(buildHelpModel(reg, { program, path: [] })).toEqual(model)
  })
})

describe("renderModel", () => {
  const program = { name: "minimal-agent", version: "9.9.9" }

  test("color and plain output have the same visible text", () => {
    const m = buildHelpModel(reg, { program, path: ["sessions"] })
    const colored = renderModel(m, { width: 80, color: true })
    const plain = renderModel(m, { width: 80, color: false })
    expect(colored.map(stripAnsi)).toEqual(plain)
    expect(colored.join("\n")).toMatch(/\u001b\[/u)
    expect(plain.join("\n")).not.toMatch(/\u001b/u)
  })

  test("layout: title at 2, text and rows at 4, a blank line between sections", () => {
    const plain = renderModel(buildHelpModel(reg, { program, path: ["sessions"] }), { width: 80 })
    expect(plain[0]).toBe("  minimal-agent sessions")
    expect(plain[1]).toBe("    List saved sessions")
    const usage = plain.indexOf("  USAGE")
    expect(plain[usage - 1]).toBe("")
    expect(plain[usage + 1]).toBe("    minimal-agent sessions [list|query]")
  })

  test("group titles at 4 and their rows at 6", () => {
    const m: HelpModel = {
      contractVersion: CLI_CONTRACT_VERSION,
      kind: "command",
      program,
      path: ["g"],
      sections: [
        { id: "header", title: "minimal-agent g", text: ["G"] },
        {
          id: "flags",
          title: "FLAGS",
          groups: [{ title: "Model", rows: [{ term: "--m", summary: "M", source: "builtin" }] }],
        },
      ],
    }
    expect(renderModel(m, { width: 80 })).toEqual([
      "  minimal-agent g",
      "    G",
      "",
      "  FLAGS",
      "    Model",
      "      --m  M",
    ])
  })

  test("renders a root model too", () => {
    const lines = renderModel(model, { width: 80 })
    expect(lines[0]).toBe("  minimal-agent v9.9.9")
    expect(lines.join("\n")).not.toMatch(/\u001b/u)
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
