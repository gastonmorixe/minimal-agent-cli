/**
 * Plugin prompt-TEXT suppression flags.
 *
 * Four flags, and every one has UNAMBIGUOUS arity. The CLI takes a bare
 * positional prompt, so an optional-value flag would swallow the prompt
 * text. That is the reason for four flags instead of one with an optional
 * value, and `--no-plugin-prompts hello` below is the regression test.
 *
 * The wiring in `src/main.ts` is a straight call to
 * `resolvePluginPromptSuppression` (core owns the precedence). There is no
 * `src/main.test.ts` in this repo and no test that asserts on the
 * `PluginLoader.load` options object, so the focused unit tests here pin
 * the pieces main.ts composes: the registry shape, the arity, the flag to
 * resolver mapping, and the loader option passing the suppression through.
 *
 * @module cli/plugin-prompts-flags.test
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { collectFlagValues } from "@minimal-agent/core/host/plugin-enable-resolution"
import {
  isPluginPromptSuppressed,
  resolvePluginPromptSuppression,
} from "@minimal-agent/core/host/plugin-prompt-resolution"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"

import { extractPromptFromArgs, FLAGS_NO_VALUE, FLAGS_WITH_VALUES } from "./extract-prompt.ts"
import { pluginPromptsCliTier, resolvePluginPromptsForCli } from "./plugin-prompts-resolution.ts"
import { builtinRegistry } from "./registry/index.ts"

const reg = builtinRegistry()

/** The flag names this feature adds. */
const BOOLEAN_FLAGS = ["no-plugin-prompts", "plugin-prompts"] as const
const VALUE_FLAGS = ["no-plugin-prompts-for", "plugin-prompts-for"] as const

/**
 * The exact `cli` tier `src/main.ts` builds, read from the production module
 * so the test pins the real mapping and not a copy of it.
 */
const cliTier = pluginPromptsCliTier

describe("registry: the four plugin prompt flags", () => {
  for (const name of BOOLEAN_FLAGS) {
    test(`--${name} is a visible global boolean in the plugins group`, () => {
      const spec = reg.globalFlags.find((f) => f.name === name)
      expect(spec?.global).toBe(true)
      expect(spec?.group).toBe("plugins")
      expect(spec?.type).toBe("boolean")
      expect(spec?.value).toBe("none")
      expect(spec?.hidden).toBeUndefined()
    })
  }

  for (const name of VALUE_FLAGS) {
    test(`--${name} is a visible global repeatable required-value flag`, () => {
      const spec = reg.globalFlags.find((f) => f.name === name)
      expect(spec?.global).toBe(true)
      expect(spec?.group).toBe("plugins")
      expect(spec?.type).toBe("string")
      expect(spec?.value).toBe("required")
      expect(spec?.valueName).toBe("id")
      expect(spec?.multiple).toBe(true)
      // No optional value anywhere: that is the arity decision.
      expect(spec?.value).not.toBe("optional")
      expect(spec?.hidden).toBeUndefined()
    })
  }

  test("no prompt flag takes an optional value", () => {
    const bad = [...BOOLEAN_FLAGS, ...VALUE_FLAGS]
      .map((n) => reg.globalFlags.find((f) => f.name === n))
      .filter((f) => f !== undefined && f.value === "optional")
      .map((f) => f?.name)
    expect(bad).toEqual([])
  })

  test("MINIMAL_AGENT_PLUGIN_PROMPTS is in the env registry, on --no-plugin-prompts", () => {
    const env = reg.env.find((e) => e.name === "MINIMAL_AGENT_PLUGIN_PROMPTS")
    expect(env).toBeDefined()
    expect(env?.summary.trim()).not.toBe("")
    // `1` is the value that turns suppression ON, so the row and the flag
    // pointer agree with the resolver in core.
    expect(env?.set).toBe("1")
    expect(env?.flag).toBe("no-plugin-prompts")
    const flag = reg.globalFlags.find((f) => f.name === "no-plugin-prompts")
    expect(flag?.env).toBe("MINIMAL_AGENT_PLUGIN_PROMPTS")
  })

  test("the env row states the off direction in its description", () => {
    const env = reg.env.find((e) => e.name === "MINIMAL_AGENT_PLUGIN_PROMPTS")
    expect((env?.description ?? []).join(" ")).toContain("0 or false")
  })
})

