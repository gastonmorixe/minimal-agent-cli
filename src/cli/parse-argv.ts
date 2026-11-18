/**
 * CLI argument resolution for the agent entry point.
 *
 * Pure flag/env/config precedence logic lifted out of `src/index.ts` so the
 * entry point stays a thin composition root. This module does NO I/O and has
 * NO side effects: it reads a pre-normalized `args` array plus the loaded
 * user config and the process environment, and returns a fully-resolved
 * {@link CliOptions} struct. The side-effecting parts of startup (the
 * `--help` short-circuit, `setSessionId`, `setStartupTreeVisible`, env-var
 * propagation) stay in the entry point, keyed off these resolved values.
 *
 * The precedence ladder is uniform across options: CLI flag then env var
 * then config file then built-in default.
 *
 * @module cli/parse-argv
 */

import {
  resolveCacheAnchor,
  resolveThinkingHistory,
  type ThinkingHistoryMode,
} from "@minimal-agent/core/host/cache-flags"
import {
  type CacheTtl,
  type CacheTtlSource,
  resolveCacheTtl,
} from "@minimal-agent/core/host/cache-ttl"
import { type EffortSource, resolveEffort } from "@minimal-agent/core/host/effort-resolution"
import { namePolicyFromTools } from "@minimal-agent/core/host/startup-profile"
import type { SystemPromptOverrides } from "@minimal-agent/core/host/system-prompt-overrides"
import type { StartupProfile } from "@minimal-agent/core/plugin-api/types/startup-profile"
import type { ToolNamePolicy } from "@minimal-agent/core/sdk/tool-filter"

import type { CliUserConfig } from "../config/terminal-config.ts"
import { resolveHeaderFormat, resolveShowHeader } from "./non-interactive-defaults.ts"
import { type OutputFormat, resolveOutputFormat } from "./output-format.ts"
import { type PrintFormat, parsePrintFormat } from "./print-format.ts"

/** A minimal view of the process environment this resolver reads. */
export type EnvLike = Record<string, string | undefined>

/**
 * Parse a formatter command string into argv. Injected by the caller so this
 * pure `cli/` module never imports the host tree (keeps the core→host ratchet
 * green). The entry point passes the host's `parseFormatterCommand`.
 */
export type FormatterParser = (raw: string) => string[]

/** User-facing CLI usage error (missing flag value, etc.). */
export class CliFlagError extends Error {
  readonly name = "CliFlagError"
}

/**
 * CLI-level tool name policy (`--tools` / `--no-tools`).
 * Alias of the SDK {@link ToolNamePolicy} — single source of truth.
 */
export type CliToolFilter = ToolNamePolicy

/**
 * Every CLI/env/config-derived value the entry point needs, fully resolved.
 * Field names mirror the historical module-scope constants in `index.ts` so
 * the entry point can destructure this struct 1:1.
 */
