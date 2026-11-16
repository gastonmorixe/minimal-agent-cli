/**
 * CLI text for typed core errors. Core throws facts and holds no text. This
 * module owns the wording the CLI shows for the auth flag errors.
 *
 * @module startup/core-text
 */

import {
  type CoreError,
  type CoreErrorJson,
  createErrorRendererRegistry,
  type ErrorRenderer,
  type ErrorRendererRegistry,
  HOST_OWNER_ID,
  type StoredProviderFact,
} from "@minimal-agent/core/errors"
import type { CompactArgsError, CompactFailure } from "@minimal-agent/core/host/compact-contract"
import type { ContextExceededNotice } from "@minimal-agent/core/host/context-exceeded-recovery"
import type { ContextExceededAdvice } from "@minimal-agent/core/host/model-error"
import type { LoginEvent, LoginFailureCode } from "@minimal-agent/core/host/oauth-login"
import type { StartupAuthDescription } from "@minimal-agent/core/host/provider-auth"

/** Hint for a store with no credentials. */
const NO_CREDENTIALS_HINT =
  "No provider credentials found. Run `minimal-agent provider <id> login` " +
  "(e.g. `minimal-agent provider example-provider login`)."

/** Human hint listing credentialed providers and example model ids. */
export function storedProvidersHintText(providers: readonly StoredProviderFact[]): string {
  if (providers.length === 0) return NO_CREDENTIALS_HINT
  const lines = providers.map((p) => {
    const exampleText =
      p.exampleModels.length > 0
        ? ` — e.g. ${p.exampleModels.map((id) => `"${id}"`).join(", ")}`
        : ""
    return `${p.providerId} (${p.labels.join(", ")})${exampleText}`
  })
  return (
    `Logged in: ${lines.join("; ")}. ` +
    `Set "model" and "provider" in ~/.minimal-agent/config.jsonc or pass --provider <id> --model <id>.`
  )
}

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v)
}

function facts(v: unknown): StoredProviderFact[] {
  return Array.isArray(v) ? (v as StoredProviderFact[]) : []
}

/** Text of one auth error, or `undefined` for another kind. */
export function renderCoreError(err: CoreErrorJson): string | undefined {
  const f = err.fields
  switch (err.kind) {
    case "NoProviderSelectedError":
      return `no provider selected for model "${str(f.modelId)}". ${storedProvidersHintText(facts(f.credentialedProviders))}`
    case "NoProviderCredentialsError":
      return (
        `no credentials for provider "${str(f.providerId)}" (model "${str(f.modelId)}"). ` +
        `Run minimal-agent provider ${str(f.providerId)} login. ${storedProvidersHintText(facts(f.credentialedProviders))}`
      )
    case "GenericEndpointAuthError":
      return f.authType === "custom-header"
        ? `generic-endpoint auth-type custom-header requires --${str(f.missing)}`
        : `generic-endpoint auth-type ${str(f.authType)} requires --${str(f.missing)}`
    case "UnhandledAuthTypeError":
      return `unhandled generic-endpoint auth-type: ${str(f.authType)}`
    case "SignInTimeoutError":
      return "Sign-in timed out. Run login again."
    case "InvalidAuthorizationCodeError":
      return "Authentication failed: invalid authorization code"
    case "TokenExchangeError":
      return `Token exchange failed (${str(f.status)}): ${str(f.body)}`
    case "NoOAuthLoginProviderError":
      return "No OAuth login provider is registered."
    default:
      return undefined
  }
}

const AUTH_KINDS = [
  "SignInTimeoutError",
  "InvalidAuthorizationCodeError",
  "TokenExchangeError",
  "NoOAuthLoginProviderError",
  "NoProviderSelectedError",
  "NoProviderCredentialsError",
  "GenericEndpointAuthError",
  "UnhandledAuthTypeError",
] as const

/** The host renderer for the auth kinds. */
export const coreAuthErrorRenderer: ErrorRenderer = {
  kinds: AUTH_KINDS,
  render: (err) => renderCoreError(err),
}

function idList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

/**
 * CLI text of a `ContractCheckFailedError`: the boot refused to start. Names
 * every missing and duplicated contract. The CLI owns this text because
 * `ma-host-text-plugin` can be the missing plugin (R-BOOT-2).
 */
