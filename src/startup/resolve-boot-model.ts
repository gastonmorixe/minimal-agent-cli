/**
 * Resolve the boot selection for an interactive REPL.
 *
 * When a model is explicitly configured, a provider must be configured too.
 * When neither is configured, the caller must decide whether a provider can be
 * inferred safely from stored credentials. This module does not pick a global
 * registry default.
 *
 * @module startup/resolve-boot-model
 */

export interface ResolveBootModelInput {
  cliModel?: string
  cliProvider?: string
  envModel?: string
  envProvider?: string
  configModel?: string
  configProvider?: string
}

export type BootSelectionSource = "cli" | "env" | "config" | "stored-provider"

export interface ResolvedBootModelSelection {
  kind: "explicit"
  model: string
  modelSource: BootSelectionSource
  provider: string
  providerSource: BootSelectionSource
}

export type InvalidBootModelSelection = { kind: "invalid"; reason: string } & (
  | { issue: "missing-provider" | "missing-model" | "no-suggested-model"; id: string }
  | { issue: "no-credentials" | "no-usable-credentials" | "multiple-providers" }
)

export type ResolveBootModelResult =
  | ResolvedBootModelSelection
  | { kind: "unconfigured" }
  | InvalidBootModelSelection

function firstString(
  cli?: string,
  env?: string,
  config?: string,
): { value: string; source: Exclude<BootSelectionSource, "stored-provider"> } | undefined {
  const cliValue = cli?.trim()
  if (cliValue) return { value: cliValue, source: "cli" }
  const envValue = env?.trim()
  if (envValue) return { value: envValue, source: "env" }
  const configValue = config?.trim()
  if (configValue) return { value: configValue, source: "config" }
  return undefined
}

/** Resolve the boot selection, or signal that the explicit pair is incomplete. */
export function resolveBootModel(input: ResolveBootModelInput): ResolveBootModelResult {
  const model = firstString(input.cliModel, input.envModel, input.configModel)
  const provider = firstString(input.cliProvider, input.envProvider, input.configProvider)

  if (model === undefined && provider === undefined) return { kind: "unconfigured" }
  if (model && provider) {
    return {
      kind: "explicit",
      model: model.value,
      modelSource: model.source,
      provider: provider.value,
      providerSource: provider.source,
    }
  }

  if (model) {
    return {
      kind: "invalid",
      issue: "missing-provider",
      id: model.value,
      reason: `model "${model.value}" requires an explicit provider; pass --provider <id> too`,
    }
  }
  const id = provider!.value
  return {
    kind: "invalid",
    issue: "missing-model",
    id,
    reason: `provider "${id}" requires an explicit model; pass --model <id> too`,
  }
}

export interface StoredProviderBootCandidate {
  providerId: string
  credentialInfo?: {
    usable: boolean
  }
}

/** Resolve the only allowed implicit boot selection: one usable stored provider. */
export function resolveSingleStoredProviderBootModel(
  candidates: readonly StoredProviderBootCandidate[],
  suggestModel: (providerId: string) => string | undefined,
): ResolvedBootModelSelection | InvalidBootModelSelection {
  const usable = candidates.filter((p) => p.credentialInfo?.usable !== false)
  if (usable.length !== 1) {
    const issue =
      candidates.length === 0
        ? "no-credentials"
        : usable.length === 0
          ? "no-usable-credentials"
          : "multiple-providers"
    const reason = {
      "no-credentials": "no provider credentials found",
      "no-usable-credentials": "no usable provider credentials found",
      "multiple-providers": "multiple provider credentials found",
    }[issue]
    return {
      kind: "invalid",
      issue,
      reason:
        `${reason}; set both model and provider in config, or pass ` +
        `--provider <id> --model <id>`,
    }
  }

  const provider = usable[0]!.providerId
  const model = suggestModel(provider)
  if (!model) {
    return {
      kind: "invalid",
      issue: "no-suggested-model",
      id: provider,
      reason:
        `provider "${provider}" has credentials but no suggested model; ` +
        `pass --provider ${provider} --model <id>`,
    }
  }

  return {
    kind: "explicit",
    model,
    modelSource: "stored-provider",
    provider,
    providerSource: "stored-provider",
  }
}