export interface CliOptions {
  readonly model: string | undefined
  readonly cliToolFilter: CliToolFilter
  readonly provider: string | undefined
  readonly endpoint: string | undefined
  readonly format: string | undefined
  readonly authType: "api-key" | "bearer" | "none" | "custom-header" | undefined
  readonly apiKey: string | undefined
  readonly authHeader: string | undefined
  readonly providerModel: string | undefined
  readonly effortLevels: string[] | undefined
  readonly cliCredentialName: string | undefined
  readonly wantListModels: boolean
  /** Live catalogs: `--list-models-live` / `providers models-live`. */
  readonly wantListModelsLive: boolean
  readonly wantListProviders: boolean
  readonly listModelsProvider: string | undefined
  /** Inspection command print format (`--print-format`). */
  readonly printFormat: PrintFormat
  readonly wantListFlags: boolean
  readonly wantListPlugins: boolean
  readonly wantListSpinners: boolean
  readonly wantJsonOutput: boolean
  /**
   * The resolved non-interactive output format (`text` | `json` |
   * `stream-json`). Precedence: a valid `--output-format` value wins, then the
   * `--json` alias (mirrored by `wantJsonOutput`), then `text`. See
   * {@link resolveOutputFormat}.
   */
  readonly outputFormat: OutputFormat
  /**
   * `--diagnostics`: on the `json` route, write every line as a session log
   * entry (`{v:1, ch:"event"|"diag", ...}`), diagnostics included (S39).
   */
  readonly wantDiagnostics: boolean
  /** `--debug` (or `DEBUG=1`): mirror diagnostics to stderr outside the TUI (S38). */
  readonly debug: boolean
  /** The `--output-schema` value: a file path, or inline JSON when it starts with `{` (R7). */
  readonly outputSchemaPath: string | undefined
  /** `--strict`: ask the provider to enforce `--output-schema` (SPEC-ONESHOT R6). */
  readonly strict: boolean
  /** `--append-system-prompt <text>` (SPEC-ONESHOT R8). */
  readonly appendSystemPrompt: string | undefined
  /** `--append-system-prompt-file <path>` (SPEC-ONESHOT R8). Read later, at run setup. */
  readonly appendSystemPromptFile: string | undefined
  /** `--temperature <n>`, else `MINIMAL_AGENT_TEMPERATURE` (SPEC-ONESHOT R9). Finite. */
  readonly temperature: number | undefined
  /** `--schema-retries <n>`: 0 to 5, default 0 (SPEC-ONESHOT R12). */
  readonly schemaRetries: number
  /** `--bare`: only the plugins the run needs, no AGENTS.md (SPEC-ONESHOT R13). */
  readonly bare: boolean
  /** `--input-format`: `text` (default) or `open-responses` (SPEC-ONESHOT R15). */
  readonly inputFormat: InputFormat
  readonly spinnerName: string | undefined
  readonly showHeader: boolean
  /** Header template for plugins, or undefined. See `resolveHeaderFormat`. */
  readonly headerFormat: string | undefined
  readonly effort: string | undefined
  readonly effortSource: EffortSource | undefined
  readonly thinkingDisplay: "summarized" | "omitted" | undefined
  readonly speed: "normal" | "fast"
  readonly speedFast: boolean
  readonly serviceTier: string | undefined
  readonly cacheTtl: CacheTtl
  readonly cacheTtlSource: CacheTtlSource
  readonly cacheAnchor: boolean
  readonly thinkingHistory: ThinkingHistoryMode
  /** Both prompt-cache flags as one spreadable session-deps fragment. */
  readonly cacheFlags: { cacheAnchor: boolean; thinkingHistory: ThinkingHistoryMode }
  readonly systemPromptOverrides: SystemPromptOverrides
  readonly formatterExplicitArg: string[] | undefined
  readonly formatterExtraArgs: string[]
  readonly resumeArg: string | undefined
  readonly resumeSameArg: string | undefined
  readonly effectiveResumeArg: string | undefined
  readonly sessionIdArg: string | undefined
  readonly wantListSessions: boolean
  readonly sessionsQuery: string | undefined
  readonly wantUsage: boolean
  readonly usagePeriod: string | undefined
  readonly dumpArg: string | undefined
  readonly dumpFormatArg: string
  readonly dumpPaths: boolean
  readonly wantLogin: boolean
  readonly wantLogout: boolean
  readonly wantAuthStatus: boolean
  /**
   * `--host-mode <id>` — hands the whole process to the matching plugin
   * `hostModes[]` entry after full boot (the plugin host-mode dispatch slot).
   * `undefined` when the flag is absent; `planCommand` only selects the
   * `"host-mode"` command when this is set.
   */
  readonly hostModeId: string | undefined
  /**
   * `--startup-profile <path>`, read and validated at entry. The lowest CLI
   * tier: it replaces env and config for the profile fields. `undefined`
   * when the flag is absent.
   */
  readonly startupProfile: LoadedStartupProfile | undefined
}

/** A startup profile read from `--startup-profile`, with its path. */
export interface LoadedStartupProfile {
  readonly path: string
  readonly profile: StartupProfile
}

/**
 * Read the value following a `--flag` token, or the inline `--flag=value`
 * form. Returns `undefined` when the flag is absent or has no value.
 */
function makeReadFlagValue(args: readonly string[]): (name: string) => string | undefined {
  return (name: string): string | undefined => {
    const eq = args.find((a) => a.startsWith(`${name}=`))
    if (eq) return eq.slice(name.length + 1)
    const idx = args.indexOf(name)
    if (idx !== -1 && args[idx + 1]) return args[idx + 1]
    return undefined
  }
}

/** The token after `flag`, unless it is missing or is itself the next flag. */
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("-") ? args[idx + 1] : undefined
}

/**
 * `--effort` / `-e` takes a level token. A following flag is not a level —
 * `--effort --fast` used to set effort to the literal `"--fast"` and then
 * fail as `effort "--fast" is not supported`.
 */