describe("arity: no prompt flag swallows the prompt", () => {
  test("the boolean pair is a no-value flag", () => {
    for (const name of BOOLEAN_FLAGS) {
      expect(FLAGS_NO_VALUE.has(`--${name}`)).toBe(true)
      expect(FLAGS_WITH_VALUES.has(`--${name}`)).toBe(false)
    }
  })

  test("the value pair consumes its value, repeatable", () => {
    for (const name of VALUE_FLAGS) {
      expect(FLAGS_WITH_VALUES.has(`--${name}`)).toBe(true)
      expect(FLAGS_NO_VALUE.has(`--${name}`)).toBe(false)
    }
  })

  test("--no-plugin-prompts hello does NOT swallow hello", () => {
    expect(extractPromptFromArgs(["--no-plugin-prompts", "hello"])).toEqual({
      kind: "literal",
      text: "hello",
    })
  })

  test("--plugin-prompts hello does NOT swallow hello", () => {
    expect(extractPromptFromArgs(["--plugin-prompts", "hello"])).toEqual({
      kind: "literal",
      text: "hello",
    })
  })

  test("--no-plugin-prompts-for memory,skills yields two ids and keeps the prompt", () => {
    const argv = ["--no-plugin-prompts-for", "memory,skills", "hello"]
    expect(collectFlagValues(argv, "--no-plugin-prompts-for")).toEqual(["memory", "skills"])
    expect(extractPromptFromArgs(argv)).toEqual({ kind: "literal", text: "hello" })
  })

  test("--plugin-prompts-for accepts the = form and repeats", () => {
    const argv = ["--plugin-prompts-for=memory", "--plugin-prompts-for", "skills"]
    expect(collectFlagValues(argv, "--plugin-prompts-for")).toEqual(["memory", "skills"])
  })
})

