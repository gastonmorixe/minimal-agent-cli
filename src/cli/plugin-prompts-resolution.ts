/**
 * Resolve plugin prompt-TEXT suppression from CLI args, env, and config.
 *
 * The host half of the four `plugins`-group flags. Core owns the precedence
 * (`resolvePluginPromptSuppression`); this module only reads the CLI surface
 * and hands core the three tiers. It lives here rather than inline in
 * `src/main.ts` because that file is close to the `max-lines` limit.
 *
 * Two distinct things, and they are NOT symmetric:
 * - `all: true` means SUPPRESS EVERY PROMPT TEXT. So `--no-plugin-prompts`
 *   maps to `true` and `--plugin-prompts` to `false`.
 * - The per-id flags map straight across: `--no-plugin-prompts-for <ids>`
 *   fills `suppress`, `--plugin-prompts-for <ids>` fills `keep`. A `keep`
 *   entry beats `all` for that id, in core.
 *
 * Four flags, never one flag with an optional value: the CLI takes a bare
 * positional prompt, so an optional value would swallow the prompt text.
 * Both per-id flags are repeatable and accept a comma list, through the
 * same `collectFlagValues` helper `--disable-plugin` uses.
 *
 * @module cli/plugin-prompts-resolution
 */

import { loadPluginPromptsConfig } from "@minimal-agent/core/host/config"
import { collectFlagValues } from "@minimal-agent/core/host/plugin-enable-resolution"
import {
  type PluginPromptSuppression,
  resolvePluginPromptSuppression,
} from "@minimal-agent/core/host/plugin-prompt-resolution"

/** What {@link resolvePluginPromptsForCli} returns. */
export interface PluginPromptsResolution {
  /** The value to pass to `PluginLoader.load({ pluginPrompts })`. */
  readonly suppression: PluginPromptSuppression
  /** Human-readable warnings to log. A bad `MINIMAL_AGENT_PLUGIN_PROMPTS` lands here. */
  readonly warnings: readonly string[]
}

/**
 * Where the warnings go. `(source, message)`, the same shape as the host's
 * `diag.warn`, so the boot site hands that function over unchanged.
 */
export type PluginPromptsWarn = (source: string, message: string) => void

/** The slice of the process env this module reads. */
export type PluginPromptsEnv = Readonly<Record<string, string | undefined>>

/** Inputs of {@link resolvePluginPromptsForCli}. */
export interface PluginPromptsResolutionInput {
  /** Normalized argv. */
  readonly args: readonly string[]
  /** The raw `MINIMAL_AGENT_PLUGIN_PROMPTS` value, `undefined` when unset. */
  readonly env: string | undefined
  /** The `plugins.prompts` config value (`loadPluginPromptsConfig()`). */
  readonly config: Parameters<typeof resolvePluginPromptSuppression>[0]["config"]
  /** Optional sink. Omit it to only read `warnings` off the result. */
  readonly warn?: PluginPromptsWarn | undefined
}

/**
 * The `cli` tier core expects, derived from argv. Exported so a test can pin
 * the flag-to-tier mapping without running the whole boot.
 *
 * `--no-plugin-prompts` wins when both booleans appear, because suppression
 * is the safer reading of a contradictory command line.
 *
 * @param args - Normalized argv.
 */
export function pluginPromptsCliTier(args: readonly string[]): {
  all: boolean | undefined
  suppress: readonly string[]
  keep: readonly string[]
} {
  return {
    all: args.includes("--no-plugin-prompts")
      ? true
      : args.includes("--plugin-prompts")
        ? false
        : undefined,
    suppress: collectFlagValues(args, "--no-plugin-prompts-for"),
    keep: collectFlagValues(args, "--plugin-prompts-for"),
  }
}

/**
 * Resolve the suppression state for this run, and log its warnings.
 *
 * Precedence: CLI, then env, then config, then nothing suppressed. A
 * suppressed plugin still loads and still advertises its tools: only its
 * prompt text is dropped.
 *
 * Call this BEFORE `PluginLoader.load`, because the loader takes the value
 * as a construction option and memoizes the prompt blocks it produces.
 *
 * @param input - Argv plus the two lower-precedence tiers and a warn sink.
 */
export function resolvePluginPromptsForCli(
  input: PluginPromptsResolutionInput,
): PluginPromptsResolution {
  const resolved = resolvePluginPromptSuppression({
    config: input.config,
    env: input.env,
    cli: pluginPromptsCliTier(input.args),
  })
  emitWarnings(resolved.warnings, input.warn)
  return resolved
}

/**
 * The call the host boot makes: load the config tier, resolve, and log the
 * warnings. Kept here so `src/main.ts` stays a one-line composition root.
 *
 * Call it BEFORE `PluginLoader.load`, because the loader takes the value as a
 * construction option and memoizes the prompt blocks it produces.
 *
 * @param args - Normalized argv.
 * @param env - The process env. `MINIMAL_AGENT_PLUGIN_PROMPTS` is read here.
 * @param warn - Sink for the warnings (the host passes `diag.warn`).
 */
export function resolvePluginPromptsForBoot(
  args: readonly string[],
  env: PluginPromptsEnv,
  warn: PluginPromptsWarn,
): PluginPromptSuppression {
  const resolved = resolvePluginPromptSuppression({
    config: loadPluginPromptsConfig(),
    env: env.MINIMAL_AGENT_PLUGIN_PROMPTS,
    cli: pluginPromptsCliTier(args),
  })
  emitWarnings(resolved.warnings, warn)
  return resolved.suppression
}

/**
 * Fan the warnings out to the sink, tagged with the `plugin-prompts` source.
 *
 * @param warnings - Warnings from the core resolver.
 * @param warn - Optional sink. No sink means the caller reads them itself.
 */
function emitWarnings(warnings: readonly string[], warn: PluginPromptsWarn | undefined): void {
  if (warn === undefined) return
  for (const warning of warnings) {
    warn("plugin-prompts", warning)
  }
}