function readEffortFlag(args: readonly string[]): string | undefined {
  const idx = args.indexOf("--effort")
  if (idx === -1) return undefined
  const next = args[idx + 1]
  if (next === undefined || next === "" || next.startsWith("-")) {
    const got = next ? ` Got ${JSON.stringify(next)}.` : ""
    const hint =
      next?.startsWith("-") === true
        ? " That looks like another flag; pass `--effort <level> --fast`."
        : ""
    throw new CliFlagError(`--effort requires a level (low, medium, high, xhigh).${got}${hint}`)
  }
  return next
}

/**
 * `--temperature <n>` (or `MINIMAL_AGENT_TEMPERATURE`): a finite number.
 * The flag wins over the env value. Anything else is a usage error (exit 2).
 * The model check (D4) happens in core per request, not here.
 */
export function parseTemperature(
  input: { readonly source: string; readonly raw: string } | undefined,
): number | undefined {
  if (input === undefined) return undefined
  const text = input.raw.trim()
  const value = text === "" ? Number.NaN : Number(text)
  if (!Number.isFinite(value)) {
    throw new CliFlagError(
      `${input.source} requires a finite number. Got ${JSON.stringify(input.raw)}.`,
    )
  }
  return value
}

/** The largest `--schema-retries` value (SPEC-ONESHOT R12). */
const MAX_SCHEMA_RETRIES = 5

/**
 * `--schema-retries <n>`: an integer from 0 to 5. Absent: 0. Anything else
 * is a usage error (exit 2).
 */
export function parseSchemaRetries(raw: string | undefined): number {
  if (raw === undefined) return 0
  const text = raw.trim()
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN
  if (!Number.isInteger(value) || value > MAX_SCHEMA_RETRIES) {
    throw new CliFlagError(
      `--schema-retries requires an integer from 0 to ${MAX_SCHEMA_RETRIES}. Got ${JSON.stringify(raw)}.`,
    )
  }
  return value
}

/** The `--input-format` values (SPEC-ONESHOT R15). */
export type InputFormat = "text" | "open-responses"

/**
 * `--input-format <text|open-responses>`. Absent: `text`. Any other value
 * (or a missing value) is a usage error (exit 2).
 */
export function parseInputFormat(args: readonly string[]): InputFormat {
  const idx = args.indexOf("--input-format")
  if (idx === -1) return "text"
  const value = args[idx + 1]
  if (value === "text" || value === "open-responses") return value
  const got = value === undefined ? "" : ` Got ${JSON.stringify(value)}.`
  throw new CliFlagError(`--input-format requires text or open-responses.${got}`)
}

/** The raw token after `flag` (a leading dash is allowed). */
function rawAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined
}

/**
 * Resolve every CLI option from the normalized args, loaded user config, and
 * environment. Pure: no I/O, no process mutation.
 *
 * @param args - Normalized argv (post `normalizeArgs`, sans `node`/script).
 * @param userConfig - The loaded `~/.minimal-agent/config.json` values.
 * @param env - The process environment (only read).
 * @param parseFormatter - Host-provided formatter-command parser (injected so
 *   this module stays host-free).
 * @returns The fully-resolved option struct.
 */