describe("mapping: args to the resolver tiers", () => {
  test("no flag leaves the cli tier undecided", () => {
    expect(cliTier([])).toEqual({ all: undefined, suppress: [], keep: [] })
  })

  test("--no-plugin-prompts means suppress all, --plugin-prompts means keep all", () => {
    expect(cliTier(["--no-plugin-prompts"]).all).toBe(true)
    expect(cliTier(["--plugin-prompts"]).all).toBe(false)
  })

  test("--no-plugin-prompts wins when both booleans appear", () => {
    expect(cliTier(["--plugin-prompts", "--no-plugin-prompts"]).all).toBe(true)
  })

  test("the per-id flags land in the suppress and keep lists", () => {
    const tier = cliTier(["--no-plugin-prompts-for", "skills", "--plugin-prompts-for", "memory"])
    expect(tier.suppress).toEqual(["skills"])
    expect(tier.keep).toEqual(["memory"])
  })

  test("the resolver honors the mapping end to end", () => {
    const tier = cliTier(["--no-plugin-prompts-for", "skills"])
    const { suppression, warnings } = resolvePluginPromptSuppression({ cli: tier })
    expect(warnings).toEqual([])
    expect(isPluginPromptSuppressed(suppression, "skills")).toBe(true)
    expect(isPluginPromptSuppressed(suppression, "memory")).toBe(false)
  })

  test("a keep flag beats an all-suppress for the same id", () => {
    const tier = cliTier(["--no-plugin-prompts", "--plugin-prompts-for", "memory"])
    const { suppression } = resolvePluginPromptSuppression({ cli: tier })
    expect(suppression.all).toBe(true)
    expect(isPluginPromptSuppressed(suppression, "memory")).toBe(false)
    expect(isPluginPromptSuppressed(suppression, "skills")).toBe(true)
  })

  test("--plugin-prompts beats a suppress-all env value", () => {
    const tier = cliTier(["--plugin-prompts"])
    const { suppression } = resolvePluginPromptSuppression({ env: "1", cli: tier })
    expect(suppression.all).toBe(false)
  })

  test("a bad env value warns, so main.ts has something to log", () => {
    const { warnings } = resolvePluginPromptSuppression({ env: "maybe" })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("MINIMAL_AGENT_PLUGIN_PROMPTS")
  })

  test("resolvePluginPromptsForCli resolves all tiers (main.ts calls it via resolvePluginPromptsForBoot)", () => {
    const { suppression, warnings } = resolvePluginPromptsForCli({
      args: ["--no-plugin-prompts-for", "skills,memory", "hello"],
      env: undefined,
      config: { keep: ["keepme"], suppress: ["cfgonly"] },
    })
    expect(warnings).toEqual([])
    // CLI tier applies over config.
    expect(isPluginPromptSuppressed(suppression, "skills")).toBe(true)
    expect(isPluginPromptSuppressed(suppression, "memory")).toBe(true)
    // Config entries below the CLI tier stay.
    expect(isPluginPromptSuppressed(suppression, "keepme")).toBe(false)
    expect(isPluginPromptSuppressed(suppression, "cfgonly")).toBe(true)
    expect(isPluginPromptSuppressed(suppression, "other")).toBe(false)
  })

  test("resolvePluginPromptsForCli surfaces the env warning it must log", () => {
    const { suppression, warnings } = resolvePluginPromptsForCli({
      args: [],
      env: "maybe",
      config: true,
    })
    expect(warnings).toHaveLength(1)
    // The bad env value is ignored, so the config tier decides.
    expect(suppression.all).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The loader option main.ts passes: `pluginPrompts: suppression`
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dir, "../../tmp/plugin-prompts-flags-tests")

/** Write one plugin whose prompt text is unique and easy to find. */
function writePlugin(pluginsDir: string, id: string, promptBody: string): void {
  const dir = join(pluginsDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id,
      name: id,
      version: "0.1.0",
      description: "prompt fixtures",
      // A bare `PROMPT.md` next to `manifest.json` is the implicit default:
      // the manifest needs no `prompt` field.
    }),
  )
  writeFileSync(join(dir, "PROMPT.md"), `# ${promptBody}\n\nBody of ${promptBody}.\n`)
}

describe("loader: pluginPrompts drops the text, keeps the plugin", () => {
  const PLUGINS = join(ROOT, "plugins")

  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    writePlugin(PLUGINS, "alpha-prompts", "Alpha")
    writePlugin(PLUGINS, "beta-prompts", "Beta")
  })

  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
  })

  // The same call `src/main.ts` makes, then the same option it passes.
  const load = (args: readonly string[]) =>
    PluginLoader.load({
      roots: { embedded: [PLUGINS] },
      logger: () => {},
      pluginPrompts: resolvePluginPromptsForCli({ args, env: undefined, config: undefined })
        .suppression,
    })

  test("the default keeps both prompt texts", async () => {
    const loader = await load([])
    const block = loader.getPromptBlock() ?? ""
    expect(block).toContain("Alpha")
    expect(block).toContain("Beta")
  })

  test("--no-plugin-prompts drops every prompt text, and the plugins still load", async () => {
    const loader = await load(["--no-plugin-prompts"])
    expect(loader.getPromptBlock()).toBeNull()
    expect((await loader.getPromptBlocksAsync()).afterInstructions).toBeNull()
    // Still loaded: the plugins are present, only their text is gone.
    expect(
      loader
        .loadedPackages()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["alpha-prompts", "beta-prompts"])
  })

  test("--no-plugin-prompts-for keeps the other plugin's text", async () => {
    const loader = await load(["--no-plugin-prompts-for", "alpha-prompts"])
    const block = loader.getPromptBlock() ?? ""
    expect(block).not.toContain("Alpha")
    expect(block).toContain("Beta")
  })

  test("--plugin-prompts-for beats --no-plugin-prompts for one id", async () => {
    const loader = await load(["--no-plugin-prompts", "--plugin-prompts-for", "alpha-prompts"])
    const block = loader.getPromptBlock() ?? ""
    expect(block).toContain("Alpha")
    expect(block).not.toContain("Beta")
  })
})
