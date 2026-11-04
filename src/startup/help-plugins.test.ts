/**
 * Plugin sections of help (SPEC-HELP R-11, R-12, R-19, R-22, V-11, V-12,
 * plan M-10).
 *
 * Every run reads the fixture plugin root (`fixtures/help-plugins`) through
 * the `helpCatalog` seam of `prepareEntrypointArgs`, so the result does not
 * depend on the plugins of the machine. The fixture holds manifests only.
 *
 * @module startup/help-plugins.test
 */

import { describe, expect, test } from "bun:test"
import type { CatalogCliEntry, HelpModel } from "@minimal-agent/core/plugin-api/types/cli-contract"
import { builtinRegistry } from "../cli/registry/index.ts"
import { findHostMode, hostModeRows, pluginNoteGroups } from "../cli/registry/plugins.ts"
import { resolveHelpRequest } from "../cli/registry/resolve.ts"
import { prepareEntrypointArgs } from "./entry-args.ts"
import { fixtureHelpCatalog } from "./fixtures/help-catalog.ts"

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

const ENV = { NO_COLOR: "1", COLUMNS: "100" }
const CATALOG = fixtureHelpCatalog()

interface RunResult {
  readonly code: number | undefined
  readonly stdout: string
  readonly stderr: string
  readonly catalogReads: number
}

function run(rawArgv: string[], catalog: readonly CatalogCliEntry[] = CATALOG): RunResult {
  const out: string[] = []
  const err: string[] = []
  let code: number | undefined
  let catalogReads = 0
  try {
    prepareEntrypointArgs({
      rawArgv,
      env: { ...ENV },
      cwd: "/tmp",
      helpCatalog: () => {
        catalogReads++
        return catalog
      },
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => (err.push(s), true) as unknown as boolean },
      exit: (c: number): never => {
        throw new ExitSignal(c)
      },
    })
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code
    else throw e
  }
  return { code, stdout: out.join(""), stderr: err.join(""), catalogReads }
}

/** The lines of one root section, from its title to the next blank line. */
function sectionOf(stdout: string, title: string): string[] {
  const lines = stdout.split("\n")
  const start = lines.indexOf(`  ${title}`)
  if (start < 0) return []
  const end = lines.indexOf("", start)
  return lines.slice(start, end < 0 ? undefined : end)
}

describe("the fixture catalog (gates from core)", () => {
  test("plugins and host-mode gates", () => {
    const byId = new Map(CATALOG.map((e) => [e.pluginId, e]))
    expect([...byId.keys()]).toEqual(["alpha", "beta", "delta", "gamma"])
    expect(byId.get("alpha")?.hostModes[0]?.disabled).toBeUndefined()
    // V-11 for host modes: beta declares `acp` too, alpha loads first.
    expect(byId.get("beta")?.hostModes.map((h) => [h.id, h.disabled])).toEqual([
      ["acp", "collision"],
      ["beta-rpc", undefined],
    ])
    expect(byId.get("gamma")?.hostModes[0]?.disabled).toBe("permission")
    expect(byId.get("delta")?.effectiveOn).toBe(false)
    expect(byId.get("delta")?.note).toBe("manifest")
  })
})

