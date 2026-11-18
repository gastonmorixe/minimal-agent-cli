/**
 * The target of a resumed session. When the user switched the target during
 * a session (`/provider`, `/model`, `/effort`, or a host-mode client), the
 * session log has a `target_switch` record. A resume starts on the newest
 * one, so the session continues on the credential, provider and model it
 * last used, with the history that this target left (the model fold dropped
 * the older thinking).
 *
 * Precedence, highest first: the `--provider`, `--model` and
 * `--credential-name` flags, then the newest `target_switch` record, then
 * the env, then the config. With ANY of the three flags, the record is not
 * used at all: the user chose a target for this run.
 *
 * A record is data from a file, so it is checked before use. The provider
 * must be installed, the model must be one of its models, a named
 * credential must be stored for it, and the effort of this run must be a
 * level of the model. A provider whose auth is not in the store (the generic
 * endpoint) is used only when this run configures an endpoint and a format:
 * the record never gives them. If not, the session starts on the usual
 * target and the user gets one notice. A record never makes a resume fail.
 *
 * The effort of the record is not restored: it comes from the flag, the env
 * or the config of the new process, as before.
 *
 * Both resume flags use the record: `--resume <sid|last>` and
 * `--resume-same-sid <sid>` (the host passes `effectiveResumeArg`). The
 * `/continue` command does not start a new process, so it has no part here.
 *
 * @module host/startup/resume-target
 */

import type { CredentialedProvider } from "@minimal-agent/core/host/auth-strategies"
import { Facility, getDiagnosticBus, Severity } from "@minimal-agent/core/host/diagnostics"
import { findModelForProvider } from "@minimal-agent/core/host/model-registry"
import { findProviderPlugin } from "@minimal-agent/core/host/provider-plugin"
import { resolveSessionTarget } from "@minimal-agent/core/host/session-index"
import { lastTargetSwitch, loadSession } from "@minimal-agent/core/host/session-restore"
import { normalizeModelForAPI } from "@minimal-agent/core/sdk/transport-types"

import { defaultDiscoverTargets } from "./host-targets.ts"

/** The newest `target_switch` record of a session, as far as this module reads it. */
export interface SavedTarget {
  providerId?: string
  credentialName?: string
  model: string
}

/** The three target flags of this run. */
export interface TargetFlags {
  model?: string | undefined
  provider?: string | undefined
  cliCredentialName?: string | undefined
}

/**
 * The options of this run that {@link resumeTargetFlags} reads: the target
 * flags, and the generic endpoint of the run (flag, env or config).
 */
export interface ResumeRunOptions extends TargetFlags {
  endpoint?: string | undefined
  format?: string | undefined
}

/** What {@link resumeTargetFlags} needs. Injectable, so tests read no session and no auth store. */
export interface ResumeTargetDeps {
  /** The newest `target_switch` record of the session to resume, or `null`. */
  savedTarget(resumeArg: string): SavedTarget | null
  /** The stored credentials. */
  discover(): readonly CredentialedProvider[]
  /** Effort levels of a model of a provider, or `undefined` when the provider does not have the model. */
  effortLevels(providerId: string, model: string): readonly string[] | undefined
  /**
   * True when a provider needs a stored credential to boot. False for a
   * provider whose auth comes from flags or env (the generic endpoint).
   */
  needsStoredCredential(providerId: string): boolean
  /** One notice for the user. */
  notice(message: string): void
}

/** Read the newest `target_switch` record of a `--resume` target. Never throws. */
export function readSavedTarget(
  resumeArg: string,
  cwd: string = process.cwd(),
): SavedTarget | null {
  try {
    const sid = resolveSessionTarget(resumeArg, cwd)
    if (!sid) return null
    const record = lastTargetSwitch(loadSession(sid).records)
    if (!record || typeof record.model !== "string" || record.model.length === 0) return null
    return {
      model: record.model,
      ...(typeof record.providerId === "string" ? { providerId: record.providerId } : {}),
      ...(typeof record.credentialName === "string"
        ? { credentialName: record.credentialName }
        : {}),
    }
  } catch {
    return null
  }
}

