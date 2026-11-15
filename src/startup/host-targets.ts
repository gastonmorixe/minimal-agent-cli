/**
 * Provider + credential switching for host mode (`HostRuntime.listTargets`,
 * `getTarget`, `setTarget`). Split out of `run-host-mode.ts` so that file
 * stays a thin runtime builder.
 *
 * Discovery and auth resolution are injectable, so tests never read the
 * real auth store.
 *
 * @module host/startup/host-targets
 */

import type { AuthResult } from "@minimal-agent/core/host/auth"
import {
  type CredentialedProvider,
  discoverCredentialedProviders,
} from "@minimal-agent/core/host/auth-strategies"
import { findModelForProvider, listRegisteredModels } from "@minimal-agent/core/host/model-registry"
import { resolveStartupAuth } from "@minimal-agent/core/host/provider-auth"
import { findProviderPlugin } from "@minimal-agent/core/host/provider-plugin"
import type { HostTargetSelection, HostTargetView } from "@minimal-agent/core/host-kit/host-mode"
import type { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import { normalizeModelForAPI } from "@minimal-agent/core/sdk/transport-types"

/** The stored credentials this host can switch to (`discoverCredentialedProviders`). */
export type DiscoverTargets = () => readonly CredentialedProvider[]

/** Resolves the auth for one provider + credential + model (`resolveStartupAuth`). */
export type ResolveTargetAuth = (
  providerId: string,
  modelId: string,
  credentialName?: string,
) => Promise<AuthResult>

/** Default discovery: every stored credential that decodes to usable auth. */
export function defaultDiscoverTargets(): readonly CredentialedProvider[] {
  return discoverCredentialedProviders().filter((e) => e.credentialInfo?.usable !== false)
}

/** Default auth resolution: the same `resolveStartupAuth` the CLI boot uses. */
export const defaultResolveTargetAuth: ResolveTargetAuth = (providerId, modelId, credentialName) =>
  resolveStartupAuth(providerId, modelId, credentialName)

/** The `credentialNames` port `AgentCore.switchTarget` checks an explicit name with. */
export function credentialNamesFrom(
  discover: DiscoverTargets,
): (providerId: string) => readonly string[] {
  return (providerId) =>
    discover()
      .filter((e) => e.providerId === providerId && e.credentialName !== undefined)
      .map((e) => e.credentialName as string)
}

/** Human label: the provider display name, then the credential name when there is one. */
function targetLabel(providerId: string, credentialName?: string, displayName?: string): string {
  const provider = displayName ?? findProviderPlugin(providerId)?.displayName ?? providerId
  return credentialName ? `${provider} · ${credentialName}` : provider
}

/**
 * One row per provider + credential pair. The live target is always in the
 * list (first, when discovery does not report it), like the current-model
 * rule of `listModels`.
 */
export function listHostTargets(
  discover: DiscoverTargets,
  current: { providerId?: string; credentialName?: string },
): HostTargetView[] {
  const rows: HostTargetView[] = []
  const seen = new Set<string>()
  const key = (p: string, c?: string): string => `${p}\u0000${c ?? ""}`
  for (const e of discover()) {
    const k = key(e.providerId, e.credentialName)
    if (seen.has(k)) continue
    seen.add(k)
    rows.push({
      providerId: e.providerId,
      ...(e.credentialName !== undefined ? { credentialName: e.credentialName } : {}),
      label: targetLabel(e.providerId, e.credentialName, e.displayName),
    })
  }
  if (current.providerId !== undefined) {
    // Exact match: a boot on the default credential (no name) is its own row,
    // so the live value is always one of the listed values.
    const has = rows.some(
      (r) => r.providerId === current.providerId && r.credentialName === current.credentialName,
    )
    if (!has) {
      rows.unshift({
        providerId: current.providerId,
        ...(current.credentialName !== undefined ? { credentialName: current.credentialName } : {}),
        label: targetLabel(current.providerId, current.credentialName),
      })
    }
  }
  return rows
}

/**
 * Checked provider + credential switch on the live core. Order: pick the
 * model (keep the current one when the new provider registers it, else the
 * provider default), resolve the auth for that model, then one atomic
 * `switchTarget`. A throw at any step leaves the core unchanged.
 */
export async function setHostTarget(
  core: AgentCore,
  target: HostTargetSelection,
  resolveAuth: ResolveTargetAuth,
): Promise<void> {
  const current = core.getModel()
  const keep = findModelForProvider(normalizeModelForAPI(current), target.providerId) !== undefined
  const model = keep
    ? current
    : listRegisteredModels().find((m) => m.providerId === target.providerId)?.id
  if (model === undefined) {
    throw new Error(`setTarget: provider "${target.providerId}" has no registered model`)
  }
  const auth = await resolveAuth(
    target.providerId,
    normalizeModelForAPI(model),
    target.credentialName,
  )
  core.switchTarget({
    providerId: target.providerId,
    ...(target.credentialName !== undefined ? { credentialName: target.credentialName } : {}),
    auth,
    ...(keep ? { model } : { useProviderDefault: true }),
  })
}
