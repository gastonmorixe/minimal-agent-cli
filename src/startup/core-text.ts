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
    default:
      return undefined
  }
}

const AUTH_KINDS = [
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

/** Make a registry that holds the CLI renderers (owner "host"). */
export function createCliErrorRegistry(): ErrorRendererRegistry {
  const registry = createErrorRendererRegistry()
  registry.register(coreAuthErrorRenderer, HOST_OWNER_ID)
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

/** True when `err` (or its cause) is a `NoProviderCredentialsError`. */
export function isNoCredentials(err: unknown): boolean {
  const kind = (e: unknown): unknown =>
    e !== null && typeof e === "object" ? (e as { kind?: unknown }).kind : undefined
  return (
    kind(err) === "NoProviderCredentialsError" ||
    kind((err as { cause?: unknown } | null)?.cause) === "NoProviderCredentialsError"
  )
}
