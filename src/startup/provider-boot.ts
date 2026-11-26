/**
 * Startup provider/model/auth bootstrapping.
 *
 * This keeps the selected provider resolution and provider-specific warm-up
 * hooks out of `src/index.ts` while preserving the entrypoint ordering: provider
 * discovery must already have run before this module is called.
 *
 * @module host/startup/provider-boot
 */

import { CoreError, NoProviderCredentialsError } from "@minimal-agent/core/errors"
import type { AuthResult } from "@minimal-agent/core/host/auth"
import {
  discoverCredentialedProviders,
  listStoredProviderFacts,
  resolveCredentialRef,
  suggestModelForProvider,
} from "@minimal-agent/core/host/auth-strategies"
import type { UserConfig } from "@minimal-agent/core/host/config"
import { Facility, getDiagnosticBus, Severity } from "@minimal-agent/core/host/diagnostics"
import { findModelForProvider, listRegisteredModels } from "@minimal-agent/core/host/model-registry"
import { resolveStartupAuth } from "@minimal-agent/core/host/provider-auth"
import {
  canonicalProviderId,
  findProviderPlugin,
  listProviderPlugins,
} from "@minimal-agent/core/host/provider-plugin"
import { primeProviderSessionInfo } from "@minimal-agent/core/host/provider-session"
import type { CliOptions } from "../cli/parse-argv.ts"
import { errorText } from "./core-text.ts"
import { credentialError, selectionError, unknownTargetError } from "./provider-startup-error.ts"
import { resolveBootModel, resolveSingleStoredProviderBootModel } from "./resolve-boot-model.ts"
import { resolveCredentialName } from "./resolve-credential-name.ts"

/**
 * Map a typed credential ref (stored name, email, account id) to the stored
 * name. The session pins the stored name, so resume survives an email change.
 * An unknown ref passes through, and auth resolution reports it as missing.
 */
function resolveTypedCredential(providerId: string, ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined
  const found = resolveCredentialRef(providerId, ref)
  if (found.kind === "ambiguous") {
    throw new Error(
      `credential "${ref}" matches ${found.names.length} credentials for provider ` +
        `"${providerId}": ${found.names.join(", ")}. Pass one of these names.`,
    )
  }
  return found.kind === "none" ? ref : found.name
}

/** Resolved provider startup state needed by later boot phases. */
export interface StartupProviderState {
  readonly selectedModel: string
  readonly selectedModelBase: string
  readonly selectedProviderId: string
  readonly credentialName: string | undefined
  readonly auth: AuthResult
}

/** Inputs for {@link resolveStartupProviderState}. */
export interface ResolveStartupProviderStateInput {
  readonly opts: Partial<
    Pick<
      CliOptions,
      | "model"
      | "provider"
      | "endpoint"
      | "format"
      | "authType"
      | "apiKey"
      | "authHeader"
      | "providerModel"
      | "effortLevels"
      | "cliCredentialName"
    >
  >
  readonly userConfig: Pick<UserConfig, "model" | "provider" | "credentialName">
  readonly env: Record<string, string | undefined>
  /**
   * `meta.credentialName` from the session being resumed, when known.
   * Used only when CLI and config omit a pin, and only when the session
   * provider matches the effective selected provider (or meta.provider is
   * absent on legacy sessions).
   */
  readonly resumeCredentialName?: string
  /** `meta.provider` from the session being resumed, when known. */
  readonly resumeProviderId?: string
}

