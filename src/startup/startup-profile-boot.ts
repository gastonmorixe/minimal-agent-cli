/**
 * Startup profile at boot (subagent inherit).
 *
 * A lead session writes its FINAL startup settings (after CLI, env, and
 * config precedence) to `<sessionsDir>/<sid>.profile.json`. A child session
 * started with `--startup-profile <path>` reads that file at entry, and the
 * profile then replaces its env and config tiers. Explicit child CLI flags
 * still win. A child writes its own profile too, so nested workers inherit.
 *
 * The codec (parse, serialize, atomic write) is in core
 * (`@minimal-agent/core/host/startup-profile`). This module only builds the
 * profile from the resolved boot values and handles the flag and the I/O.
 * It lives here because `src/main.ts` is close to its `max-lines` limit.
 *
 * @module startup/startup-profile-boot
 */

import { mkdirSync } from "node:fs"

import { loadPluginEnabledOverrides } from "@minimal-agent/core/host/config"
import {
  type PluginEnableOverrideSets,
  resolvePluginEnabledOverrides,
} from "@minimal-agent/core/host/plugin-enable-resolution"
import type { PluginPromptSuppression } from "@minimal-agent/core/host/plugin-prompt-resolution"
import { getSessionId } from "@minimal-agent/core/host/session-id"
import {
  readStartupProfileFile,
  startupProfilePath,
  toolsFromNamePolicy,
  writeStartupProfileFile,
} from "@minimal-agent/core/host/startup-profile"
import type { SystemPromptOverrides } from "@minimal-agent/core/host/system-prompt-overrides"
import type { ModeManager } from "@minimal-agent/core/host-kit/modes"
import type { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import {
  type HostPolicySnapshot,
  STARTUP_PROFILE_VERSION,
  type StartupProfile,
} from "@minimal-agent/core/plugin-api/types/startup-profile"
import { resolveSessionsDir } from "@minimal-agent/core/plugin-api/utils/agent-paths"
import type { ToolNamePolicy } from "@minimal-agent/core/sdk/tool-filter"

import type { CliOptions, LoadedStartupProfile } from "../cli/parse-argv.ts"

/** The flag a child session gets from a spawn plan. */
export const STARTUP_PROFILE_FLAG = "--startup-profile"

/** The final boot values a profile is built from. */
export interface StartupProfileInput {
  readonly systemPrompt: SystemPromptOverrides
  readonly noAgentsMd: boolean
  readonly pluginPrompts: PluginPromptSuppression
  readonly plugins: {
    readonly forceDisabled: ReadonlySet<string>
    readonly forceEnabled: ReadonlySet<string>
  }
  readonly bare: boolean
  readonly tools: ToolNamePolicy
}

/**
 * Build a profile from the FINAL resolved boot values. The system prompt
 * already holds override file CONTENTS (the resolver read the files), never
 * a path.
 */
export function buildStartupProfile(input: StartupProfileInput): StartupProfile {
  const systemPrompt: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input.systemPrompt)) {
    if (value !== undefined) systemPrompt[key] = value
  }
  return {
    version: STARTUP_PROFILE_VERSION,
    systemPrompt: systemPrompt as StartupProfile["systemPrompt"],
    noAgentsMd: input.noAgentsMd,
    pluginPrompts: {
      all: input.pluginPrompts.all,
      suppress: [...input.pluginPrompts.suppress].sort(),
      keep: [...input.pluginPrompts.keep].sort(),
    },
    plugins: {
      disable: [...input.plugins.forceDisabled].sort(),
      enable: [...input.plugins.forceEnabled].sort(),
    },
    bare: input.bare,
    tools: toolsFromNamePolicy(input.tools),
  }
}

/**
 * Write the profile to `<sessionsDir>/<sid>.profile.json` and return the
 * path. Throws on an I/O failure. The caller warns and boots on.
 */
export function writeLeadStartupProfile(
  sessionsDir: string,
  sid: string,
  profile: StartupProfile,
): string {
  // At boot the sessions dir may not exist yet (first run, fresh home).
  mkdirSync(sessionsDir, { recursive: true })
  const path = startupProfilePath(sessionsDir, sid)
  writeStartupProfileFile(path, profile)
  return path
}

/**
 * Build and write the profile. On success return what the loader exposes as
 * `ctx.startupProfile()`. On a write failure warn and return `undefined`, so
 * a plugin falls back to its own defaults.
 */
export function publishStartupProfile(
  sessionsDir: string,
  sid: string,
  input: StartupProfileInput,
  warn: (source: string, message: string) => void,
): LoadedStartupProfile | undefined {
  const profile = buildStartupProfile(input)
  try {
    return { path: writeLeadStartupProfile(sessionsDir, sid, profile), profile }
  } catch (err) {
    warn("startup-profile", `cannot write startup profile: ${String(err)}`)
    return undefined
  }
}

/**
 * The live policy snapshot for `ctx.queryHostPolicy`. With a ModeManager it
 * holds the live mode, every mode, and the tool policy. Without one (no
 * modes and no tool flag) there is no mode, and the tool policy is `filter`.
 */
export function hostPolicySnapshot(
  modes: Pick<ModeManager, "policySnapshot"> | null,
  filter: ToolNamePolicy,
): HostPolicySnapshot {
  return (
    modes?.policySnapshot() ?? { activeModeId: null, modes: [], tools: toolsFromNamePolicy(filter) }
  )
}

/** The env and config tiers of the plugin enable/disable resolver. */
export interface PluginEnableLowTiers {
  readonly config: { forceDisabled: Set<string>; forceEnabled: Set<string> }
  readonly env: { disable?: string; enable?: string }
}