const DEFAULT_DEPS: ResumeTargetDeps = {
  savedTarget: (resumeArg) => readSavedTarget(resumeArg),
  discover: defaultDiscoverTargets,
  effortLevels: (providerId, model) =>
    findModelForProvider(normalizeModelForAPI(model), providerId)?.capabilities.effort.levels,
  needsStoredCredential: (providerId) => {
    const plugin = findProviderPlugin(providerId)
    return plugin?.oauthLogin !== undefined || plugin?.apiKeyAuth !== undefined
  },
  // The diagnostic bus, not stderr: a write here would tear the startup tree.
  notice: (message) =>
    getDiagnosticBus().emit({
      ts: Date.now(),
      severity: Severity.Warning,
      facility: Facility.User,
      source: "resume.target",
      message,
    }),
}

/** Why a saved target cannot be used, or `null` when it can. */
function problemWith(
  saved: SavedTarget,
  run: ResumeRunOptions,
  effort: string | undefined,
  deps: ResumeTargetDeps,
): string | null {
  if (!saved.providerId) return "it has no provider"
  const levels = deps.effortLevels(saved.providerId, saved.model)
  if (levels === undefined) {
    return `provider "${saved.providerId}" is not installed or does not have model "${saved.model}"`
  }
  const ofProvider = deps.discover().filter((e) => e.providerId === saved.providerId)
  if (saved.credentialName !== undefined) {
    if (!ofProvider.some((e) => e.credentialName === saved.credentialName)) {
      return `credential "${saved.credentialName}" is not stored for provider "${saved.providerId}"`
    }
  } else if (!deps.needsStoredCredential(saved.providerId)) {
    // Auth from flags or env (the generic endpoint). The record has no endpoint: this run must.
    if (!run.endpoint || !run.format) {
      return `this run configures no endpoint and format for provider "${saved.providerId}"`
    }
  } else if (ofProvider.length === 0) {
    // No name: the provider default. With no stored credential at all, the boot would fail on auth.
    return `provider "${saved.providerId}" has no stored credential`
  }
  if (effort !== undefined && effort !== "" && levels.length > 0 && !levels.includes(effort)) {
    return `model "${saved.model}" does not have effort "${effort}"`
  }
  return null
}

/**
 * {@link problemWith}, with a throw of a check as a problem. The checks read
 * the auth store and the provider registry. A store that cannot be read must
 * not stop the resume: the record is then not used.
 */
function checked(
  saved: SavedTarget,
  run: ResumeRunOptions,
  effort: string | undefined,
  deps: ResumeTargetDeps,
): string | null {
  try {
    return problemWith(saved, run, effort, deps)
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    return `it could not be checked: ${cause}`
  }
}

/**
 * The target flags for the provider boot of this run. Without a resume, with
 * any target flag, or with no usable saved target: `{}` (the flags as they
 * are). Else the saved target, in the place of the flags.
 *
 * Spread the result over the boot options AFTER the real flags.
 */
export function resumeTargetFlags(
  resumeArg: string | undefined,
  flags: ResumeRunOptions,
  effort: string | undefined,
  deps: ResumeTargetDeps = DEFAULT_DEPS,
): TargetFlags {
  if (!resumeArg) return {}
  if (flags.model || flags.provider || flags.cliCredentialName) return {}
  const saved = deps.savedTarget(resumeArg)
  if (!saved) return {}
  const problem = checked(saved, flags, effort, deps)
  if (problem) {
    deps.notice(
      `resume: the target that this session last used is not available (${problem}). ` +
        `The session starts on the usual target.`,
    )
    return {}
  }
  return {
    model: saved.model,
    provider: saved.providerId,
    ...(saved.credentialName !== undefined ? { cliCredentialName: saved.credentialName } : {}),
  }
}
