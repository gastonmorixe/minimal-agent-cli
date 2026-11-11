/**
 * `--dry-run` is a global alias for `--enable-plugin dry-run`. These tests
 * pin the parse and registry side: the flag is known, takes no value, shows
 * in help, and `auth-status prune --dry-run` still parses as before.
 *
 * @module cli/dry-run-flag.test
 */

import { describe, expect, test } from "bun:test"

import { resolvePluginEnabledOverrides } from "@minimal-agent/core/host/plugin-enable-resolution"

import { dryRunEnableIds, dryRunPreflightError } from "../startup/dry-run.ts"
import { extractSubcommandInputs } from "../startup/subcommand-inputs.ts"
import { extractPromptFromArgs, FLAGS_NO_VALUE } from "./extract-prompt.ts"
import { builtinRegistry } from "./registry/index.ts"

const reg = builtinRegistry()

describe("--dry-run flag", () => {
  test("is a visible global flag in the plugins group, with its env", () => {
    const spec = reg.globalFlags.find((f) => f.name === "dry-run")
    expect(spec?.global).toBe(true)
    expect(spec?.group).toBe("plugins")
    expect(spec?.value).toBe("none")
    expect(spec?.env).toBe("MINIMAL_AGENT_DRY_RUN")
    expect(spec?.hidden).toBeUndefined()
    const env = reg.env.find((e) => e.name === "MINIMAL_AGENT_DRY_RUN")
    expect(env?.set).toBe("1")
  })

  test("is a no-value flag: the next token stays the prompt", () => {
    expect(FLAGS_NO_VALUE.has("--dry-run")).toBe(true)
    expect(extractPromptFromArgs(["--dry-run", "say hi"])).toEqual({
      kind: "literal",
      text: "say hi",
    })
  })

  test("the alias force-enables the dry-run plugin, and a disable still wins", () => {
    const on = resolvePluginEnabledOverrides({
      config: { forceDisabled: new Set(), forceEnabled: new Set() },
      cli: { disable: [], enable: dryRunEnableIds(["--dry-run"], {}) },
    })
    expect(on.forceEnabled.has("dry-run")).toBe(true)
    const both = resolvePluginEnabledOverrides({
      config: { forceDisabled: new Set(), forceEnabled: new Set() },
      cli: { disable: ["dry-run"], enable: dryRunEnableIds(["--dry-run"], {}) },
    })
    // Disabled: the post-load guard then stops the run (fail closed).
    expect(both.forceDisabled.has("dry-run")).toBe(true)
  })
})

describe("auth-status prune --dry-run", () => {
  const opts = {
    dumpArg: undefined,
    dumpFormatArg: undefined,
    dumpPaths: false,
    sessionsQuery: undefined,
    usagePeriod: undefined,
    listModelsProvider: undefined,
    printFormat: "human",
  } as unknown as Parameters<typeof extractSubcommandInputs>[2]

  test("still parses as the prune dry run", () => {
    const got = extractSubcommandInputs(
      "auth-status",
      ["--auth-status", "prune", "--dry-run"],
      opts,
    )
    expect(got).toMatchObject({ command: "auth-status", verb: "prune", dryRun: true })
  })

  test("the global preflight lets the subcommand through", () => {
    expect(dryRunPreflightError({ dryRun: true, command: "auth-status", hasPrompt: false })).toBe(
      undefined,
    )
  })
})
