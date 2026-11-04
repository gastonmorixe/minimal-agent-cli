import { describe, expect, test } from "bun:test"

import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { renderCommandHelp, renderHelp } from "./help.ts"

const rootText = (): string => stripAnsi(renderHelp().join("\n"))
const commandText = (path: string[]): string => stripAnsi(renderCommandHelp(path).join("\n"))

describe("renderHelp", () => {
  test("documents plugin enable/disable CLI, env, and list subcommand", () => {
    const text = rootText()
    expect(text).toContain("--disable-plugin")
    expect(text).toContain("--enable-plugin")
    expect(text).toContain("plugins list")
    expect(text).toContain("CLI → env → config → manifest")
    expect(text).toContain("MINIMAL_AGENT_DISABLE_PLUGINS")
    expect(text).toContain("MINIMAL_AGENT_ENABLE_PLUGINS")
    expect(text).toContain("minimal-agent --disable-plugin web-search,memory")
    expect(commandText(["plugins"])).toContain("--list-plugins")
  })

  test("documents --tools allow-list and --no-tools", () => {
    const text = rootText()
    expect(text).toContain("--tools <names>")
    expect(text).toContain("--no-tools")
    expect(text).toContain("Advertise only these tools")
    expect(text).toContain("Advertise no tools, for pure Q&A")
  })

  test("documents --no-agents-md and MINIMAL_AGENT_NO_AGENTS_MD", () => {
    const text = rootText()
    expect(text).toContain("--no-agents-md")
    expect(text).toContain("Skip AGENTS.md injection")
    expect(text).toContain("MINIMAL_AGENT_NO_AGENTS_MD")
    expect(text).toContain("--disable-plugin agents-md")
  })

  test("leads with usage, runnable examples, and the command list (spec 8.4)", () => {
    const lines = rootText().split("\n")
    const titles = lines.filter((l) => /^ {2}[A-Z][A-Z ]+$/u.test(l)).map((l) => l.trim())
    expect(titles).toEqual([
      "USAGE",
      "EXAMPLES",
      "COMMANDS",
      "FLAGS",
      "ENVIRONMENT",
      "PLUGIN NOTES",
      "LEARN MORE",
    ])
    const text = lines.join("\n")
    expect(text).toContain("    minimal-agent [flags] [prompt]")
    expect(text).toContain('minimal-agent "explain this codebase"')
    expect(text).toMatch(/^ {4}minimal-agent - +Read the prompt from stdin$/mu)
    expect(text).toContain("providers  List registered providers")
    expect(text).toContain("Use minimal-agent help <command> for command help.")
    expect(text).toContain("github.com/gastonmorixe/minimal-agent")
  })

  test("long notes stay out of root help (R-13) and show in command help", () => {
    const text = rootText()
    expect(text).not.toContain("Accepted but not enforced")
    expect(text).not.toContain("Every arg after the id goes to the host mode")
    expect(commandText(["resume"])).toContain("Aliases: -r, --resume.")
  })

  test("documents current output, auth, and command aliases", () => {
    const text = rootText()
    expect(text).toContain("--output-format <text|json|stream-json>")
    expect(text).toContain("--json is short")
    expect(text).toContain("--format, --surface <id>")
    expect(text).toContain("resume-same <sid>")
    expect(commandText(["login"])).toContain("--auth-method <oauth|api-key>")
    expect(commandText(["login"])).toContain("--email, --email-hint <address>")
    expect(commandText(["login"])).toContain("--name <label>")
    expect(commandText(["providers"])).toContain("--list-providers")
    expect(commandText(["usage"])).toContain("--usage-stats")
    expect(commandText(["providers", "models"])).toContain("--print-format <text|json|md|xml>")
  })

  test("documents --host-mode", () => {
    expect(rootText()).toContain("--host-mode <id>")
    expect(rootText()).toContain("Hand the process to a plugin host mode")
  })

  test("documents --diagnostics and --debug", () => {
    const text = rootText()
    expect(text).toContain("--diagnostics")
    expect(text).toContain("With --output-format json, also write diagnostics")
    expect(text).toContain("-d, --debug")
    expect(text).toContain("Enable debug logging (env: DEBUG)")
  })
})
