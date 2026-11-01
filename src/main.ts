#!/usr/bin/env bun
// DO NOT disable max-lines !!!
// It's here for a reason: so I force you to decouple and split files into
// better and smaller chunks. - Alex

/**
 * Minimal-agent CLI — the `main()` composition root.
 *
 * `src/index.ts` is the thin bin. It calls {@link main} and sets
 * `process.exitCode` from the result. This module reads no `process.argv`,
 * `process.env`, or `process.cwd()` at import time. {@link MainOptions}
 * takes each one as a parameter. The engine comes from
 * `@minimal-agent/core` (`AgentCore`, the plugin loader, the provider
 * registry). This repo owns argv parsing, help, the TUI, and the
 * `--host-mode` dispatch.
 *
 * **Usage:**
 * ```
 * bun run src/index.ts                          # interactive REPL
 * bun run src/index.ts --model <id>             # specific model
 * bun run src/index.ts --debug                  # log full request/response
 * bun run src/index.ts --list-models            # show available models
 * bun run src/index.ts --list-flags             # show beta flags
 * bun run src/index.ts "hello"                  # one-shot prompt
 * bun run src/index.ts --prompt "hello"         # same, explicit flag
 * echo "hello" | bun run src/index.ts -         # read prompt from stdin
 * bun run src/index.ts --formatter mdstream     # pipe through mdstream (default)
 * bun run src/index.ts --skip-quota             # skip startup quota check
 * DEBUG=1 bun run src/index.ts                  # alternative debug activation
 * ```
 *
 * Or use the shortcut: `./minimal-agent [options]`
 *
 * @module main
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createAgentContext } from "@minimal-agent/core/host/agent-context"
import { resolveAgentName } from "@minimal-agent/core/host/agent-identity"
import { setBashCwdChangeListener } from "@minimal-agent/core/host/bash-cwd"
import { defaultBinDir } from "@minimal-agent/core/host/binaries"
import { loadModeUserOverrides, loadPluginEnabledOverrides } from "@minimal-agent/core/host/config"
import { setGlobalEventBus } from "@minimal-agent/core/host/global-bus"
import {
  buildModelInfoSnapshot,
  buildSubagentModelRecommendations,
} from "@minimal-agent/core/host/model-info"
import {
  applyPreferredDnsResultOrder,
  defaultNetworkClient,
} from "@minimal-agent/core/host/network"
import {
  collectFlagValues,
  resolvePluginEnabledOverrides,
} from "@minimal-agent/core/host/plugin-enable-resolution"
import { resolveEffectivePlatform } from "@minimal-agent/core/host/plugin-platform-resolution"
import { bootProviderDiscovery } from "@minimal-agent/core/host/provider-discovery-boot"
import {
  primeProviderSessionInfo,
  resolveProviderSessionInfo,
} from "@minimal-agent/core/host/provider-session"
import { formatQuotaWindows } from "@minimal-agent/core/host/quota-summary"
import { getSessionId } from "@minimal-agent/core/host/session-id"
import { resolveSessionTarget } from "@minimal-agent/core/host/session-index"
import { TOOL_DEFINITIONS } from "@minimal-agent/core/host/tool-catalog"
import { ToolTimeTracker } from "@minimal-agent/core/host/tool-time"
import {
  combineTurnDrains,
  instantiateTurnAttachments,
} from "@minimal-agent/core/host/turn-attachments"
import { bootstrapUserPlugins } from "@minimal-agent/core/host-kit/auto-plugins"
import {
  computeStartupHashes,
  createLifecyclePort,
  openAgentCoreSession,
} from "@minimal-agent/core/host-kit/build-agent-core"
import { lastAdvertisedModeFromHistory, ModeManager } from "@minimal-agent/core/host-kit/modes"
import { PluginLoader, providerRootsOf } from "@minimal-agent/core/host-kit/plugin-loader"
import { resolveAgentHome } from "@minimal-agent/core/plugin-api/utils/agent-paths"
import type { Message } from "@minimal-agent/core/sdk/messages"
import { parseSchemaFile } from "@minimal-agent/core/sdk/output-schema"
import { applyToolNamePolicy } from "@minimal-agent/core/sdk/tool-filter"
import { extractPromptFromArgs } from "./cli/extract-prompt.ts"
import { resolveInitialModeId } from "./cli/non-interactive-defaults.ts"
import { registerCompactHostCommand } from "./commands/compact.ts"
import { registerContinueHostCommand } from "./commands/continue.ts"
import { InteractiveSession } from "./interactive-session.ts"
import { toolPresentationMap } from "./plugins-ui/tool-presentation.ts"
import { loadPluginUi } from "./plugins-ui/ui-loader.ts"
import { runRepl } from "./repl.ts"
import { buildResumeHeader, replayToScrollback } from "./session-replay.ts"
import { attachStartupDiagnosticSinks } from "./startup/diagnostic-sinks.ts"
import { type EntrypointStderr, prepareEntrypointArgs } from "./startup/entry-args.ts"
import {
  currentExitCode,
  diag,
  endFailedRun,
  publishAgentHomeEnv,
  type StreamFailureState,
  writeStreamFailure,
} from "./startup/entry-exit.ts"
import { readEmbeddedPackageVersion } from "./startup/help.ts"
import { withHostPorts } from "./startup/host-ports.ts"
import { computePluginRoots, DEFAULT_PLUGINS_REPO } from "./startup/plugin-roots.ts"
import { resolveStartupProviderState, startProviderWarmups } from "./startup/provider-boot.ts"
import {
  modelHidesReasoning,
  providerWantsQuotaProbe,
  signInStepLabel,
} from "./startup/provider-presentation.ts"
import { peekResumeCredentialPin } from "./startup/resolve-credential-name.ts"
import { continueResumedTurn } from "./startup/resume-continue.ts"
import {
  loadResumeState,
  type ResumedToolDisplay,
  type ResumeState,
} from "./startup/resume-load.ts"
import { isHostModeRun, isInteractiveResumeRun, isReplRun } from "./startup/resume-mode.ts"
import { runHostMode } from "./startup/run-host-mode.ts"
import { runNonInteractivePrompt, selectStdioMode } from "./startup/run-non-interactive.ts"
import { runStartupSubcommand } from "./startup/run-subcommand.ts"
import { bootSessionStores, resumeTargetOf } from "./startup/session-store-boot.ts"
import {
  printStartupConfigRows,
  printTerminalViewportRow,
  publishResolvedRequestEnv,
  validateStartupEffort,
} from "./startup/startup-rows.ts"
import type { StreamInfo } from "./startup/stream-json-writer.ts"
import { isColdStart, maybeShowFirstRunWelcome } from "./ui/chrome/first-run.ts"
import { buildReadyBanner } from "./ui/chrome/ready-banner.ts"
import { resolveFormatter } from "./ui/formatter/auto.ts"
import { resolveSpinnerPreset } from "./ui/spinner/named-presets.ts"
import {
  closeStartupTree,
  closeStartupTreeWithTools,
  printStartupHeader,
  printStartupRow,
  startStartupRowSpinner,
} from "./ui/startup/tree.ts"
import { c } from "./ui/style/ansi.ts"
import { formatFatalError } from "./ui/turn-error.ts"

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Inputs for {@link main}. Each one defaults to the real process value. */
export interface MainOptions {
  /** Raw argv, without the executable and script slots. */
  readonly argv?: readonly string[]
  /**
   * Mutable environment. Startup writes `MINIMAL_AGENT_*` values here for
   * plugins. Plugins read `process.env`, so a real run passes `process.env`.
   */
  readonly env?: NodeJS.ProcessEnv
  /** Working directory for plugins, `--resume` lookup, and session events. */
  readonly cwd?: string
  /**
   * Hard exit for the paths that must end the process now: `--help`, argv
   * errors, and the end of the REPL. Defaults to `process.exit`. A path
   * that wrote stream-json lines never calls it. It returns a code instead.
   */
  readonly exit?: (code: number) => never
  /** Sink for early argv errors. Defaults to `process.stderr`. */
  readonly stderr?: EntrypointStderr
}