describe("HOST MODES (8.4 row 6)", () => {
  test("root help lists only usable host modes, with the plugin id", () => {
    const r = run(["--help"])
    expect(r.code).toBe(0)
    expect(sectionOf(r.stdout, "HOST MODES")).toEqual([
      "  HOST MODES",
      "    acp       Agent Client Protocol v1 over stdio. (from plugin alpha)",
      "    beta-rpc  Beta JSON-RPC over stdio. (from plugin beta)",
    ])
  })

  test("HOST MODES sits after COMMANDS and before FLAGS", () => {
    const { stdout } = run(["--help"])
    const at = (t: string): number => stdout.indexOf(`\n  ${t}\n`)
    expect(at("COMMANDS")).toBeLessThan(at("HOST MODES"))
    expect(at("HOST MODES")).toBeLessThan(at("FLAGS"))
  })

  test("V-12: disabled host modes show only with --help --all, with the reason", () => {
    const plain = sectionOf(run(["--help"]).stdout, "HOST MODES").join("\n")
    for (const id of ["gamma-mode", "delta-mode", "disabled:"]) expect(plain).not.toContain(id)
    const all = run(["--help", "--all"])
    expect(all.code).toBe(0)
    const lines = sectionOf(all.stdout, "HOST MODES").join("\n")
    expect(lines).toMatch(/acp +A second ACP host mode\. The loader keeps the first one\./u)
    expect(lines).toMatch(/from plugin beta; disabled:\s+collision\)/u)
    expect(lines).toMatch(/gamma-mode .*\(from plugin gamma; disabled: permission\)/u)
    expect(lines).toMatch(/delta-mode .*\(from plugin delta; disabled: manifest\)/u)
  })

  test("the row model marks a disabled row with state and note", () => {
    const rows = hostModeRows(CATALOG, { all: true })
    const gamma = rows.find((r) => r.term === "gamma-mode")
    expect(gamma).toMatchObject({ source: "plugin:gamma", state: "disabled", note: "permission" })
    expect(hostModeRows(CATALOG).every((r) => r.state === undefined)).toBe(true)
  })

  test("a CLI disable turns a plugin off with reason cli", () => {
    const catalog = fixtureHelpCatalog({ cli: { disable: ["alpha"] } })
    // alpha is off, so beta's acp claims the id and is usable.
    expect(hostModeRows(catalog).map((r) => r.summary)).toEqual([
      "A second ACP host mode. The loader keeps the first one. (from plugin beta)",
      "Beta JSON-RPC over stdio. (from plugin beta)",
    ])
    const alpha = hostModeRows(catalog, { all: true }).find((r) => r.source === "plugin:alpha")
    expect(alpha?.note).toBe("cli")
  })

  test("an empty catalog prints no HOST MODES section", () => {
    expect(run(["--help"], []).stdout).not.toContain("HOST MODES")
  })
})

describe("PLUGIN NOTES (8.4 row 9, R-11)", () => {
  test("the static block comes first, then plugin sections by plugin id, then declared order", () => {
    const lines = sectionOf(run(["--help"]).stdout, "PLUGIN NOTES")
    const text = lines.join("\n")
    expect(lines[1]).toBe("    Enable and disable precedence: CLI → env → config → manifest.")
    const notes = text.indexOf("    Alpha notes (from plugin alpha)")
    const limits = text.indexOf("    Alpha limits (from plugin alpha)")
    expect(text.indexOf("    Disabled          interleave-thinking")).toBeLessThan(notes)
    expect(notes).toBeLessThan(limits)
    expect(text).toContain("      Alpha runs as an ACP agent for editors.")
    expect(text).toContain("      Zed  Set the agent command to minimal-agent --host-mode acp")
    expect(text).not.toContain("Delta notes")
    expect(text).not.toContain("Disabled plugins")
  })

  test("--all adds the sections of off plugins and a Disabled plugins group", () => {
    const text = sectionOf(run(["--help", "--all"]).stdout, "PLUGIN NOTES").join("\n")
    expect(text).toContain("    Delta notes (from plugin delta; disabled: manifest)")
    expect(text).toContain("    Disabled plugins")
    expect(text).toContain("      delta  disabled: manifest")
    const groups = pluginNoteGroups(CATALOG, { all: true }).map((g) => g.title)
    expect(groups).toEqual([
      "Alpha notes (from plugin alpha)",
      "Alpha limits (from plugin alpha)",
      "Delta notes (from plugin delta; disabled: manifest)",
      "Disabled plugins",
    ])
  })
})

describe("--all only in help mode (R-12)", () => {
  test("auth-status plan --all is not a help request", () => {
    expect(resolveHelpRequest(["auth-status", "plan", "--all"], builtinRegistry())).toBeUndefined()
  })

  test("--help --all and help --all set all on root help", () => {
    const reg = builtinRegistry()
    expect(resolveHelpRequest(["--help", "--all"], reg)).toEqual({
      kind: "help",
      path: [],
      all: true,
    })
    expect(resolveHelpRequest(["help", "--all"], reg)).toEqual({
      kind: "help",
      path: [],
      all: true,
    })
  })

  test("command help reads no catalog", () => {
    const r = run(["sessions", "--help"])
    expect(r.code).toBe(0)
    expect(r.catalogReads).toBe(0)
    expect(run(["--help"]).catalogReads).toBe(1)
  })
})