export function contractCheckFailedText(err: CoreErrorJson): string {
  const missing = idList(err.fields.missing)
  const duplicates = idList(err.fields.duplicates)
  const parts = ["required plugin contracts are not met"]
  if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`)
  if (duplicates.length > 0) parts.push(`duplicated in one plugin tier: ${duplicates.join(", ")}`)
  return (
    `${parts.join("; ")}. Install or enable the text plugins (ma-base-prompt-plugin, ` +
    "ma-core-tools-plugin, ma-turn-recovery-plugin, ma-prompt-template-plugin), " +
    "or remove the duplicate plugin."
  )
}

/** The host renderer for boot errors. */
export const coreBootErrorRenderer: ErrorRenderer = {
  kinds: ["ContractCheckFailedError"],
  render: (err) =>
    err.kind === "ContractCheckFailedError" ? contractCheckFailedText(err) : undefined,
}

/**
 * CLI text of a `CompactNoProviderError`: local compaction stopped before the
 * summary request because no plugin gave `compact.summary_system`.
 */
export const COMPACT_NO_PROVIDER_TEXT =
  "Local compaction needs the compaction text (compact.summary_system). " +
  "No plugin gives this text. Examine your plugin overrides, or use /compact tail."

function optText(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined
}

/** CLI text of a `CompactBusyError` (15e.3 row c3). */
export const COMPACT_BUSY_TEXT =
  "compact aborted: a compaction of this history is already in progress. " +
  "Wait for it to end, then try again."

/** CLI text of a `CompactRaceError` (15e.3 row c4). */
export const COMPACT_RACE_TEXT =
  "compact aborted: the history changed during the compaction. " +
  "The history is not compacted. Try again."

/**
 * CLI text of a `CompactModeUnsupportedError` (15e.3 row c5): the mode, and
 * how to make a branch for a fork.
 */
export function compactModeUnsupportedText(err: CoreErrorJson): string {
  const mode = optText(err.fields.mode) ?? "unknown"
  const text = `compact mode ${mode} is not available in this runner. The history did not change.`
  return mode === "fork"
    ? `${text} To make a branch, fork the session file (SessionStore.fork) or copy the transcript, then compact the branch.`
    : text
}

/** CLI text of a `CompactSendPolicyError` (15e.3 row c9): the error name only. */
export function compactSendPolicyText(err: CoreErrorJson): string {
  const name = optText(err.fields.errorName)
  return name !== undefined
    ? `the send policy hook failed (${name})`
    : "the send policy hook failed"
}

/** CLI text of a `CompactSummaryStreamError` (15e.3 row c8), from its fields. */
export function compactSummaryStreamText(err: CoreErrorJson): string {
  const f = err.fields
  const facts = [`retryable: ${f.retryable === true ? "yes" : "no"}`]
  const category = optText(f.category)
  if (category !== undefined) facts.push(`category: ${category}`)
  const upstream = optText(f.upstreamType)
  if (upstream !== undefined) facts.push(`type: ${upstream}`)
  const detail = optText(f.detail)
  const text = `the summary stream failed (${facts.join(", ")})`
  return detail !== undefined ? `${text}: ${detail}` : text
}

/** The host renderer for compaction errors. */
export const coreCompactErrorRenderer: ErrorRenderer = {
  kinds: [
    "CompactNoProviderError",
    "CompactBusyError",
    "CompactRaceError",
    "CompactModeUnsupportedError",
    "CompactSendPolicyError",
    "CompactSummaryStreamError",
  ],
  render: (err) => {
    switch (err.kind) {
      case "CompactNoProviderError":
        return COMPACT_NO_PROVIDER_TEXT
      case "CompactBusyError":
        return COMPACT_BUSY_TEXT
      case "CompactRaceError":
        return COMPACT_RACE_TEXT
      case "CompactModeUnsupportedError":
        return compactModeUnsupportedText(err)
      case "CompactSendPolicyError":
        return compactSendPolicyText(err)
      case "CompactSummaryStreamError":
        return compactSummaryStreamText(err)
      default:
        return undefined
    }
  },
}

/**
 * CLI text of a compaction fallback cause (`CompactStats.remoteError` or
 * `summaryError`, 15e.3 row c7). Built from the code and its facts only.
 * Never empty: a `request_failed` with no facts names the code.
 */
export function compactFailureText(f: CompactFailure): string {
  switch (f.code) {
    case "send_denied": {
      const reason = optText(f.reason)
      return reason !== undefined
        ? `the send policy hook denied the request: ${reason}`
        : "the send policy hook denied the request"
    }
    case "remote_unavailable":
      return "remote compaction is not available (no adapter.compact or no model entry)"
    case "unknown_model":
      return optText(f.model) !== undefined
        ? `the model "${f.model}" is unknown`
        : "the model is unknown"
    case "empty_summary":
      return "the summary has no text"
    default: {
      if (f.error !== undefined) return registry.render(f.error) ?? f.error.kind
      return optText(f.detail) ?? "the request failed"
    }
  }
}

/**
 * CLI text of a rejected `/compact` argv (15e.3 row c10), from the code, the
 * token and the value. The bytes are the same as the old core text (parity
 * snapshot d31).
 */
export function compactArgsErrorText(e: CompactArgsError): string {
  switch (e.code) {
    case "duplicate_mode":
      return `/compact: duplicate mode ("${e.token}")`
    case "unknown_mode":
      return `/compact: unknown mode "${e.value ?? e.token}" (want remote|tail|local|fork)`
    case "bad_tail":
      return `/compact: tail must be an integer >= 0 (got "${e.value ?? e.token}")`
    default:
      return `/compact: unknown argument "${e.token}" (want [mode] [tail=N] [focus="..."])`
  }
}

/**
 * CLI text of a `LifecycleDeniedError`: a lifecycle hook (for example
 * `message.willSend` or `compact.willRun`) denied the operation. The text
 * uses only the fields: the hook name, the plugin id, the tool name, the
 * facts of a failed approval hook, and the reason that the hook gave. When
 * the hook gave no reason, the text gives no reason.
 *
 * Same deny text in 3 other places: web server/src/chat-stream/adapter.ts,
 * plugins ma-acp-plugin/error-text.ts, plugins ma-sub-agents-plugin/lib/error-text.ts.
 */
export function lifecycleDeniedText(err: CoreErrorJson): string {
  const f = err.fields
  const hook = optText(f.hook) ?? "lifecycle"
  const pluginId = optText(f.pluginId)
  const tool = optText(f.tool)
  const reason = optText(f.reason)
  let text = `The ${hook} hook denied the operation`
  if (pluginId !== undefined) text += ` (plugin ${pluginId})`
  if (tool !== undefined) text += ` for the tool ${tool}`
  const failure = f.failure
  if (failure !== null && typeof failure === "object" && !Array.isArray(failure)) {
    const label = optText((failure as { label?: unknown }).label)
    const detail = optText((failure as { detail?: unknown }).detail)
    text +=
      label !== undefined ? `. The approval hook "${label}" failed` : ". The approval hook failed"
    if (detail !== undefined) text += ` (${detail})`
  }
  return reason !== undefined ? `${text}: ${reason}` : `${text}.`
}

/** The host renderer for lifecycle hook denies. */
export const coreLifecycleErrorRenderer: ErrorRenderer = {
  kinds: ["LifecycleDeniedError"],
  render: (err) => (err.kind === "LifecycleDeniedError" ? lifecycleDeniedText(err) : undefined),
}

/** Make a registry that holds the CLI renderers (owner "host"). */
export function createCliErrorRegistry(): ErrorRendererRegistry {
  const registry = createErrorRendererRegistry()
  registry.register(coreAuthErrorRenderer, HOST_OWNER_ID)
  registry.register(coreBootErrorRenderer, HOST_OWNER_ID)
  registry.register(coreCompactErrorRenderer, HOST_OWNER_ID)
  registry.register(coreLifecycleErrorRenderer, HOST_OWNER_ID)
  return registry
}

const registry = createCliErrorRegistry()

/**
 * Text of an error for the CLI. A `CoreError` of a known kind gets its CLI
 * text. Any other error gives its own message.
 */
export function errorText(err: unknown): string {
  if (err !== null && typeof err === "object" && "toJSON" in err && "kind" in err) {
    const text = registry.render(err as CoreError)
    if (text !== undefined) return text
  }
  return err instanceof Error ? err.message : String(err)
}

/** One startup failure line: `<what>: <text of err>`. A CoreError gets its CLI text. */
export function failureText(what: string, err: unknown): string {
  return `${what}: ${errorText(err)}`
}

/**
 * Text of an error event or a `failed` stop cause. Core sends `error` (kind and
 * fields) for a CoreError and an empty `message`. A known kind gets its CLI
 * text. A kind with no CLI text and an empty `message` gives the kind, so
 * the line is never empty. Any other event gives its `message`.
 */
export function errorEventText(ev: {
  readonly message: string
  readonly error?: { readonly kind: string; readonly fields: Readonly<Record<string, unknown>> }
}): string {
  if (ev.error !== undefined) {
    const text = registry.render({ kind: ev.error.kind, fields: ev.error.fields } as CoreErrorJson)
    if (text !== undefined) return text
    if (ev.message === "") return ev.error.kind
  }
  return ev.message
}

/** True when `err` (or its cause) is a `NoProviderCredentialsError`. */
export function isNoCredentials(err: unknown): boolean {
  const kind = (e: unknown): unknown =>
    e !== null && typeof e === "object" ? (e as { kind?: unknown }).kind : undefined
  return (
    kind(err) === "NoProviderCredentialsError" ||
    kind((err as { cause?: unknown } | null)?.cause) === "NoProviderCredentialsError"
  )
}

/** Old reason text of a login failure code. */
export function loginFailureText(code: LoginFailureCode): string {
  switch (code) {
    case "no-paste":
      return "no paste received"
    case "empty-code":
      return "no code pasted"
    case "unparseable-code":
      return "could not parse pasted code"
    default:
      return "state mismatch — pasted code does not match this login attempt"
  }
}

/** Old text of one login event (one message, as the old `display` got it). */
export function loginEventText(ev: LoginEvent): string {
  switch (ev.kind) {
    case "device-code":
      return `Open this page to sign in:\n  ${ev.verificationUrl}\nEnter this one-time code:\n  ${ev.userCode}\nNever share this code with anyone.`
    case "device-waiting":
      return `Waiting for sign-in to finish…`
    case "browser-opening":
      return `Opening browser to sign in…`
    case "browser-fallback":
      return `If the browser didn't open, visit:\n  ${ev.authUrl}`
    case "invalid-code":
      return `Invalid code. Please make sure the full code was copied. (${loginFailureText(ev.reason)})`
    default:
      return `State mismatch. Please paste the code from this login attempt only.`
  }
}

