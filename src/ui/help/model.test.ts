import { describe, expect, test } from "bun:test"
import type {
  FlagSpec,
  HelpModel,
  HelpModelRow,
  HelpModelSection,
} from "@minimal-agent/core/plugin-api/types/cli-contract"
import { CLI_CONTRACT_VERSION } from "@minimal-agent/core/plugin-api/types/cli-contract"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { builtinRegistry } from "../../cli/registry/index.ts"
import {
  buildCommandHelpModel,
  buildHelpModel,
  COMMAND_SECTION_ORDER,
  flagTerm,
  ROOT_SECTION_ORDER,
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

describe("root help model (M-8d, spec 8.4)", () => {
  const section = (id: string): HelpModelSection | undefined =>
    model.sections.find((s) => s.id === id)

  test("is a root model of the current contract version", () => {
    expect(model.contractVersion).toBe(CLI_CONTRACT_VERSION)
    expect(model.kind).toBe("root")
    expect(model.path).toEqual([])
    expect(model.program).toEqual({ name: "minimal-agent", version: "9.9.9" })
  })

  test("section ids follow the 8.4 order, empty plugin sections left out", () => {
    const ids = model.sections.map((s) => s.id)
    expect(ids).toEqual([
      "header",
      "usage",
      "examples",
      "commands",
      "flags",
      "environment",
      "plugin-notes",
      "learn-more",
    ])
    const ranks = ids.map((id) => ROOT_SECTION_ORDER.indexOf(id as never))
    expect(ranks).toEqual(ranks.toSorted((a, b) => a - b))
  })

  test("the order constant is the spec 8.4 list", () => {
    expect([...ROOT_SECTION_ORDER]).toEqual([
      "header",
      "usage",
      "examples",
      "commands",
      "plugin-commands",
      "host-modes",
      "flags",
      "environment",
      "plugin-notes",
      "learn-more",
    ])
  })

  test("titles are upper case, as in the 8.6 mock", () => {
    for (const s of model.sections.filter((x) => x.id !== "header")) {
      expect(s.title).toBe(s.title.toUpperCase())
    }
  })

  test("header: name and version, then the tagline only", () => {
    expect(section("header")?.title).toBe("minimal-agent v9.9.9")
    expect(section("header")?.text).toEqual([reg.root.summary])
  })

  test("usage: two lines with the program prefix", () => {
    expect(section("usage")?.text).toEqual([
      "minimal-agent [flags] [prompt]",
      "minimal-agent <command> [args] [flags]",
    ])
  })

  test("examples: the program name plus argv, no $ prompt", () => {
    const terms = (section("examples")?.rows ?? []).map((r) => r.term)
    expect(terms).toEqual([
      "minimal-agent",
      'minimal-agent "explain this codebase"',
      "minimal-agent -",
    ])
  })

  test("every row has source builtin", () => {
    const rows = allRows()
    expect(rows.length).toBeGreaterThan(80)
    for (const r of rows) expect(r.source).toBe("builtin")
  })

  test("commands: one row per visible top-level command, grouped by root group", () => {
    const cmds = section("commands")
    const listed = [...(cmds?.rows ?? []), ...(cmds?.groups ?? []).flatMap((g) => g.rows)].map(
      (r) => r.term.split(" ")[0],
    )
    const visible = reg.commands.filter((c) => c.hidden !== true).map((c) => c.name)
    expect(listed.toSorted()).toEqual(visible.toSorted())
    expect((cmds?.groups ?? []).map((g) => g.title)).toEqual(reg.rootGroups.map((g) => g.title))
    for (const r of cmds?.groups?.flatMap((g) => g.rows) ?? []) {
      expect(r.term).not.toContain("·")
    }
  })

  test("flags: every visible global flag has exactly one row, grouped by FlagSpec.group", () => {
    const flags = section("flags")
    const rows = [...(flags?.rows ?? []), ...(flags?.groups ?? []).flatMap((g) => g.rows)]
    const terms = rows.map((r) => r.term)
    const visible = reg.globalFlags.filter((f) => f.hidden !== true)
    for (const spec of visible) {
      expect(terms.filter((t) => t === flagTerm(spec))).toHaveLength(1)
    }
    expect(rows).toHaveLength(visible.length)
    expect(flags?.rows ?? []).toEqual([])
    const used = new Set(visible.map((f) => f.group))
    const titles = reg.flagGroups
      .filter((g) => used.has(g.id))
      .map((g) => (g.note === undefined ? g.title : `${g.title} (${g.note})`))
    expect((flags?.groups ?? []).map((g) => g.title)).toEqual(titles)
  })

  test("no hidden global flag has a row", () => {
    const terms = new Set(allRows().map((r) => r.term))
    for (const spec of reg.globalFlags.filter((f) => f.hidden === true)) {
      expect(terms.has(flagTerm(spec))).toBe(false)
    }
  })

  test("a flag row shows the summary and notes from default and env, not the description", () => {
    const rows = section("flags")?.groups?.flatMap((g) => g.rows) ?? []
    const by = (term: string): string | undefined => rows.find((r) => r.term === term)?.summary
    expect(by("-m, --model <id>")).toBe("Select the model (env: MINIMAL_AGENT_MODEL)")
    expect(by("--cache-ttl <5m|1h>")).toBe(
      "Prompt-cache breakpoint TTL (default: 5m; env: MINIMAL_AGENT_CACHE_TTL)",
    )
    expect(by("--system-identity <text>")).toBe(
      "Replace the neutral identity block (also --system-identity-file <path>, " +
        "--no-system-identity; env: MINIMAL_AGENT_SYSTEM_IDENTITY)",
    )
    for (const spec of reg.globalFlags.filter((f) => f.hidden !== true)) {
      for (const p of spec.description ?? []) {
        expect(by(flagTerm(spec)) ?? "").not.toContain(p)
      }
    }
  })

  describe("flag notes: one clause per kind, joined with '; ' (choices, default, env)", () => {
    const base: FlagSpec = {
      name: "x-note",
      type: "string",
      value: "required",
      valueName: "v",
      summary: "Probe",
      group: "model",
      global: true,
    }
    const noteOf = (extra: Partial<FlagSpec>): string | undefined => {
      const spec: FlagSpec = { ...base, ...extra }
      const m = buildHelpModel(
        { ...reg, globalFlags: [...reg.globalFlags, spec] },
        { program: { name: "minimal-agent", version: "9.9.9" } },
      )
      const rows = m.sections.flatMap((s) => s.groups ?? []).flatMap((g) => g.rows)
      return rows.find((r) => r.term === flagTerm(spec))?.summary
    }

    test("choices and env", () => {
      expect(noteOf({ choices: ["a", "b"], env: "X_ENV" })).toBe("Probe (one of: a, b; env: X_ENV)")
    })

    test("default and env", () => {
      expect(noteOf({ default: "5m", env: "X_ENV" })).toBe("Probe (default: 5m; env: X_ENV)")
    })

    test("choices, default, and env, in that order", () => {
      expect(noteOf({ choices: ["a", "b", "c"], default: "b", env: "X_ENV" })).toBe(
        "Probe (one of: a, b, c; default: b; env: X_ENV)",
      )
    })

    test("env only keeps the plain form", () => {
      expect(noteOf({ env: "X_ENV" })).toBe("Probe (env: X_ENV)")
    })

    test("choices only keeps the plain form", () => {
      expect(noteOf({ choices: ["a", "b"] })).toBe("Probe (one of: a, b)")
    })

    test("real rows: the env never reads like one more choice", () => {
      const rows = section("flags")?.groups?.flatMap((g) => g.rows) ?? []
      const by = (term: string): string | undefined => rows.find((r) => r.term === term)?.summary
      expect(by("--thinking-display <mode>")).toBe(
        "Force the thinking display mode (one of: summarized, omitted; " +
          "env: MINIMAL_AGENT_THINKING_DISPLAY)",
      )
      expect(by("--auth-type <type>")).toBe(
        "Generic endpoint auth type (one of: api-key, bearer, none, custom-header; " +
          "env: MINIMAL_AGENT_AUTH_TYPE)",
      )
      for (const r of allRows()) expect(r.summary).not.toMatch(/, (env|default): /u)
    })
  })

  test("env rows: bare names, the value hint in the summary", () => {
    const env = section("environment")?.rows ?? []
    const terms = env.map((r) => r.term)
    expect(terms.filter((t) => t.includes("="))).toEqual([])
    expect(env.find((r) => r.term === "DEBUG")?.summary).toContain("set to 1")
    expect(env.find((r) => r.term === "MINIMAL_AGENT_AUTO_ASK")?.summary).toContain("set to 0")
    expect(terms.filter((t) => t.startsWith("MINIMAL_AGENT_SYSTEM_"))).toEqual([
      "MINIMAL_AGENT_SYSTEM_*",
    ])
    expect(env).toHaveLength(reg.env.filter((e) => e.hidden !== true).length)
  })

  test("learn more: the command help hint, the JSON hint, and the project URL", () => {
    expect(section("learn-more")?.text).toEqual([
      "Use minimal-agent help <command> for command help.",
      "minimal-agent --help --json prints this help as JSON",
      "github.com/gastonmorixe/minimal-agent",
    ])
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

  test("the catalog option is accepted and changes nothing yet", () => {
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
      "flags",
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
      "minimal-agent sessions [list|<query>] [--limit <n>] [--page <n>] [--all]",
      "minimal-agent sessions [<query>] [--since <age>] [--cwd <dir>] [--json]",
      "minimal-agent sessions <sid|last> [--json]",
      "minimal-agent sessions --backfill-lineage [--dry-run] [--since <age>] [--json]",
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
      "minimal-agent sessions",
      "minimal-agent sessions auth",
      "minimal-agent sessions --since 2d --cwd .",
      "minimal-agent sessions --limit 10 --page 2",
      "minimal-agent sessions e5fc350a",
      "minimal-agent sessions last",
      "minimal-agent sessions --backfill-lineage --dry-run",
      "minimal-agent sessions resume last",
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
    expect(plain[usage + 1]).toBe(
      "    minimal-agent sessions [list|<query>] [--limit <n>] [--page <n>] [--all]",
    )
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

  test("root model: header at 2 and 4, then USAGE, as in the 8.6 mock", () => {
    const lines = renderModel(model, { width: 80 })
    expect(lines.slice(0, 7)).toEqual([
      "  minimal-agent v9.9.9",
      "    A small, inspectable terminal agent harness.",
      "",
      "  USAGE",
      "    minimal-agent [flags] [prompt]",
      "    minimal-agent <command> [args] [flags]",
      "",
    ])
    expect(lines.join("\n")).not.toMatch(/\u001b/u)
  })

  test("root model: color and plain output have the same visible text", () => {
    const colored = renderModel(model, { width: 80, color: true })
    const plain = renderModel(model, { width: 80, color: false })
    expect(colored.map(stripAnsi)).toEqual(plain)
    expect(colored[0]).toContain("\u001b[2mv9.9.9")
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