/**
 * Run the CLI and return its process exit code.
 *
 * Orchestrates the full startup flow:
 *
 * 1. Parse argv (`--help` and argv errors end here)
 * 2. Publish the resolved agent home into the environment
 * 3. Boot provider discovery; dispatch one-shot subcommands
 * 4. Detect cold start and show the first-run welcome card
 * 5. Resolve the provider/model + auth state and print startup rows
 * 6. Hand the process to a `--host-mode` plugin, run a single `--prompt`
 *    turn, or enter the interactive REPL
 *
 * A thrown error prints the fatal-error text and gives code 1.
 */
export async function main(options: MainOptions = {}): Promise<number> {
  const baseExit = options.exit ?? ((code: number): never => process.exit(code))
  // An injected exit (tests) throws. Let that throw pass through unchanged
  // instead of reporting it as a fatal error.
  let exitRequested = false
  const exit = (code: number): never => {
    exitRequested = true
    return baseExit(code)
  }
  const failure: StreamFailureState = {}
  try {
    return await runEntrypoint(
      {
        argv: options.argv ?? process.argv.slice(2),
        env: options.env ?? process.env,
        cwd: options.cwd ?? process.cwd(),
        exit,
        ...(options.stderr ? { stderr: options.stderr } : {}),
      },
      failure,
    )
  } catch (err) {
    if (exitRequested) throw err
    const wrote = writeStreamFailure(failure, err)
    console.error(formatFatalError(err instanceof Error ? err : new Error(String(err))))
    return endFailedRun(wrote, exit)
  } finally {
    await defaultNetworkClient.close()
  }
}

/** Resolved {@link MainOptions}. */
interface EntrypointIo {
  readonly argv: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  readonly exit: (code: number) => never
  readonly stderr?: EntrypointStderr
}