/** Resolve model, provider, ad-hoc model registration, and startup auth. */
export async function resolveStartupProviderState(
  input: ResolveStartupProviderStateInput,
): Promise<StartupProviderState> {
  const bootModel = resolveBootModel({
    cliModel: input.opts.model,
    cliProvider: input.opts.provider,
    envModel: input.env.MINIMAL_AGENT_MODEL,
    envProvider: input.env.MINIMAL_AGENT_PROVIDER,
    configModel: input.userConfig.model,
    configProvider: input.userConfig.provider,
  })

  if (bootModel.kind === "invalid") {
    throw selectionError(bootModel)
  }

  const selected =
    bootModel.kind === "explicit"
      ? bootModel
      : resolveSingleStoredProviderBootModel(
          discoverCredentialedProviders(),
          suggestModelForProvider,
        )
  if (selected.kind === "invalid") {
    throw selectionError(selected, listStoredProviderFacts())
  }

  const selectedModel = selected.model
  const selectedModelBase = selectedModel.replace(/\[(1|2)m\]/gi, "")
  // Former ids (`ProviderPlugin.formerIds`) normalize here, so every later
  // phase (auth, session meta, usage) sees the canonical provider id.
  const selectedProviderId = canonicalProviderId(selected.provider)
  publishGenericEndpointEnv(input.opts)
  const plugin = findProviderPlugin(selectedProviderId)
  if (!plugin) {
    throw unknownTargetError(
      selectedProviderId,
      listProviderPlugins().map((p) => p.id),
    )
  }
  if (!findModelForProvider(selectedModelBase, selectedProviderId)) {
    plugin.registerAdHocModel?.(selectedModelBase)
  }
  if (!findModelForProvider(selectedModelBase, selectedProviderId)) {
    const models = listRegisteredModels().filter((model) => model.providerId === selectedProviderId)
    throw unknownTargetError(
      selectedModelBase,
      models.map((model) => model.id),
      selectedProviderId,
      selectedModel.match(/\[(1|2)m\]$/i)?.[0],
    )
  }

  const cred = resolveCredentialName({
    cliCredentialName: input.opts.cliCredentialName,
    configCredentialName: input.userConfig.credentialName,
    resumeCredentialName: input.resumeCredentialName,
    resumeProviderId: input.resumeProviderId,
    selectedProviderId,
  })
  // Do NOT write to stderr here — that tears the startup tree mid-paint.
  // Emit on the diagnostic bus; ScrollbackDiagnosticSink buffers during
  // the banner and flushes a proper ⚠ warn block after closeStartupTree().
  if (cred.resumePinSkipped) {
    const skip = cred.resumePinSkipped
    // `diag` (the terse `diag.warn(...)` sugar) is deliberately not part of
    // the `./host/diagnostics` public surface (see that barrel's own doc
    // comment) — boot-time emitters like this one go straight through
    // `getDiagnosticBus().emit(...)` instead.
    getDiagnosticBus().emit({
      ts: Date.now(),
      severity: Severity.Warning,
      facility: Facility.User,
      source: "auth.resume-pin",
      message: `pin "${skip.pin}" skipped (session was ${skip.sessionProvider}; using ${skip.selectedProvider} default)`,
      structuredData: {
        pin: skip.pin,
        "session-provider": skip.sessionProvider,
        "selected-provider": skip.selectedProvider,
      },
    })
  }
  const credentialName = resolveTypedCredential(selectedProviderId, cred.credentialName)
  let auth: AuthResult
  try {
    auth = await resolveStartupAuth(selectedProviderId, selectedModelBase, credentialName, {
      endpoint: input.opts.endpoint,
      format: input.opts.format,
      authType: input.opts.authType,
      apiKey: input.opts.apiKey,
      authHeader: input.opts.authHeader,
    })
  } catch (err) {
    if (err instanceof NoProviderCredentialsError) {
      throw credentialError(
        err,
        errorText(err),
        selectedProviderId,
        selectedModelBase,
        cred.credentialName,
        err.credentialedProviders.some((p) => p.providerId === selectedProviderId),
      )
    }
    if (err instanceof CoreError) throw new Error(errorText(err), { cause: err })
    throw err
  }

  return {
    selectedModel,
    selectedModelBase,
    selectedProviderId,
    credentialName,
    auth,
  }
}

function publishGenericEndpointEnv(opts: ResolveStartupProviderStateInput["opts"]): void {
  if (opts.endpoint) process.env.MINIMAL_AGENT_ENDPOINT = opts.endpoint
  if (opts.format) process.env.MINIMAL_AGENT_FORMAT = opts.format
  if (opts.authType) process.env.MINIMAL_AGENT_AUTH_TYPE = opts.authType
  if (opts.apiKey) process.env.MINIMAL_AGENT_API_KEY = opts.apiKey
  if (opts.authHeader) process.env.MINIMAL_AGENT_AUTH_HEADER = opts.authHeader
  if (opts.providerModel) process.env.MINIMAL_AGENT_PROVIDER_MODEL = opts.providerModel
  if (opts.effortLevels && opts.effortLevels.length > 0) {
    process.env.MINIMAL_AGENT_EFFORT_LEVELS = opts.effortLevels.join(",")
  }
}

/** Start provider-specific best-effort warm-ups for the selected provider. */
export function startProviderWarmups(state: StartupProviderState): void {
  void (async () => {
    const { authResultToProviderAuth } = await import("@minimal-agent/core/host/auth")
    const probeCtx = {
      auth: authResultToProviderAuth(state.auth),
      modelId: state.selectedModelBase,
    }
    for (const plugin of listProviderPlugins()) {
      if (plugin.id !== state.selectedProviderId) continue
      plugin.onStartupProbe?.(probeCtx)
    }
  })().catch(() => {
    // Tolerated: startup probes can only improve registry metadata.
  })

  void primeProviderSessionInfo(state.selectedModelBase).catch(() => {
    // Tolerated: quota/status slots populate from real chat traffic later.
  })
}
