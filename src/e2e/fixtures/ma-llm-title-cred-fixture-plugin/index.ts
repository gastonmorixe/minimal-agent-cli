/**
 * Test-only provider plugin for the title credential e2e test
 * (`e2e/title-credential.e2e.test.ts`). It ships with the CLI test.
 *
 * The provider has one API-key credential type and one free model with
 * JSON-schema output. It recommends that model as its utility (title)
 * model, so the title plugin makes a side call to it.
 *
 * Each request appends one JSON line to `TITLE_CRED_LOG`:
 * `{ "round": "title" | "main", "key": <API key> }`. A request with an
 * output format is the title call. A request with a key that is not
 * `TITLE_CRED_ACCEPT_KEY` fails, as the real API refuses a credential of an
 * other account (HTTP 403).
 *
 * @module e2e/fixtures/ma-llm-title-cred-fixture-plugin
 */

import { appendFileSync } from "node:fs"

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import type {
  ProviderAdapterView,
  ProviderPlugin,
  ProviderSetupContext,
} from "@minimal-agent/core/plugin-api/llm/provider-plugin"

/** The provider id. It is also the credential slug in the auth store. */
export const TITLE_CRED_FIXTURE_PROVIDER = "title-cred-fixture"
/** The one model id of the provider. */
export const TITLE_CRED_FIXTURE_MODEL = "title-cred-fixture-model"
/** The title that the fake title call gives. */
export const TITLE_CRED_FIXTURE_TITLE = "Fix the login page"

const USAGE = { inputTokens: 1, outputTokens: 1 }

function textRound(round: string, text: string): CanonicalEvent[] {
  return [
    {
      type: "message_start",
      messageId: `msg_${round}`,
      modelId: TITLE_CRED_FIXTURE_MODEL,
      initialUsage: USAGE,
    },
    { type: "text_start", index: 0 },
    { type: "text_delta", index: 0, text },
    { type: "text_stop", index: 0, finalText: text },
    { type: "message_delta", stopReason: "end_turn", usage: USAGE },
    { type: "message_stop" },
  ]
}

const adapter: ProviderAdapterView = {
  id: TITLE_CRED_FIXTURE_PROVIDER,
  displayName: "Title Credential Fixture",
  surfaces: [TITLE_CRED_FIXTURE_PROVIDER],
  validate: () => ({ ok: true, errors: [] }),
  recommendUtilityModel: () => ({
    modelId: TITLE_CRED_FIXTURE_MODEL,
    structured: "json_schema",
  }),
  async *run(req: CanonicalRequest, _model, ctx): AsyncIterable<CanonicalEvent> {
    const round = req.outputFormat ? "title" : "main"
    const key = ctx.auth.kind === "api-key" ? ctx.auth.key : `<${ctx.auth.kind}>`
    appendFileSync(process.env.TITLE_CRED_LOG ?? "", `${JSON.stringify({ round, key })}\n`)
    if (key !== process.env.TITLE_CRED_ACCEPT_KEY) {
      throw new Error("title-cred-fixture: HTTP 403: the credential has no access")
    }
    const text = round === "title" ? JSON.stringify({ title: TITLE_CRED_FIXTURE_TITLE }) : "Done."
    yield* textRound(round, text)
  },
}

/** Register the model and the adapter. */
function register(ctx?: ProviderSetupContext): void {
  if (!ctx?.providers) return
  const caps = defaultCapabilities()
  ctx.models.register({
    id: TITLE_CRED_FIXTURE_MODEL,
    providerId: TITLE_CRED_FIXTURE_PROVIDER,
    surfaceId: TITLE_CRED_FIXTURE_PROVIDER,
    displayName: "Title Credential Fixture",
    capabilities: { ...caps, structuredOutputs: true, tools: { ...caps.tools, userDefined: true } },
    pricing: {
      inputUSD: 0,
      outputUSD: 0,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  })
  ctx.providers.register(adapter)
}

/** The provider plugin that `provider.json` names. */
export const titleCredFixtureProviderPlugin: ProviderPlugin = {
  id: TITLE_CRED_FIXTURE_PROVIDER,
  displayName: "Title Credential Fixture",
  shortCode: "tc",
  register,
  apiKeyAuth: {
    serviceId: TITLE_CRED_FIXTURE_PROVIDER,
    displayName: "Title Credential Fixture Key",
    buildCredential: (apiKey: string) => ({
      serviceId: TITLE_CRED_FIXTURE_PROVIDER,
      displayName: "Title Credential Fixture Key",
      secrets: { tokenType: "api-key", apiKey },
    }),
    readApiKey: (secrets) => (typeof secrets.apiKey === "string" ? secrets.apiKey : null),
  },
}
