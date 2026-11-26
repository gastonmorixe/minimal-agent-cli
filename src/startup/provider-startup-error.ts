import type { StoredProviderFact } from "@minimal-agent/core/errors"
import { suggest } from "../cli/registry/suggest.ts"
import { storedProvidersHintText } from "./core-text.ts"
import type { InvalidBootModelSelection } from "./resolve-boot-model.ts"

/** Keep the original message for protocol consumers and give stderr its own layout. */
export class ProviderStartupError extends Error {
  constructor(
    message: string,
    readonly summary: string,
    readonly next: readonly string[],
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** A shell operand for a command shown in a recovery hint. */
export function commandArg(value: string): string {
  return /^[a-zA-Z0-9_][a-zA-Z0-9_.:/-]*$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`
}

/** Keep one provider and its example models on each row. */
export function providerChoiceRows(providers: readonly StoredProviderFact[]): string[] {
  if (providers.length === 0) return []
  return [
    "Saved credentials (example model IDs):",
    ...providers.map(({ providerId, exampleModels }) =>
      exampleModels.length ? `  ${providerId}: ${exampleModels.join(", ")}` : `  ${providerId}`,
    ),
    "List credentials: minimal-agent auth-status",
  ]
}

/** Format a provider problem before a session has started. No trailing newline. */
export function formatProviderStartupError(err: ProviderStartupError): string {
  return [`fatal: ${err.summary}`, ...err.next.map((line) => (line ? `  ${line}` : ""))].join("\n")
}

/** Command to find model IDs for the selected provider. */
function listModelsHint(provider: string): string {
  // An incomplete pair can still contain an unvalidated provider id.
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(provider)) return LIST_PROVIDERS_HINT
  return `List models: minimal-agent providers models ${provider}`
}

/** Command to find provider IDs. */
export const LIST_PROVIDERS_HINT = "List providers: minimal-agent providers"

/** Print a user-supplied identifier without terminal control characters. */
export function quotedId(value: string): string {
  // JSON escapes C0 controls. Escape DEL and C1 in addition.
  return JSON.stringify(value).replace(
    /[\u007f-\u009f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

/** Project the selection problem onto a cause and a recovery path. */
export function selectionError(
  selection: InvalidBootModelSelection,
  providers?: readonly StoredProviderFact[],
): ProviderStartupError {
  const { issue, reason } = selection
  switch (issue) {
    case "missing-provider":
      return new ProviderStartupError(
        reason,
        `model ${quotedId(selection.id)} requires an explicit provider`,
        ["Add --provider <id> to your command.", LIST_PROVIDERS_HINT],
      )
    case "no-suggested-model":
    case "missing-model":
      return new ProviderStartupError(
        providers ? `${reason}. ${storedProvidersHintText(providers)}` : reason,
        issue === "missing-model"
          ? `provider ${quotedId(selection.id)} requires an explicit model`
          : `no default model found for provider ${quotedId(selection.id)}`,
        ["Add --model <id> to your command.", listModelsHint(selection.id)],
      )
    default: {
      const saved = providers ?? []
      const message = `${reason}. ${storedProvidersHintText(saved)}`
      if (issue === "no-credentials") {
        return new ProviderStartupError(message, "no provider credentials found", [
          LIST_PROVIDERS_HINT,
          "Sign in: minimal-agent provider <id> login",
        ])
      }
      if (issue === "no-usable-credentials") {
        return new ProviderStartupError(message, "no usable provider credentials found", [
          "Check credentials: minimal-agent auth-status",
          "Sign in again: minimal-agent provider <id> login",
        ])
      }
      return new ProviderStartupError(message, "multiple usable credentials found", [
        "Choose a provider and model: --provider <id> --model <id>",
        'To set defaults, add "provider" and "model" to your config.jsonc.',
        "",
        ...providerChoiceRows(saved),
      ])
    }
  }
}

/** Show catalog matches without printing the full catalog. */
export function unknownTargetError(
  id: string,
  candidates: readonly string[],
  provider?: string,
  contextSuffix = "",
): ProviderStartupError {
  const [match] = id.length <= 128 ? suggest(id, candidates, { limit: 1 }) : []
  const kind = provider === undefined ? "provider" : "model"
  const plainTail = provider === undefined ? "" : ` for provider "${provider}"`
  const tail = provider === undefined ? "" : ` for provider ${quotedId(provider)}`
  return new ProviderStartupError(
    `unknown ${kind} "${id}"${plainTail}`,
    `unknown ${kind} ${quotedId(id)}${tail}`,
    [
      ...(match ? [`Did you mean ${quotedId(match + contextSuffix)}?`] : []),
      provider === undefined ? LIST_PROVIDERS_HINT : listModelsHint(provider),
    ],
  )
}

/**
 * Show a saved credential problem without dumping unrelated providers.
 *
 * `message` is the core text, and the stream-json `error` line reads it. The
 * core text says "no credentials" and does not know the credential name. So
 * for a named credential (`ref`), or when the provider has a saved credential
 * (`saved`), that text is false, and the protocol message is the stderr
 * summary. Only an unnamed run with no saved credential keeps the core text.
 */
export function credentialError(
  cause: Error,
  message: string,
  provider: string,
  model: string,
  ref: string | undefined,
  saved: boolean,
): ProviderStartupError {
  const summary =
    ref !== undefined
      ? `no usable credential ${quotedId(ref)} for provider ${quotedId(provider)}`
      : `no usable credentials for provider ${quotedId(provider)} (model ${quotedId(model)})`
  const login = `Sign in: minimal-agent provider ${commandArg(provider)} login`
  const next = []
  if (saved) next.push("Check credentials: minimal-agent auth-status")
  if (ref !== undefined) {
    next.push("Clear the credential name to use the default.")
    if (saved) next.push("Or select a saved name with --credential-name <name>.")
  }
  if (!saved || ref === undefined) next.push(login)
  const protocolMessage = ref !== undefined || saved ? summary : message
  return new ProviderStartupError(protocolMessage, summary, next, { cause })
}