/**
 * The plugin enable/disable tiers below the CLI. With a profile, the
 * profile lists are the config tier and the env tier is empty. Else read
 * config (`loadConfig`) and the env vars.
 */
export function pluginEnableLowTiers(
  loaded: LoadedStartupProfile | undefined,
  env: Readonly<Record<string, string | undefined>>,
  loadConfig: () => { forceDisabled: Set<string>; forceEnabled: Set<string> },
): PluginEnableLowTiers {
  if (loaded !== undefined) {
    return {
      config: {
        forceDisabled: new Set(loaded.profile.plugins.disable),
        forceEnabled: new Set(loaded.profile.plugins.enable),
      },
      env: {},
    }
  }
  return {
    config: loadConfig(),
    env: { disable: env.MINIMAL_AGENT_DISABLE_PLUGINS, enable: env.MINIMAL_AGENT_ENABLE_PLUGINS },
  }
}

/**
 * The AGENTS.md switch below the CLI: the profile value, else
 * `MINIMAL_AGENT_NO_AGENTS_MD=1`.
 */
export function noAgentsMdLowTier(
  loaded: LoadedStartupProfile | undefined,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return loaded !== undefined ? loaded.profile.noAgentsMd : env.MINIMAL_AGENT_NO_AGENTS_MD === "1"
}

/**
 * Final AGENTS.md switch: `--no-agents-md` / `--no-agents`, else the tier
 * below the CLI ({@link noAgentsMdLowTier}).
 */
export function resolveNoAgentsMd(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  loaded: LoadedStartupProfile | undefined,
): boolean {
  return (
    args.includes("--no-agents-md") ||
    args.includes("--no-agents") ||
    noAgentsMdLowTier(loaded, env)
  )
}

/**
 * Final plugin enable/disable sets: the given CLI tier over
 * {@link pluginEnableLowTiers} (profile, else env and config).
 */
export function resolveBootPluginOverrides(
  loaded: LoadedStartupProfile | undefined,
  env: Readonly<Record<string, string | undefined>>,
  cli: { readonly disable: readonly string[]; readonly enable: readonly string[] },
  loadConfig: () => PluginEnableOverrideSets = loadPluginEnabledOverrides,
): PluginEnableOverrideSets {
  const low = pluginEnableLowTiers(loaded, env, loadConfig)
  return resolvePluginEnabledOverrides({ config: low.config, env: low.env, cli })
}

/** The loader setters this module calls. */
export type StartupProfileLoader = Pick<PluginLoader, "setHostPolicySource" | "setStartupProfile">

/** The final boot values {@link wireStartupProfile} reads. */
export interface StartupProfileBootValues {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly opts: Pick<CliOptions, "systemPromptOverrides" | "bare" | "cliToolFilter">
  readonly noAgentsMd: boolean
  readonly pluginOverrides: StartupProfileInput["plugins"]
  readonly pluginPromptSuppression: PluginPromptSuppression
}

/**
 * Write `<sessionsDir>/<sid>.profile.json` from the final boot values and
 * wire both plugin ctx sources: `ctx.startupProfile()` (cleared when the
 * write fails) and `ctx.queryHostPolicy()` (live mode and tool policy).
 */
export function wireStartupProfile(
  loader: StartupProfileLoader,
  modes: Pick<ModeManager, "policySnapshot"> | null,
  warn: (source: string, message: string) => void,
  v: StartupProfileBootValues,
  sid: string = getSessionId(),
): LoadedStartupProfile | undefined {
  const written = publishStartupProfile(
    resolveSessionsDir(v.env as NodeJS.ProcessEnv),
    sid,
    {
      systemPrompt: v.opts.systemPromptOverrides,
      noAgentsMd: v.noAgentsMd,
      pluginPrompts: v.pluginPromptSuppression,
      plugins: v.pluginOverrides,
      bare: v.opts.bare,
      tools: v.opts.cliToolFilter,
    },
    warn,
  )
  loader.setStartupProfile(written)
  loader.setHostPolicySource(() => hostPolicySnapshot(modes, v.opts.cliToolFilter))
  return written
}

/** The `--startup-profile` value in normalized argv (`--flag v` or `--flag=v`). */
export function startupProfileArg(args: readonly string[]): string | undefined {
  const eq = args.find((a) => a.startsWith(`${STARTUP_PROFILE_FLAG}=`))
  if (eq !== undefined) return eq.slice(STARTUP_PROFILE_FLAG.length + 1)
  const idx = args.indexOf(STARTUP_PROFILE_FLAG)
  return idx === -1 ? undefined : (args[idx + 1] ?? "")
}

/** Result of {@link loadStartupProfileArg}. */
export type StartupProfileArgLoad =
  | { readonly ok: true; readonly value: LoadedStartupProfile | undefined }
  | { readonly ok: false; readonly message: string }

/**
 * Read and validate the `--startup-profile` file. No flag gives
 * `{ok: true, value: undefined}`. A missing, unreadable, or invalid file
 * gives the fatal line the entry point prints (SPEC 6.3).
 */
export function loadStartupProfileArg(args: readonly string[]): StartupProfileArgLoad {
  const path = startupProfileArg(args)
  if (path === undefined) return { ok: true, value: undefined }
  const parsed = readStartupProfileFile(path)
  if (!parsed.ok) return { ok: false, message: `fatal: startup profile ${path}: ${parsed.error}` }
  return { ok: true, value: { path, profile: parsed.value } }
}