export function parseCliOptions(
  args: readonly string[],
  userConfig: CliUserConfig,
  env: EnvLike,
  parseFormatter: FormatterParser,
  systemPromptOverrides: SystemPromptOverrides = {},
  startupProfile?: LoadedStartupProfile,
): CliOptions {
  const profile = startupProfile?.profile
  const readFlagValue = makeReadFlagValue(args)

  const model = valueAfter(args, "--model") ?? rawAfter(args, "--model")
  const provider = valueAfter(args, "--provider")
  const endpoint = readFlagValue("--endpoint") ?? env.MINIMAL_AGENT_ENDPOINT ?? userConfig.endpoint
  const format =
    readFlagValue("--format") ??
    readFlagValue("--surface") ??
    env.MINIMAL_AGENT_FORMAT ??
    env.MINIMAL_AGENT_SURFACE ??
    userConfig.format
  const authTypeRaw =
    readFlagValue("--auth-type") ?? env.MINIMAL_AGENT_AUTH_TYPE ?? userConfig.authType
  const authType =
    authTypeRaw === "api-key" ||
    authTypeRaw === "bearer" ||
    authTypeRaw === "none" ||
    authTypeRaw === "custom-header"
      ? authTypeRaw
      : undefined
  const apiKey = readFlagValue("--api-key") ?? env.MINIMAL_AGENT_API_KEY ?? userConfig.apiKey
  const authHeader =
    readFlagValue("--auth-header") ?? env.MINIMAL_AGENT_AUTH_HEADER ?? userConfig.authHeader
  const providerModel =
    readFlagValue("--provider-model") ??
    env.MINIMAL_AGENT_PROVIDER_MODEL ??
    userConfig.providerModel
  // Generic endpoint effort ladder. Comma-separated levels the ad-hoc model
  // advertises (e.g. "low,medium,high"), so `--effort <level>` is accepted for
  // a runtime-configured backend whose codec defaults declare none.
  const effortLevelsRaw =
    readFlagValue("--effort-levels") ?? env.MINIMAL_AGENT_EFFORT_LEVELS ?? undefined
  const effortLevels: string[] | undefined = effortLevelsRaw
    ? effortLevelsRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : userConfig.effortLevels
  const cliCredentialName = valueAfter(args, "--credential-name")

  const wantListModels = args.includes("--list-models")
  const wantListModelsLive = args.includes("--list-models-live")
  const wantListProviders = args.includes("--list-providers")
  // Provider filter for whichever models command won (live preferred if both).
  const listModelsProvider =
    valueAfter(args, "--list-models-live") ?? valueAfter(args, "--list-models")
  const printFormat = parsePrintFormat(
    valueAfter(args, "--print-format") ?? env.MINIMAL_AGENT_PRINT_FORMAT,
  )
  const wantListFlags = args.includes("--list-flags")
  const wantListPlugins = args.includes("--list-plugins")
  const wantListSpinners = args.includes("--list-spinners")

  const wantJsonOutput = args.includes("--json")
  // The `--output-format <text|json|stream-json>` flag. `--json` is the legacy
  // alias; a valid `--output-format` value wins over it (see resolveOutputFormat).
  const outputFormat = resolveOutputFormat({
    outputFormatFlag: valueAfter(args, "--output-format"),
    jsonFlag: wantJsonOutput,
  })
  const wantDiagnostics = args.includes("--diagnostics")
  const debug = args.includes("--debug") || env.DEBUG === "1"
  // A file path or inline JSON (R7). Inline JSON starts with `{`, so the
  // `valueAfter` rule (no leading `-`) still holds.
  const outputSchemaPath = valueAfter(args, "--output-schema")
  const strict = args.includes("--strict")
  // Append text may start with `-` (a list item), so take the raw token.
  const appendSystemPrompt = readFlagValue("--append-system-prompt")
  const appendSystemPromptFile = readFlagValue("--append-system-prompt-file")
  const temperature = parseTemperature(
    args.includes("--temperature") || args.some((a) => a.startsWith("--temperature="))
      ? { source: "--temperature", raw: readFlagValue("--temperature") ?? "" }
      : env.MINIMAL_AGENT_TEMPERATURE !== undefined && env.MINIMAL_AGENT_TEMPERATURE !== ""
        ? { source: "MINIMAL_AGENT_TEMPERATURE", raw: env.MINIMAL_AGENT_TEMPERATURE }
        : undefined,
  )
  const schemaRetries = parseSchemaRetries(
    args.includes("--schema-retries") || args.some((a) => a.startsWith("--schema-retries="))
      ? (readFlagValue("--schema-retries") ?? "")
      : undefined,
  )
  const bare = args.includes("--bare") || profile?.bare === true
  const inputFormat = parseInputFormat(args)

  const headerInputs = {
    args: [...args],
    env: { HEADER: env.MINIMAL_AGENT_HEADER, HEADER_FORMAT: env.MINIMAL_AGENT_HEADER_FORMAT },
    config: { header: userConfig.header, headerFormat: userConfig.headerFormat },
  }
  const showHeader = resolveShowHeader(headerInputs)
  const headerFormat = resolveHeaderFormat(headerInputs)

  const spinnerName = rawAfter(args, "--spinner") ?? env.MINIMAL_AGENT_SPINNER ?? userConfig.spinner

  const { effort, source: effortSource } = resolveEffort({
    cli: readEffortFlag(args),
    env: env.MINIMAL_AGENT_EFFORT,
    config: userConfig.effort,
  })

  const thinkingDisplayRaw =
    readFlagValue("--thinking-display") ??
    env.MINIMAL_AGENT_THINKING_DISPLAY ??
    userConfig.thinkingDisplay
  const thinkingDisplay: "summarized" | "omitted" | undefined =
    thinkingDisplayRaw === "summarized" || thinkingDisplayRaw === "omitted"
      ? thinkingDisplayRaw
      : undefined

  const speedFast = args.includes("--fast") || env.MINIMAL_AGENT_FAST === "1"
  const speed: "normal" | "fast" = speedFast ? "fast" : "normal"

  const serviceTierIdx = args.indexOf("--service-tier")
  const serviceTier: string | undefined =
    serviceTierIdx !== -1 ? args[serviceTierIdx + 1] : env.MINIMAL_AGENT_SERVICE_TIER

  const { ttl: cacheTtl, source: cacheTtlSource } = resolveCacheTtl({
    cli: readFlagValue("--cache-ttl"),
    env: env.MINIMAL_AGENT_CACHE_TTL,
    config: userConfig.cacheTtl,
  })
  // F1/F2 prompt-cache flags: flag > env > config (the cacheTtl pattern).
  const { enabled: cacheAnchor } = resolveCacheAnchor({
    ...(args.includes("--cache-anchor") ? { cli: true } : {}),
    env: env.MINIMAL_AGENT_CACHE_ANCHOR,
    ...(userConfig.cacheAnchor !== undefined ? { config: userConfig.cacheAnchor } : {}),
  })
  const { mode: thinkingHistory } = resolveThinkingHistory({
    cli: readFlagValue("--thinking-history"),
    env: env.MINIMAL_AGENT_THINKING_HISTORY,
    config: userConfig.thinkingHistory,
  })

  const formatterExplicitArg: string[] | undefined = (() => {
    const raw = rawAfter(args, "--formatter")
    return raw ? parseFormatter(raw) : undefined
  })()

  const formatterArgsCli = readFlagValue("--formatter-args")
  const formatterExtraArgs: string[] = (() => {
    if (formatterArgsCli !== undefined) return parseFormatter(formatterArgsCli)
    const envVal = env.MINIMAL_AGENT_FORMATTER_ARGS
    if (envVal && envVal.length > 0) return parseFormatter(envVal)
    return userConfig.formatterArgs ?? []
  })()

  const resumeArg = rawAfter(args, "--resume")
  const resumeSameArg = rawAfter(args, "--resume-same-sid")
  const effectiveResumeArg = resumeSameArg ?? resumeArg

  const sessionIdArg = valueAfter(args, "--session-id")

  const wantListSessions = args.indexOf("--sessions") !== -1
  const sessionsQuery = valueAfter(args, "--sessions")

  const wantUsage = args.indexOf("--usage") !== -1
  const usagePeriod = valueAfter(args, "--usage")

  const dumpArg = rawAfter(args, "--dump")
  const dumpFormatArg = rawAfter(args, "--dump-format") ?? "md"
  const dumpPaths = args.includes("--dump-paths")

  const wantLogin = args.includes("--login")
  const wantLogout = args.includes("--logout")
  const wantAuthStatus = args.includes("--auth-status")
  const hostModeId = valueAfter(args, "--host-mode")

  // --tools "Read,Task,Grep" → allow-list; --no-tools → deny-all
  const cliToolFilter: CliToolFilter = (() => {
    if (args.includes("--no-tools")) return { kind: "deny-all" }
    const toolsVal = readFlagValue("--tools")
    if (toolsVal) {
      const tools = toolsVal
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
      return tools.length > 0 ? { kind: "allow-list", tools } : null
    }
    // No tool flag: the lead's policy from `--startup-profile`, else all.
    return profile !== undefined ? namePolicyFromTools(profile.tools) : null
  })()

  return {
    model,
    provider,
    endpoint,
    format,
    authType,
    apiKey,
    authHeader,
    providerModel,
    effortLevels,
    cliCredentialName,
    wantListModels,
    wantListModelsLive,
    wantListProviders,
    listModelsProvider,
    printFormat,
    wantListFlags,
    wantListPlugins,
    wantListSpinners,
    wantJsonOutput,
    outputFormat,
    wantDiagnostics,
    debug,
    outputSchemaPath,
    strict,
    appendSystemPrompt,
    appendSystemPromptFile,
    temperature,
    schemaRetries,
    bare,
    inputFormat,
    spinnerName,
    showHeader,
    headerFormat,
    effort,
    effortSource,
    thinkingDisplay,
    speed,
    speedFast,
    serviceTier,
    cacheTtl,
    cacheTtlSource,
    cacheAnchor,
    thinkingHistory,
    cacheFlags: { cacheAnchor, thinkingHistory },
    systemPromptOverrides,
    formatterExplicitArg,
    formatterExtraArgs,
    resumeArg,
    resumeSameArg,
    effectiveResumeArg,
    sessionIdArg,
    wantListSessions,
    sessionsQuery,
    wantUsage,
    usagePeriod,
    dumpArg,
    dumpFormatArg,
    dumpPaths,
    wantLogin,
    wantLogout,
    wantAuthStatus,
    cliToolFilter,
    hostModeId,
    startupProfile,
  }
}