/** Old text of the startup auth row. `dim` styles the detail in parentheses. */
export function startupAuthText(
  d: StartupAuthDescription,
  dim: (text: string) => string = (text) => text,
): string {
  if (d.kind === "anonymous") return `anonymous ${dim(`(${d.providerId})`)}`
  if (d.kind === "provider-plugin") return `${d.type} ${dim(`(${d.providerId})`)}`
  return `${d.type}${d.accountPrefix ? ` ${dim(`(account: ${d.accountPrefix}...)`)}` : ""}`
}

/** Old text of the context-exceeded advice (the /compact guidance). */
export function contextExceededAdviceText(a: ContextExceededAdvice): string {
  const modelSuffix = a.model ? ` for ${a.model}` : ""
  return (
    `Context window exceeded${modelSuffix}. The failed user turn was rolled back. ` +
    "Run /compact (or enable auto-compact on exceeded), start a fresh session, or prune old history before retrying. " +
    "Resuming the same oversized transcript will fail again."
  )
}

/** Old text of one recovery notice. */
export function contextNoticeText(n: ContextExceededNotice): string {
  switch (n.kind) {
    case "auto_compacted":
      return `Auto-compacted context (${n.compactKind}): ${n.messagesBefore} -> ${n.messagesAfter} messages.`
    case "retrying_failed_turn":
      return "Retrying the failed user turn once."
    case "auto_compact_failed":
      return `Auto-compact failed: ${causeText(n.cause)}`
    default:
      return contextExceededAdviceText(n)
  }
}

/** Text of an auto-compact failure cause: the CLI text of a CoreError, else its message. */
function causeText(cause: CoreErrorJson | { message: string }): string {
  if ("message" in cause) return cause.message
  return registry.render(cause) ?? cause.kind
}