describe("--host-mode <id> --help (R-19)", () => {
  test("the resolver selects host-mode help in both forms", () => {
    const reg = builtinRegistry()
    expect(resolveHelpRequest(["--host-mode", "acp", "--help"], reg)).toEqual({
      kind: "host-mode",
      id: "acp",
    })
    expect(resolveHelpRequest(["--help", "--host-mode=acp"], reg)).toEqual({
      kind: "host-mode",
      id: "acp",
    })
    // No help token: a normal run.
    expect(resolveHelpRequest(["--host-mode", "acp"], reg)).toBeUndefined()
  })

  test("prints command help: description, plugin id, args, examples", () => {
    const r = run(["--host-mode", "acp", "--help"])
    expect(r.code).toBe(0)
    expect(r.stderr).toBe("")
    expect(r.stdout).toBe(
      [
        "  minimal-agent --host-mode acp",
        "    Agent Client Protocol v1 over stdio.",
        "    From plugin alpha.",
        "    stdin and stdout carry the protocol. Logs go to stderr.",
        "",
        "  USAGE",
        "    minimal-agent --host-mode acp [<flags>...]",
        "",
        "  ARGUMENTS",
        "    flags  Args for the host mode, for example --approval",
        "",
        "  GLOBAL FLAGS",
        "    See minimal-agent --help for all global flags.",
        "    -h, --help   Show help",
        "    -d, --debug  Enable debug logging",
        "",
        "  EXAMPLES",
        "    minimal-agent --host-mode acp  Serve ACP on stdin and stdout.",
        "",
      ].join("\n"),
    )
  })

  test("-h gives the same bytes", () => {
    expect(run(["--host-mode", "acp", "-h"]).stdout).toBe(
      run(["--host-mode", "acp", "--help"]).stdout,
    )
  })

  test("a disabled host mode prints its help with the reason", () => {
    const r = run(["--host-mode", "gamma-mode", "--help"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("    From plugin gamma.")
    expect(r.stdout).toContain("    Disabled: permission. This host mode does not run.")
    expect(findHostMode(CATALOG, "acp")?.entry.pluginId).toBe("alpha")
  })

  test("an unknown id: same error format as an unknown command, exit 2", () => {
    const r = run(["--host-mode", "acx", "--help"])
    expect(r.code).toBe(2)
    expect(r.stdout).toBe("")
    expect(r.stderr).toBe(
      [
        'error: unknown host mode "acx" for "minimal-agent --host-mode"',
        'hint: did you mean "acp"? Run "minimal-agent --help" to see the host modes.',
        "",
      ].join("\n"),
    )
    const none = run(["--host-mode", "zzzzzz", "--help"])
    expect(none.code).toBe(2)
    expect(none.stderr.split("\n")[1]).toBe(
      'hint: run "minimal-agent --help" to see the host modes.',
    )
  })

  test("--json prints the host-mode model", () => {
    const r = run(["--host-mode", "acp", "--help", "--json"])
    expect(r.code).toBe(0)
    const model = JSON.parse(r.stdout) as HelpModel
    expect(model.kind).toBe("command")
    expect(model.path).toEqual(["--host-mode", "acp"])
    expect(model.sections.map((s) => s.id)).toEqual([
      "header",
      "usage",
      "arguments",
      "global-flags",
      "examples",
    ])
  })
})

describe("JSON help (M-11) has the plugin sections", () => {
  test("root JSON has HOST MODES and PLUGIN NOTES groups", () => {
    const model = JSON.parse(run(["--help", "--json"]).stdout) as HelpModel
    const ids = model.sections.map((s) => s.id)
    expect(ids.indexOf("commands")).toBeLessThan(ids.indexOf("host-modes"))
    expect(ids.indexOf("host-modes")).toBeLessThan(ids.indexOf("flags"))
    const hostModes = model.sections.find((s) => s.id === "host-modes")
    expect(hostModes?.title).toBe("HOST MODES")
    expect(hostModes?.rows?.map((r) => [r.term, r.source])).toEqual([
      ["acp", "plugin:alpha"],
      ["beta-rpc", "plugin:beta"],
    ])
    const notes = model.sections.find((s) => s.id === "plugin-notes")
    expect(notes?.groups?.map((g) => g.title)).toEqual([
      "Alpha notes (from plugin alpha)",
      "Alpha limits (from plugin alpha)",
    ])
  })

  test("--help --all --json has the disabled rows with state and note", () => {
    const model = JSON.parse(run(["--help", "--all", "--json"]).stdout) as HelpModel
    const rows = model.sections.find((s) => s.id === "host-modes")?.rows ?? []
    expect(rows.filter((r) => r.state === "disabled").map((r) => [r.term, r.note])).toEqual([
      ["acp", "collision"],
      ["delta-mode", "manifest"],
      ["gamma-mode", "permission"],
    ])
  })
})
