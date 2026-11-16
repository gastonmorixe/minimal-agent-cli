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

/** The host renderer for compaction errors. */
export const coreCompactErrorRenderer: ErrorRenderer = {
  kinds: ["CompactNoProviderError"],
  render: (err) => (err.kind === "CompactNoProviderError" ? COMPACT_NO_PROVIDER_TEXT : undefined),
}

/** Make a registry that holds the CLI renderers (owner "host"). */
export function createCliErrorRegistry(): ErrorRendererRegistry {
  const registry = createErrorRendererRegistry()
  registry.register(coreAuthErrorRenderer, HOST_OWNER_ID)
  registry.register(coreBootErrorRenderer, HOST_OWNER_ID)
  registry.register(coreCompactErrorRenderer, HOST_OWNER_ID)
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
 * text. Any other event gives its `message`.
 */
export function errorEventText(ev: {
  readonly message: string
  readonly error?: { readonly kind: string; readonly fields: Readonly<Record<string, unknown>> }
}): string {
  if (ev.error !== undefined) {
    const text = renderCoreError({ kind: ev.error.kind, fields: ev.error.fields } as CoreErrorJson)
    if (text !== undefined) return text
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