/** The body of {@link main}. See there for the flow. */
async function runEntrypoint(io: EntrypointIo, failure: StreamFailureState): Promise<number> {
  const { env, cwd, exit } = io
  applyPreferredDnsResultOrder()

  // All the side-effecting entry-point argument setup (smart-dash rejection,
  // `--help` dispatch, env flag propagation, config load, command planning,
  // startup-tree visibility, and early session-id seeding) lives in
  // `startup/entry-args.ts`. It leans on the pure `cli/*` parsers and keeps
  // this file a thin composition root. See that module for the precedence
  // rules.
  const entry = prepareEntrypointArgs({
    rawArgv: [...io.argv],
    env,
    cwd,
    exit,
    ...(io.stderr ? { stderr: io.stderr } : {}),
  })
  const { args, userConfig, opts, commandPlan, showHeader: SHOW_HEADER, readFlagValue } = entry
  const extractPrompt = entry.extractPrompt
  const {
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
    listModelsProvider,
    printFormat,
    wantJsonOutput,
    outputFormat,
    outputSchemaPath,
    spinnerName,
    effort,
    effortSource,
    thinkingDisplay,
    speed,
    speedFast,
    serviceTier,
    cacheTtl,
    cacheTtlSource,
    formatterExplicitArg,
    formatterExtraArgs,
    resumeSameArg,
    effectiveResumeArg,
    sessionsQuery,
    usagePeriod,
    dumpArg,
    dumpFormatArg,
    dumpPaths,
  } = opts
  failure.args = args
  failure.outputFormat = outputFormat
  failure.outputSchemaPath = outputSchemaPath

  // Publish the resolved agent home into the environment BEFORE anything else,
  // so every plugin (and subprocess) inherits an authoritative, relocation-
  // correct base path (`MINIMAL_AGENT_HOME`) instead of hardcoding
  // `~/.minimal-agent`. This is the host→plugin "where is my storage" signal
  // (see `src/agent-paths.ts`). Idempotent and override-preserving.
  publishAgentHomeEnv(env)

  // Register provider plugins by discovery (plugins/llm-*) BEFORE any model
  // resolution (the bootstrap probe + footer + canonical run() all read the
  // registry). Replaces the old static builtin barrel: the entrypoint imports
  // no provider by name. Idempotent; a missing plugins dir yields no providers
  // rather than throwing.
  const srcDir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url))
  const providerEmbeddedDir = dirname(srcDir)
  // minimal-agent's own per-user plugins root (`~/.minimal-agent`). The
  // first-run bootstrap clones the extended first-party plugins — which now
  // include the LLM PROVIDERS — into `<userDir>/plugins`. Resolved up front
  // because BOTH the provider discovery just below and the first-run clone
  // key off it. Cheap + pure (reads env).
  const userDir = resolveAgentHome(env)

  // First-run plugin bootstrap (silent, before provider discovery). On a
  // freshly-installed box the extended first-party plugins (Fetch, Skill,
  // slash-menu, …) AND the LLM provider plugins (anthropic, openai, …) aren't
  // present; clone them ONCE into `<userDir>/plugins` so the provider discovery
  // below finds them. This MUST run before provider discovery because the
  // providers now ship IN the cloned repo — without them, a fresh install
  // finds zero providers and dies with "no provider credentials found" before
  // the user can sign in.
  //
  // Best-effort and fully gated:
  //   - skipped entirely in non-interactive runs (--prompt / `-` / piped):
  //     a one-shot scripted call shouldn't reach out to the network or grow
  //     the toolset under the user's feet.
  //   - opt-out via MINIMAL_AGENT_NO_PLUGIN_SYNC=1 or config `pluginSync:false`.
  //   - never throws; a private-repo / offline / no-git box degrades to the
  //     embedded plugins with a quiet startup row.
  //   - silent (no spinner, no startup row) because the tree hasn't opened yet.
  //     A startup row is printed later, after the tree opens, if the clone
  //     actually ran.
  let pluginSyncResult: Awaited<ReturnType<typeof bootstrapUserPlugins>> | undefined
  if (userDir && SHOW_HEADER) {
    const pluginSyncEnabled =
      env.MINIMAL_AGENT_NO_PLUGIN_SYNC === "1" ? false : (userConfig.pluginSync ?? true)
    const pluginsRepo =
      env.MINIMAL_AGENT_PLUGINS_REPO?.trim() || userConfig.pluginsRepo || DEFAULT_PLUGINS_REPO
    pluginSyncResult = await bootstrapUserPlugins({
      targetDir: join(userDir, "plugins"),
      enabled: pluginSyncEnabled,
      repoUrl: pluginsRepo,
      // Silent: no spinner or startup row yet — the tree hasn't opened.
      showSpinner: false,
      // Core labels are plain (S41). The CLI styles the startup row label.
      styles: c,
    })
  }

  // Every plugin root, computed here (S40): core knows no default plugin
  // location. See `startup/plugin-roots.ts`.
  const pluginRoots = computePluginRoots(providerEmbeddedDir, env, cwd, userDir)

  // Provider plugins (provider.json) live in the plugins repo. On an
  // installed box they are git-cloned into `<userDir>/plugins` (just above).
  // Discover from the embedded roots (incl. the dev checkout) AND the user
  // clone root, so a cloned provider is found. Earlier roots win on id
  // collision. Without the user root a fresh install finds zero providers
  // → `0 models available` and a fatal boot.
  await bootProviderDiscovery({ roots: providerRootsOf(pluginRoots) })

  // Dispatch one-shot subcommands (dump/sessions/usage/list-*/login/logout/
  // auth-status). Returns true when handled (we return); login/logout/
  // auth-status exit directly. `repoRoot` is computed HERE (this file lives at
  // src/ and can trust import.meta.dirname) and passed in, so the dispatcher
  // never derives fs roots from its own location.
  const handledSubcommand = await runStartupSubcommand({
    commandPlan,
    args,
    dumpArg,
    dumpFormatArg,
    dumpPaths,
    sessionsQuery,
    usagePeriod,
    listModelsProvider,
    printFormat,
    repoRoot: dirname(srcDir),
    readFlagValue,
  })
  if (handledSubcommand) return currentExitCode()

  // S38: stdio by mode. On the JSON event route only the event writer may
  // reach stdout from here on. A stray write fails the run.
  const stdioMode = selectStdioMode(args, commandPlan.command, opts)

  // Cold-start detection must happen BEFORE any subsystem creates
  // `~/.minimal-agent` (the file-log sink below does, on its first write).
  // Capture it here so the welcome card and the post-setup hint can both key
  // off a single honest "is this the very first run on this machine" signal.
  const coldStart = isColdStart()

  // First-run welcome card. Interactive cold starts only — a scripted
  // `--prompt` run stays silent. Frames the one-time auto-setup (sign-in,
  // mdstream, plugins) so the spinners that follow read as expected setup.
  // The steps listed mirror exactly what the boot flow does next.
  const firstRunInteractive = process.stdin.isTTY === true && process.stdout.isTTY === true
  if (coldStart && firstRunInteractive && SHOW_HEADER) {
    maybeShowFirstRunWelcome({
      isInteractive: true,
      steps: [
        // Provider-supplied label: names the default provider's displayName,
        // or a neutral "sign in to your account" when none is registered.
        { label: signInStepLabel() },
        { label: `fetch ${c.bold("mdstream")}, the Markdown renderer` },
        {
          label: `fetch the extended plugins ${c.dim("(Fetch, Skill, slash-menu, …)")}`,
        },
      ],
    })
  }

  printStartupHeader()
  printStartupRow("session", c.dim(getSessionId()))

  // Resolve the per-session agent name ONCE, here, and reuse the value
  // for both the startup `name` row below and the env publication further down
  // (the `agent-identity` plugin reads MINIMAL_AGENT_AGENT_NAME). On by
  // default (as if "auto"): every session gets a stable derived name unless
  // the user opts out with an OFF sentinel, in which case the resolver returns
  // undefined and no row is printed. See `src/agent-name.ts` for the
  // resolution priority + the cache rationale.
  const resolvedAgentName = resolveAgentName({
    sessionId: getSessionId(),
    configName: userConfig.agentName,
    envName: env.MINIMAL_AGENT_AGENT_NAME,
  })
  if (resolvedAgentName) printStartupRow("name", c.dim(resolvedAgentName))

  // Diagnostic bus: attach the file sink as early as possible so even
  // plugin-load warnings land in `~/.minimal-agent/logs/ma-session-<sid>.log`.
  // The TUI surface attaches later from `runReplLiveArea` (it needs the
  // editor / aggregator). The stderr mirror is opt-in.
  //
  // The scrollback sink is constructed here and kept on a process-scoped
  // variable so we can `startBuffering()` it BEFORE any startup-banner
  // row is drawn and `flushBuffer()` AFTER `closeStartupTree()` commits
  // the final `╰`. Without this two-phase wiring, a plugin-loader (or
  // auth / config) warning emitted mid-banner would tear through the
  // box mid-paint instead of landing cleanly below it with the proper
  // `⚠ warn ╰` chrome.
  // Wire the process-wide diagnostic sinks (file log, global audit log,
  // scrollback, opt-in stderr mirror). Returns the scrollback sink so we can
  // drive its two-phase buffer lifecycle (startBuffering armed inside when
  // SHOW_HEADER; flushBuffer below after closeStartupTree).
  const scrollbackSink = await attachStartupDiagnosticSinks({
    showHeader: SHOW_HEADER,
    env: env,
    mode: stdioMode,
    debug: opts.debug,
  })

  // Plugin-sync startup row. The clone itself ran silently before provider
  // discovery (above); now that the tree is open, surface the result.
  if (pluginSyncResult) {
    if (pluginSyncResult.status === "cloned") {
      printStartupRow("plugins", `${c.dim("+")} ${c.dim(pluginSyncResult.label)}`)
    } else if (pluginSyncResult.status === "failed" || pluginSyncResult.status === "skipped") {
      // Quiet, non-fatal. Detail lands in the file log via the diagnostic bus
      // (the loader still runs with embedded plugins only).
      diag.notice("plugin-sync", pluginSyncResult.detail ?? pluginSyncResult.label)
    }
  }

  // Resolve model/provider/auth once, up front. Everything that is
  // provider-specific (startup probe, quota) keys off this so a session
  // started with an explicit provider/model pair never contacts the wrong host.
  // See `host/startup/provider-boot.ts` for the resolution + ad-hoc model
  // registration; it prints the `auth` startup row.
  const resumeCredPin = peekResumeCredentialPin(effectiveResumeArg)
  const providerState = await resolveStartupProviderState({
    opts: {
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
    },
    userConfig,
    env: env,
    ...(resumeCredPin.credentialName ? { resumeCredentialName: resumeCredPin.credentialName } : {}),
    ...(resumeCredPin.providerId ? { resumeProviderId: resumeCredPin.providerId } : {}),
  })
  const { selectedModel, selectedModelBase, selectedProviderId, credentialName, auth } =
    providerState

  // Fire-and-forget provider warm-ups (bootstrap overlay probe + session-info
  // prime) for the SELECTED provider only, so a gpt-5.5 session never contacts
  // api.anthropic.com just because the host holds an Anthropic OAuth session.
  // Both self-gate and swallow failures (local pricing stays authoritative).
  startProviderWarmups(providerState)

  // Resolve formatter: explicit --formatter, PATH, cached binary, or auto-download.
  // Protocol mode renders no markdown, so it skips the formatter and its
  // human warn line on stderr (S38).
  let formatterCmd: string[] | undefined
  if (commandPlan.needsFormatter && stdioMode !== "protocol") {
    const formatterResolution = await resolveFormatter(formatterExplicitArg)
    if (formatterResolution.cmd) {
      formatterCmd = formatterResolution.cmd
      // Append user-supplied extra args (--formatter-args / env / config).
      // Applied here (after resolution) so they ride along regardless of
      // whether the formatter came from PATH, the cache, an auto-download,
      // or an explicit --formatter override.
      if (formatterExtraArgs.length > 0) {
        formatterCmd = [...formatterCmd, ...formatterExtraArgs]
      }
      const extraLabel =
        formatterExtraArgs.length > 0 ? ` ${c.dim(formatterExtraArgs.join(" "))}` : ""
      printStartupRow("formatter", `${c.dim(formatterResolution.label)}${extraLabel}`)
    } else {
      formatterCmd = undefined
      console.error(`  ${c.boldYellow("warn")} ${formatterResolution.warn}`)
    }
  } else {
    formatterCmd = undefined
  }

  // Print the model / service-tier / thinking / effort / cache-ttl banner
  // rows (pure presentation + provenance labels, in host/startup/startup-rows).
  printStartupConfigRows({
    selectedModel,
    speedFast,
    serviceTier,
    thinkingDisplay,
    effort,
    effortSource,
    cacheTtl,
    cacheTtlSource,
  })
  const hidesReasoning = modelHidesReasoning(selectedModel)
  // Fail fast if the resolved effort isn't among the model's declared levels.
  // Pass selectedProviderId so dual-registered bare ids (grok-4.5 on grok +
  // opencode) validate against THIS provider's caps, not unscoped last-write.
  validateStartupEffort(hidesReasoning, selectedModelBase, effort, selectedProviderId)

  // Terminal viewport row (cols × rows) for the compositor / mdstream.
  printTerminalViewportRow(env, process.stdout)

  // Load Plugins from ~/.agents/plugins and <cwd>/plugins.
  // Core tool names must always win over plugin names.
  const coreToolNames = new Set(TOOL_DEFINITIONS.map((t) => t.name))
  // `userDir` (the per-user agent home) is resolved up front, before provider
  // discovery, and the first-run plugin clone runs earlier still (before
  // provider resolution) — because the LLM providers now ship IN the cloned
  // plugins repo, so they must exist before auth/sign-in. See both blocks above.

  // Embedded plugins ship inside the agent's own checkout: `<repo>/plugins/`.
  // `import.meta.dirname` (Bun + Node 20+) of this file is `<repo>/src`, so
  // climb one level. This makes ask-mode/diff-view/env-info/memory work
  // regardless of the user's cwd, not just when cwd === <repo>.
  const thisFileDir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url))
  const embeddedDir = dirname(thisFileDir)

  // Construct the single AgentContext shared across every plugin
  // dispatch path (tool handlers, prompt fragments, event subs, hook
  // subs, live-area slots, plus their subprocess counterparts). The
  // loader and the live-area scheduler both receive THIS object so
  // plugins see one consistent identity regardless of dispatch path.
  //
  // Source of each field:
  //   - sessionId : metadata.getSessionId() (cached UUIDv4)
  //   - pid       : process.pid (Bun process)
  //   - model     : selectedModel (resolved above by resolveModelId)
  //   - version   : <embeddedDir>/package.json#version, "0.0.0" if missing
  //
  // The object is frozen by createAgentContext, so it can be passed
  // around without defensive copies.
  const agentVersion = readEmbeddedPackageVersion(embeddedDir)
  // Values for the stream-json session_started line. No auth, token,
  // credential name, or env values go here. A forked `--resume` adds
  // `resumedFrom` below, once the source session id is resolved.
  let streamInfo: StreamInfo = {
    sessionId: getSessionId(),
    model: selectedModel,
    provider: selectedProviderId,
    effort,
    version: agentVersion,
    cwd: cwd,
  }
  failure.info = streamInfo
  const agentContext = createAgentContext({
    sessionId: getSessionId(),
    pid: process.pid,
    model: selectedModel,
    version: agentVersion,
  })

  // Mirror MINIMAL_AGENT_MODEL into process.env for legacy direct readers
  // (notably `plugins/quota-status/handler.ts`, which reads
  // `process.env.MINIMAL_AGENT_MODEL`, not `ctx.env`). The loader will
  // also emit MINIMAL_AGENT_* via `agentContextToEnv` into every dispatched
  // ctx.env, but those values are scoped to one handler call and don't
  // reach a `process.env`-only reader.
  env.MINIMAL_AGENT_MODEL = selectedModel
  env.MINIMAL_AGENT_PROVIDER = selectedProviderId
  if (endpoint) env.MINIMAL_AGENT_ENDPOINT = endpoint
  if (format) env.MINIMAL_AGENT_FORMAT = format
  if (authType) env.MINIMAL_AGENT_AUTH_TYPE = authType
  if (apiKey) env.MINIMAL_AGENT_API_KEY = apiKey
  if (authHeader) env.MINIMAL_AGENT_AUTH_HEADER = authHeader
  if (providerModel) env.MINIMAL_AGENT_PROVIDER_MODEL = providerModel
  if (effortLevels && effortLevels.length > 0) {
    env.MINIMAL_AGENT_EFFORT_LEVELS = effortLevels.join(",")
  }
  env.MINIMAL_AGENT_SESSION_ID = agentContext.sessionId
  env.MINIMAL_AGENT_PID = String(agentContext.pid)
  env.MINIMAL_AGENT_VERSION = agentContext.version
  // Publish the opt-in per-session agent name (resolved once up front, beside
  // the startup `name` row) for the `agent-identity` plugin to read (the loader
  // spreads process.env into every prompt-fragment ctx.env). The name is frozen
  // for the session: it lands in the system prompt, so changing it mid-run would
  // bust the conversation's prompt cache. Off by default (resolver returned
  // undefined → we clear the env so the plugin emits nothing and the system
  // prompt is byte-identical to today's).
  if (resolvedAgentName) {
    env.MINIMAL_AGENT_AGENT_NAME = resolvedAgentName
  } else {
    delete env.MINIMAL_AGENT_AGENT_NAME
  }
  // Advertise the managed-binary directory (`~/.minimal-agent/bin`) to every
  // plugin, every session. The host OWNS this dir and provisions binaries into
  // it (see `binaries/store.ts`); plugins must NOT scan the filesystem or
  // hard-code a home path of their own, because the home dir differs per
  // install and the agent is the single party that knows where it put things.
  // The loader already spreads `process.env` into every dispatched `ctx.env`,
  // so setting it here makes `MINIMAL_AGENT_BIN_DIR` reach module handlers and
  // any subprocess they spawn. Set UNCONDITIONALLY (not gated on header /
  // provisioning): a previously-installed binary must still resolve on a
  // scripted `--prompt` run where the provisioning phase is skipped.
  env.MINIMAL_AGENT_BIN_DIR = defaultBinDir()
  // Publish the RESOLVED effort + fast-mode state into process.env as the
  // authoritative output the quota-status footer / session-info read.
  publishResolvedRequestEnv(hidesReasoning, effort, speedFast)
  // Effective platform for plugin/tool `platforms` whitelist gating:
  // --platform > MINIMAL_AGENT_PLATFORM > detected (process.platform).
  // `all` (or `any`/`*`) bypasses gating for the session.
  const platformIdx = args.indexOf("--platform")
  const resolvedPlatform = resolveEffectivePlatform({
    cli: platformIdx !== -1 ? args[platformIdx + 1] : undefined,
    env: env.MINIMAL_AGENT_PLATFORM,
  })
  if (resolvedPlatform.invalid !== undefined) {
    diag.warn(
      "plugin-loader",
      `ignoring unrecognized platform override ${JSON.stringify(resolvedPlatform.invalid)}; ` +
        `using ${resolvedPlatform.platform} (${resolvedPlatform.source}). ` +
        `Valid: macos, linux, windows, all.`,
    )
  }
  const configPluginOverrides = loadPluginEnabledOverrides()
  // `--no-agents-md` / `--no-agents` / MINIMAL_AGENT_NO_AGENTS_MD=1 are
  // convenience aliases that force-disable the `agents-md` plugin (AGENTS.md
  // system-prompt injection). Equivalent to `--disable-plugin agents-md`.
  const noAgentsMd =
    args.includes("--no-agents-md") ||
    args.includes("--no-agents") ||
    env.MINIMAL_AGENT_NO_AGENTS_MD === "1"
  const pluginOverrides = resolvePluginEnabledOverrides({
    config: configPluginOverrides,
    env: {
      disable: env.MINIMAL_AGENT_DISABLE_PLUGINS,
      enable: env.MINIMAL_AGENT_ENABLE_PLUGINS,
    },
    cli: {
      disable: [
        ...collectFlagValues(args, "--disable-plugin"),
        ...(noAgentsMd ? ["agents-md"] : []),
      ],
      enable: collectFlagValues(args, "--enable-plugin"),
    },
  })
  // Late-bound getter for the agent's LIVE model id. The loader loads before
  // the Agent is constructed, and the model can change mid-session (/model,
  // preflight switch) or differ on resume, so the ModelInfo tool must read the
  // current value, never the boot value. Rebound to `agent.getModel()` below.
  let getLiveModelId: () => string = () => selectedModel
  let getLiveProviderId: () => string | undefined = () => selectedProviderId
  // Only the REPL loads plugin `ui` modules and the terminal env (S35).
  const replRoute = isReplRun(extractPromptFromArgs(args), commandPlan.command)
  const loader = await PluginLoader.load({
    // Every root comes from the CLI (S40), incl. the dev plugins checkout.
    roots: pluginRoots,
    coreToolNames,
    // Single AgentContext shared with every plugin dispatch path.
    // Frozen value object; see createAgentContext + AgentContext docs.
    agent: agentContext,
    // Live current-model snapshot for the decoupled `ModelInfo` tool. Reads the
    // agent's CURRENT model (via the late-bound getter) + the shared registry,
    // so it stays correct across mid-session switches and resume.
    modelInfoProvider: () => buildModelInfoSnapshot(getLiveModelId(), getLiveProviderId()),
    // Active-provider sub-agent model recommendations (role → concrete model),
    // read live so a delegation plugin maps roles without importing a provider.
    recommendSubagentModels: () => buildSubagentModelRecommendations(getLiveModelId()),
    // Universal opt-out: `plugins.<id>.enabled === false` in config, env
    // (`MINIMAL_AGENT_DISABLE_PLUGINS`), or CLI (`--disable-plugin`).
    // The matching enable set overrides a manifest-level `enabled: false`
    // author opt-out (config, env, or `--enable-plugin`).
    disabledPluginIds: pluginOverrides.forceDisabled,
    enabledPluginIds: pluginOverrides.forceEnabled,
    // Effective platform for `platforms` whitelist gating (CLI/env/detected).
    effectivePlatform: resolvedPlatform.platform,
  })
  // Expose the loader's event bus to deep emit-points (notably
  // `client.ts`, which broadcasts `quota.headersReceived` after every
  // successful API response — see src/global-bus.ts for the rationale).
  setGlobalEventBus(loader.bus())
  // The UI part of each accepted plugin (S35): live-area slots from the
  // `ui` block, granted `ctx.tui`. Core loads only the headless part.
  const pluginUi = await loadPluginUi({
    packages: loader.loadedPackages(),
    logger: (m) => diag.warn("plugin-ui", m),
    importModules: replRoute,
  })
  // Per-turn attachment producers + content drains, contributed by
  // plugins through the loader's `turnAttachments` manifest seam (the
  // memory plugin's short-term snapshot + save-echo collector, the
  // tasks snapshot, the sub-agents fleet digest, …). Core consumes ONLY
  // the registry — it neither knows nor imports the producers'
  // identities (the I2 invariant). A disabled/absent plugin simply
  // contributes nothing: the agent then runs without that attachment
  // (graceful degradation, pinned in `src/agent/turn-attachments.test.ts`).
  const turnAttachmentSeam = await instantiateTurnAttachments(
    { sessionId: getSessionId(), bus: loader.bus() },
    (m) => diag.notice("turn-attachments", m),
  )
  const saveEcho = combineTurnDrains(turnAttachmentSeam.drains)
  // Resolve async prompt fragments BEFORE querying getExtraTools().
  // The skills plugin's fragment calls registerDynamicTools() to
  // push skill-declared tools (like police_911) into the loader's
  // tool index.  If we query too early those tools are missing from
  // the startup banner, the tool hash, and the first turn's API
  // request.  getPromptBlockAsync() awaits all fragment promises,
  // then memoizes; subsequent calls (sync and async) return cached.
  const promptBlocks = await loader.getPromptBlocksAsync()
  const loadedTools = loader.getExtraTools()
  const loadedModes = loader.getModes()
  const hasPromptBlock =
    loader.getPromptBlock() !== null ||
    (promptBlocks.afterInstructions != null && promptBlocks.afterInstructions.length > 0)
  // Host lifecycle port (HookBus adapter). Used for session/cwd/instructions
  // broadcasts that live outside AgentCore's conversation loop.
  const hostLifecycle = createLifecyclePort(loader.hooks())
  if (promptBlocks.afterInstructions) {
    void hostLifecycle.instructionsDidLoad?.({ source: "agents-md" })
  }
  if (promptBlocks.sessionContext) {
    void hostLifecycle.instructionsDidLoad?.({
      source: "plugin-session-context",
    })
  }
  // Sticky Bash cwd → `cwd.didChange` for observe-only plugins.
  setBashCwdChangeListener((from, to) => {
    void hostLifecycle.cwdDidChange?.({ from, to })
  })
  // Aggregate flag preserved for downstream system-prompt / tool-hash
  // construction (search this file for `hasPlugins`). Independently of
  // how we choose to render the startup tree, those callers want one
  // bool: "did anything plugin-shaped get loaded".
  const hasPlugins = loadedTools.length > 0 || hasPromptBlock || loadedModes.length > 0
  // Show what the plugin layer actually contributes — names of callable
  // tools rather than an aggregate `3 tool(s)`. The active mode (if any)
  // gets its own row below at the `printStartupRow("mode", …)` site, so
  // we don't duplicate it here. Modes that exist but aren't active are
  // intentionally not surfaced — discoverable via Shift+Tab.
  //
  // The tools row is deferred — it will be printed last, as the closer
  // row (with `╰` gutter), via `closeStartupTreeWithTools` right before
  // the REPL boots. Deferring avoids the fragile cursor-up rewrite math
  // that broke on terminal resize when the full tool inventory wrapped
  // across many continuation lines.
  //
  // Plugins that contribute only prompt fragments / live-area slots /
  // modes still get a quiet acknowledgement row here.
  if (loadedTools.length === 0 && (hasPromptBlock || loadedModes.length > 0)) {
    printStartupRow("plugins", c.dim("loaded"))
  }
  // Plugin setup phase: binary provisioning. Each plugin's optional `setup()`
  // declares the external binaries it needs (hardcoded url/sha256/version); the
  // host installs/updates any that are missing or outdated into the managed
  // `~/.minimal-agent/bin/`, with a startup-row spinner + a syslog audit trail
  // in `~/.minimal-agent/ma.log`. A plugin NEVER downloads or probes paths
  // itself. If a plugin marks a binary mandatory (`haltIfMissing`) and it can't
  // be provisioned, we stop here with the plugin's message rather than let the
  // user hit a broken tool at first call.
  //
  // Gated to header runs (interactive boots) for the same reason as the plugin
  // clone: a scripted `--prompt` / piped run shouldn't reach out to the network
  // or grow the install set under the user's feet. Opt out entirely with
  // MINIMAL_AGENT_NO_BINARY_SETUP=1.
  if (SHOW_HEADER && env.MINIMAL_AGENT_NO_BINARY_SETUP !== "1") {
    const { provisionPluginBinaries } = await import("./startup/provision-binaries.ts")
    await provisionPluginBinaries(loader)
  }

  // Resolve the initial mode. In non-interactive (--prompt/`-`/positional)
  // we default to ASK so one-shot runs are read-only by default; the user
  // opts out via `--mode none`, `MINIMAL_AGENT_MODE=none`, or
  // `config.mode = "none"`. See `resolveInitialModeId` for full precedence.
  const initialModeId =
    loadedModes.length > 0
      ? resolveInitialModeId(
          {
            args,
            env: { MODE: env.MINIMAL_AGENT_MODE },
            config: { mode: userConfig.mode },
          },
          loader.getDefaultModeId(),
        )
      : null
  // Per-mode user-config overlays for permissions. Snapshotted once at
  // startup; the user can edit `~/.minimal-agent/config.jsonc` and
  // restart to apply. (Hot-reload of permissions is future work.) The
  // overlay map is queried on demand inside `ModeManager.effectivePermissions`.
  const modeUserOverrides = loadedModes.length > 0 ? loadModeUserOverrides() : new Map()
  // Always construct a ModeManager when `--tools` / `--no-tools` is set, even
  // with zero modes: the manager owns CLI-level filter application for the
  // request body (`filterToolsForCli`) and isToolAllowed dispatch gate.
  const modeManager =
    loadedModes.length > 0 || opts.cliToolFilter != null
      ? new ModeManager(
          loadedModes,
          initialModeId,
          undefined,
          undefined,
          (modeId) => modeUserOverrides.get(modeId) ?? null,
          opts.cliToolFilter,
        )
      : null
  if (modeManager?.active()) {
    // Use the manifest's `label` (e.g. "ASK") rather than the lowercase
    // `id` so the startup row matches the prompt prefix the user sees a
    // moment later (`ASK ❯ `). Falls back to upper-cased id when label
    // isn't declared, mirroring `modePromptPrefixForId` (`ui/style/mode-prompt.ts`).
    const m = modeManager.active()!
    const label = m.label ?? m.id.toUpperCase()
    printStartupRow("mode", c.bold(c.cyan(label)))
  }

  // Quota check — verify account has quota before starting conversation
  // with a cheap probe request.
  //
  // Skipped automatically when ANY loaded plugin contributes a live-area
  // slot with id `"quota"` — the slot will fetch the same data
  // asynchronously after REPL boot, so blocking the boot here would just
  // duplicate the work and re-introduce the latency we're trying to
  // eliminate. The user-facing benefit: the live area shows up
  // instantly; the quota row populates a moment later.
  const hasQuotaSlot = pluginUi.slotIds.includes("quota")
  const shouldSkipQuota =
    !commandPlan.needsQuota ||
    // Only meaningful for a provider that declares a quota-probe seam. A
    // provider whose quota fills from chat traffic (or that has no quota
    // concept) declares none and skips the blocking boot probe. See
    // `providerWantsQuotaProbe` in src/startup/provider-presentation.ts.
    !providerWantsQuotaProbe(selectedProviderId) ||
    args.includes("--skip-quota") ||
    env.MINIMAL_AGENT_SKIP_QUOTA === "1" ||
    userConfig.skipQuota === true ||
    hasQuotaSlot

  if (!shouldSkipQuota) {
    const quotaSpinner = startStartupRowSpinner("quota", c.dim("checking..."))
    // Warm the selected provider's quota cache via its own session-prime seam
    // (the canonical, provider-neutral probe). Blocking-but-bounded: the prime
    // never throws and self-bounds its deadline, so a slow/unreachable provider
    // degrades to an empty banner segment rather than stalling boot. The old
    // path issued a provider-specific quota POST here and hard-exited on a bad
    // token; that boot-time, single-provider gate is intentionally gone — auth
    // failures now surface on the first real turn with a proper error.
    await primeProviderSessionInfo(selectedModel, {
      providerId: selectedProviderId,
    })
    // Banner quota summary: provider-NEUTRAL path. The prime above populated the
    // quota cache; the provider plugin's session-info seam parses its own header
    // shapes into neutral QuotaWindows, and core renders those (header-name
    // knowledge stays out of core).
    let quotaSegment = ""
    try {
      const info = await resolveProviderSessionInfo(selectedModel, {
        providerId: selectedProviderId,
      })
      quotaSegment = formatQuotaWindows(info.quota?.windows ?? [], {
        leadSpaces: 2,
        showOverage: env.MINIMAL_AGENT_QUOTA_OVERAGE === "1",
        overage: info.quota?.overage,
        // Core emits plain text (S41). The CLI terminal-kit styles it.
        styles: c,
      })
    } catch {
      // No provider session seam (or cold cache): skip the segment.
    }
    quotaSpinner.ok(`${c.boldGreen("ok")} ${c.boldGreen("✔")}${quotaSegment}`)
  }
  // Resolve --resume: load prior conversation if asked. Resolve the sid,
  // load the session (see `startup/resume-load.ts`), and prepare
  // `initialMessages` to seed the new agent. Each value stays empty or null
  // when not resuming.
  let resumeSid: string | null = null
  let initialMessages: Message[] = []
  let displayMessages: Message[] = []
  let resumeCompactBoundaries: ResumeState["compactBoundaries"] = []
  let pendingDraft: string | null = null
  let toolStartTimes: Map<string, number> | null = null
  let userTimestamps: (Date | null)[] | null = null
  let toolDisplays: Map<string, ResumedToolDisplay> | null = null
  // S50: set when the resumed session's last turn is unfinished. The run
  // then continues that turn by itself before anything else.
  let roundCheckpoint: ResumeState["roundCheckpoint"] = null
  const resumeSameSid = resumeSameArg !== undefined
  if (effectiveResumeArg) {
    const failResume = (err: unknown): number => {
      const wrote = writeStreamFailure(failure, err)
      console.error(
        `  ${c.boldRed("error")} could not resume session ${effectiveResumeArg}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return endFailedRun(wrote, exit)
    }
    let target: string | null
    try {
      target = resolveSessionTarget(effectiveResumeArg, cwd)
    } catch (err) {
      return failResume(err)
    }
    if (!target) {
      const wrote = writeStreamFailure(
        failure,
        new Error("no saved sessions found to --resume last"),
      )
      console.error(`  ${c.boldRed("error")} no saved sessions found to --resume last`)
      return endFailedRun(wrote, exit)
    }
    resumeSid = target
    // A forked resume streams under a new id, so name the source.
    // An in-place resume keeps the same id, so it stays null.
    if (!resumeSameSid) {
      streamInfo = { ...streamInfo, resumedFrom: resumeSid }
      failure.info = streamInfo
    }
    let resumed: ResumeState
    try {
      resumed = loadResumeState(resumeSid, env)
    } catch (err) {
      return failResume(err)
    }
    ;({
      initialMessages,
      displayMessages,
      pendingDraft,
      toolStartTimes,
      userTimestamps,
      toolDisplays,
      roundCheckpoint,
    } = resumed)
    resumeCompactBoundaries = resumed.compactBoundaries
    printStartupRow("resume", resumed.banner)
    // Rehydrate ModeManager's lastAdvertisedModeId from the persisted
    // history so the first consume after resume does NOT re-emit a
    // redundant `from="default" to="<id>"` attachment for a mode the
    // model already saw in its conversation. The active mode in this
    // process is still set by the normal precedence (CLI > env >
    // config > plugin-default); only the "what the model knows"
    // bookkeeping is rehydrated here.
    if (modeManager) modeManager.primeLastAdvertised(lastAdvertisedModeFromHistory(initialMessages))
  }
  // Startup tools row matches advertisement (same pure SDK policy helper as
  // Agent / AgentCore request assembly — not ModeManager).
  const bannerTools = applyToolNamePolicy(loadedTools, opts.cliToolFilter)
  if (bannerTools.length > 0) {
    closeStartupTreeWithTools(bannerTools)
  } else {
    closeStartupTree()
  }

  // Flush any diagnostics that fired during the banner draw. The
  // scrollback sink was put into buffering mode right after construction
  // (above) precisely so a plugin-loader / auth / config warning
  // emitted mid-banner can't tear through the `╭ │ │ ╰` box mid-paint.
  // After this call any further `diag.warn(...)` lands directly in
  // scrollback via the sink's writer, which is what we want for the
  // interactive session.
  scrollbackSink?.flushBuffer()

  // Compute systemHash + toolsHash for the session-store meta record (and
  // for resume drift detection). These mirror what agent.run() would compute
  // internally — the meta record is written at session OPEN, before any run()
  // call. See `host/startup/startup-hashes.ts` for the recipe (it must track
  // the Agent class field defaults).
  const { systemHash, toolsHash } = await computeStartupHashes({
    loader: hasPlugins ? loader : null,
    modeManager,
    toolNamePolicy: opts.cliToolFilter,
    selectedModelBase,
    selectedProviderId,
    auth,
    cacheTtl,
    systemPromptOverrides: opts.systemPromptOverrides,
  })

  // Session store + blob store + resume warnings + attach/detach
  // lifecycle markers. Lives in `src/startup/session-store-boot.ts`;
  // see that module for the fork-on-resume + best-effort semantics.
  const sid = getSessionId()
  const { store, blobStore, fileTrackingStore } = await bootSessionStores({
    sid,
    resumeSid,
    resumeSameSid,
    selectedModel,
    providerId: selectedProviderId,
    ...(credentialName ? { credentialName } : {}),
    systemHash,
    toolsHash,
  })

  // `--host-mode <id>` (ACP Level 1's dispatch slot): hand the whole
  // process to a plugin's `hostModes[]` entry instead of the human
  // `--prompt`/REPL run below. Must sit HERE — after the session stores
  // are open, but before every stdout write that follows (the ready
  // banner, the resume header + replay, `InteractiveSession.create`'s
  // TUI-flavored agent). `isHostModeRun` below is the predicate the
  // banner/resume-header checks also AND in, so the two can never
  // disagree about what counts as "the REPL" (see resume-mode.ts).
  if (isHostModeRun(commandPlan.command)) {
    // Guaranteed by planCommand (the "host-mode" command only exists when
    // `--host-mode <id>` was parsed), but spelled out so the type stays
    // honest instead of an unsafe assertion.
    if (opts.hostModeId === undefined) {
      throw new Error("internal error: host-mode command with no --host-mode id")
    }
    // runHostMode sets process.exitCode and returns. It never exits while
    // protocol lines may still sit in the stdout queue.
    await runHostMode({
      hostModeId: opts.hostModeId,
      hostModeArgv: args.slice(args.indexOf("--host-mode") + 2),
      promptSource: extractPromptFromArgs(args),
      loader,
      sessionDeps: {
        auth,
        model: selectedModel,
        providerId: selectedProviderId,
        ...(credentialName ? { credentialName } : {}),
        effort,
        ...(speed ? { speed } : {}),
        serviceTier,
        thinkingDisplay,
        cacheTtl,
        loader,
        modeManager,
        toolNamePolicy: opts.cliToolFilter,
        saveEcho,
        turnAttachments: turnAttachmentSeam.producers,
        store,
        blobStore,
        fileTrackingStore,
        systemPromptOverrides: opts.systemPromptOverrides,
      },
      sessionId: sid,
      hostLifecycle,
    })
    return currentExitCode()
  }

  // Shared time-hint tracker. One instance threads through both
  // session-replay (for the historical tool headers when --resume hydrates
  // from JSONL) AND the live Agent (for new tool headers in this session).
  // The tracker carries day-state across calls so the date prefix only
  // re-emits on calendar rollover — including the rollover from the last
  // replayed tool to the first live tool.
  const toolTimeTracker = new ToolTimeTracker()

  // --output-schema FILE (Phase 4): read + parse the JSON Schema so the agent
  // can constrain its final structured answer. parseSchemaFile folds a
  // malformed-JSON / non-object file into a thrown error we surface cleanly
  // and exit 1 (a script passing a broken schema should fail loudly, not
  // silently run unconstrained).
  let outputSchema: object | undefined
  if (outputSchemaPath !== undefined) {
    try {
      const raw = readFileSync(outputSchemaPath, "utf8")
      outputSchema = parseSchemaFile(raw)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`--output-schema: ${msg}\n`)
      exit(1)
    }
  }

  // mdstream's syntax/theme dump costs ~20ms cold. Spawn its persistent raw-
  // code server during startup and overlap warmup with session construction so
  // the first Read/Edit/Write result never pays that cost in the paint path.
  const { createMdstreamCodeHighlighter } = await import(
    "./ui/formatter/mdstream-code-highlighter.ts"
  )
  const codeHighlighter = createMdstreamCodeHighlighter(formatterCmd)
  void codeHighlighter?.warmup()

  const resumeTarget = resumeTargetOf(store, resumeSid)
  // Tier-2 InteractiveSession over AgentCore — production conversation path
  // for both REPL and non-interactive human/`--prompt` (json/stream-json
  // still opens a dedicated Session via openEventStreamSession below).
  const agent = await InteractiveSession.create({
    auth,
    model: selectedModel,
    providerId: selectedProviderId,
    ...(credentialName ? { credentialName } : {}),
    effort,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(speed ? { speed } : {}),
    serviceTier,
    thinkingDisplay,
    cacheTtl,
    loader: hasPlugins ? loader : null,
    modeManager,
    toolNamePolicy: opts.cliToolFilter,
    saveEcho,
    turnAttachments: turnAttachmentSeam.producers,
    store,
    blobStore,
    fileTrackingStore,
    initialMessages,
    // S50: resume through core's `resumeSession` when the store is open.
    // Without a store, seed the history and the checkpoint directly.
    ...(resumeTarget ? { resumeFrom: resumeTarget } : {}),
    ...(roundCheckpoint ? { initialCheckpoint: roundCheckpoint } : {}),
    toolTimeTracker,
    codeHighlighter,
    systemPromptOverrides: opts.systemPromptOverrides,
  })
  void hostLifecycle.sessionStart?.({
    sid: getSessionId(),
    cwd: cwd,
    model: selectedModel,
  })
  // Host slash commands that need a live agent (not plugin-declared).
  // Must run after session construction so `/compact` and `/continue` appear in
  // listCommands / slash-menu and dispatch through CommandRegistry.
  if (hasPlugins) {
    registerCompactHostCommand(loader, agent)
    registerContinueHostCommand(loader, agent)
  }
  // Point the ModelInfo provider at the agent's live model from here on.
  getLiveModelId = () => agent.getModel()

  // Ready banner : emitted ONCE here so it lands in scrollback right
  // under the startup header, BEFORE any resume replay. Previously the
  // banner was emitted from inside `runRepl` / `runReplLiveArea`, which
  // on resume placed it BELOW the replayed content (visible jump:
  // header > replay > hint, instead of header > hint > replay).
  //
  // Skipped for non-interactive modes (`--prompt`, `-`, bare positional)
  // where there's no REPL prompt to introduce. `extractPromptFromArgs`
  // is pure (no stdin read) so calling it here is cheap; the later
  // `extractPrompt()` call still runs to drive the actual non-interactive
  // branch.
  const promptSource = extractPromptFromArgs(args)
  // `isHostModeRun` is defensive depth here, not load-bearing: the
  // `--host-mode` branch above already returns before this point. Kept so
  // the two predicates can never disagree if that early return ever moves
  // (see resume-mode.ts's isHostModeRun doc).
  const willEnterRepl = promptSource.kind === "none" && !isHostModeRun(commandPlan.command)
  if (willEnterRepl) {
    const stdoutCols = (process.stdout as { columns?: number }).columns ?? 80
    process.stdout.write(buildReadyBanner(modeManager, stdoutCols))
  }

  // Replay prior conversation to scrollback when resuming. We write
  // straight to stdout BEFORE the live-area compositor mounts, so the
  // history lands in normal terminal scrollback and the pinned editor
  // appears underneath it. For non-interactive (`--prompt`) mode we skip
  // the replay — the user just wants the next reply, not the history.
  //
  // `formatterCmd` is passed through so assistant text/thinking blocks
  // render through mdstream (or whatever formatter the user configured),
  // matching the live REPL's markdown rendering. Without this, replayed
  // markdown shows up as raw `**bold**` / `# heading` source text.
  //
  // We also enter this block when `pendingDraft` is set but the
  // conversation history is empty (a session that was aborted before any
  // assistant turn ever completed). In that case there's nothing to
  // replay but we still want the resume header + draft hint to paint, so
  // the user sees a coherent "you're resuming session X, here's your
  // unsent prompt" story instead of an unexplained populated editor.
  // Decide from the parsed prompt source, the same value that picks the
  // REPL path. Any prompt form (`-p`, `--prompt=x`, positional, `-`) skips
  // the header and replay, so a stream-json stdout stays all JSON.
  const isInteractiveResume =
    isInteractiveResumeRun(resumeSid, promptSource) && !isHostModeRun(commandPlan.command)
  // Replay the FULL display history (not the compact-aware model path)
  // so the user still sees pre-compact turns in scrollback.
  const resumeReplayMessages = displayMessages.length > 0 ? displayMessages : initialMessages
  const shouldEmitResumeBlock =
    isInteractiveResume && (resumeReplayMessages.length > 0 || pendingDraft !== null)
  if (shouldEmitResumeBlock) {
    const stdoutSink = { write: (s: string) => process.stdout.write(s) }
    stdoutSink.write(
      buildResumeHeader({
        sid: resumeSid as string,
        turns: resumeReplayMessages.length,
        model: selectedModel,
      }),
    )
    if (resumeReplayMessages.length > 0) {
      // Tool presentation map (icon + color) for replay: the CLI's static
      // map (S41). Core tool definitions carry no cosmetic fields (S29).
      const toolPresentation = toolPresentationMap()
      await replayToScrollback(resumeReplayMessages, stdoutSink, {
        modeManager,
        formatterCmd,
        codeHighlighter,
        toolTimeTracker,
        toolStartTimes,
        userTimestamps: userTimestamps ?? undefined,
        toolDisplays,
        toolPresentation,
        scrollbackSubmittedAt: userConfig.scrollback?.submittedAt,
        compactBoundaries: resumeCompactBoundaries,
      })
      stdoutSink.write("\n")
    }
    if (pendingDraft !== null) {
      // One-line dim hint directly above where the live editor will
      // mount. The draft text itself is NOT painted here, the editor's
      // own prefilled buffer is the visual proof. Keeping this compact
      // avoids a heavy strikethrough echo for multi-KB drafts (the
      // motivating session in #0ef10a76 had a 4222-char draft).
      stdoutSink.write(
        `  ${c.dim("──")} ${c.dim("unsent draft restored to input · press Enter to send, or edit")} ${c.dim("──")}\n\n`,
      )
    }
  }

  // Non-interactive mode: send prompt, print response, exit. The output
  // routing (formatter, --json / human / --output-schema, plugin stream,
  // schema gate) lives in `host/startup/run-non-interactive.ts`.
  const prompt = await extractPrompt()
  if (prompt) {
    try {
      await runNonInteractivePrompt({
        agent,
        prompt,
        formatterCmd,
        showHeader: SHOW_HEADER,
        wantJsonOutput,
        outputFormat,
        diagnostics: opts.wantDiagnostics,
        outputSchema,
        loader: hasPlugins ? loader : null,
        cwd: cwd,
        // Values for the stream-json session_started first line.
        streamInfo,
        continueTurn: roundCheckpoint !== null,
        // Structured event-stream route for `--output-format json` / `stream-json`:
        // open a fully-wired Session (Tier-1 adapters, over createRuntime) whose
        // own complete event log run-non-interactive filters at its own
        // subscription boundary: LEGACY_EVENT_KINDS for json,
        // STREAM_JSON_EVENT_KINDS (adds run_finished) for stream-json. `text` /
        // `--output-schema` never call this (see wantsEventStream), so those
        // paths stay byte-identical.
        openEventStreamSession: () =>
          openAgentCoreSession(
            // S23/S28: status rows and plugin-bus telemetry, like the REPL.
            withHostPorts({
              // Same sid the store was opened with, so the stream carries the CLI id.
              sessionId: sid,
              auth,
              model: selectedModel,
              providerId: selectedProviderId,
              ...(credentialName ? { credentialName } : {}),
              effort,
              serviceTier,
              thinkingDisplay,
              cacheTtl,
              initialMessages,
              ...(roundCheckpoint ? { initialCheckpoint: roundCheckpoint } : {}),
              loader: hasPlugins ? loader : null,
              modeManager,
              toolNamePolicy: opts.cliToolFilter,
              store,
              blobStore,
              fileTrackingStore,
              saveEcho,
              turnAttachments: turnAttachmentSeam.producers,
              codeHighlighter,
              systemPromptOverrides: opts.systemPromptOverrides,
            }),
          ),
      })
    } finally {
      void hostLifecycle.sessionEnd?.({
        sid: getSessionId(),
        cwd: cwd,
        model: agent.getModel(),
      })
      await codeHighlighter?.close()
      setBashCwdChangeListener(null)
    }
    // The event-stream route sets process.exitCode (for example 1 for a
    // paused run) and returns. Keep that code.
    return currentExitCode()
  }

  // Interactive REPL mode.
  //
  // Live-area path: when stdout is a TTY and the user hasn't opted out, we
  // mount a {@link Compositor} so the multiline prompt stays pinned to the
  // bottom of the screen while streamed output and tool transcripts scroll
  // above. Disabled when not a TTY, when MINIMAL_AGENT_NO_LIVE_AREA=1, or
  // when TERM=dumb (which doesn't reliably honor DECSTBM).
  const noLiveArea =
    env.MINIMAL_AGENT_NO_LIVE_AREA === "1" || env.TERM === "dumb" || process.stdout.isTTY !== true

  // Resolve --spinner / MINIMAL_AGENT_SPINNER → instantiated spinner.
  // Unknown names log a warning and fall back to the default preset so a
  // typo never breaks the REPL.
  const spinner = resolveSpinnerPreset(spinnerName, (line) => console.error(line))

  try {
    // S50: no human is assumed. An unfinished resumed turn continues by
    // itself before the prompt mounts.
    if (roundCheckpoint !== null) {
      await continueResumedTurn({ agent, formatterCmd, loader: hasPlugins ? loader : null, cwd })
    }
    if (noLiveArea) {
      await runRepl(agent, { formatterCmd, auth, spinner })
    } else {
      // Full interactive TTY stack (capability probes, compositor,
      // interceptor, editor, resize fan-out, Auto-ASK) lives in
      // `src/startup/live-repl.ts`. `runRepl` is passed in as a value to
      // keep that module import-cycle-free with `host/repl.ts`.
      const { runLiveAreaRepl } = await import("./startup/live-repl.ts")
      await runLiveAreaRepl({
        agent,
        repl: runRepl,
        formatterCmd,
        auth,
        spinner,
        args,
        userConfig,
        modeManager,
        hasPlugins,
        loader,
        liveAreaSlots: pluginUi.liveAreaSlots,
        pendingDraft,
      })
    }
  } finally {
    void hostLifecycle.sessionEnd?.({
      sid: getSessionId(),
      cwd: cwd,
      model: agent.getModel(),
    })
    await codeHighlighter?.close()
    setBashCwdChangeListener(null)
  }

  // The REPL leaves stdin and the terminal handles open. End the process now.
  exit(0)
  return 0
}
