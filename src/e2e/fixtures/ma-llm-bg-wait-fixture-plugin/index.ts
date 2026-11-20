/**
 * Test-only provider plugin for the headless background-wait e2e test
 * (`e2e/headless-bg-wait.e2e.test.ts`). It ships with the CLI test.
 *
 * The provider scripts each round from the request text:
 *
 * - `run`: no BackgroundRun call yet. Ask for one BackgroundRun call with the
 *   command in `BG_TEST_CMD`.
 * - `wait`: the BackgroundRun result is there, but no halt note of the
 *   ma-background `turn.willStop` hook. Answer with the text "I wait." (the
 *   failure mode: a model that ends its turn to wait for a job).
 * - `logs`: the halt note is there. Ask for one BackgroundLogs call on `j1`.
 * - `final`: the BackgroundLogs result is there. Answer with
 *   `RESULT <marker>`, where the marker is `DONE-42` when the request has
 *   it (the job output), else `MISSING`.
 *
 * Each request appends its round name to `BG_TEST_LOG`.
 *
 * @module e2e/fixtures/ma-llm-bg-wait-fixture-plugin
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

/** The provider id. */
export const BG_WAIT_FIXTURE_PROVIDER = "bg-wait-fixture"
/** The one model id of the provider. */
export const BG_WAIT_FIXTURE_MODEL = "bg-wait-fixture-model"

const USAGE = { inputTokens: 1, outputTokens: 1 }
/** A text of the halt note of the ma-background hook. */
const HALT_NOTE = "background jobs of this run were not complete"

/** The scripted round of a request. */
function roundOf(json: string): "run" | "wait" | "logs" | "final" {
  if (json.includes("toolu_bg_logs")) return "final"
  if (json.includes(HALT_NOTE)) return "logs"
  if (json.includes("toolu_bg_run")) return "wait"
  return "run"
}

function start(round: string): CanonicalEvent {
  return {
    type: "message_start",
    messageId: `msg_${round}`,
    modelId: BG_WAIT_FIXTURE_MODEL,
    initialUsage: USAGE,
  }
}

function end(stopReason: "tool_use" | "end_turn"): CanonicalEvent[] {
  return [{ type: "message_delta", stopReason, usage: USAGE }, { type: "message_stop" }]
}

function toolRound(round: string, id: string, name: string, input: object): CanonicalEvent[] {
  return [
    start(round),
    { type: "tool_use_start", index: 0, id, name },
    { type: "tool_use_input_delta", index: 0, partialJson: JSON.stringify(input) },
    { type: "tool_use_stop", index: 0, input },
    ...end("tool_use"),
  ]
}

function textRound(round: string, text: string): CanonicalEvent[] {
  return [
    start(round),
    { type: "text_start", index: 0 },
    { type: "text_delta", index: 0, text },
    { type: "text_stop", index: 0, finalText: text },
    ...end("end_turn"),
  ]
}

const adapter: ProviderAdapterView = {
  id: BG_WAIT_FIXTURE_PROVIDER,
  displayName: "Background Wait Fixture",
  surfaces: [BG_WAIT_FIXTURE_PROVIDER],
  validate: () => ({ ok: true, errors: [] }),
  async *run(req: CanonicalRequest): AsyncIterable<CanonicalEvent> {
    const json = JSON.stringify(req.messages)
    const round = roundOf(json)
    appendFileSync(process.env.BG_TEST_LOG ?? "", `${round}\n`)
    switch (round) {
      case "run":
        yield* toolRound(round, "toolu_bg_run", "BackgroundRun", {
          command: process.env.BG_TEST_CMD ?? "true",
        })
        return
      case "wait":
        yield* textRound(round, "I wait.")
        return
      case "logs":
        yield* toolRound(round, "toolu_bg_logs", "BackgroundLogs", { id: "j1" })
        return
      case "final":
        yield* textRound(round, `RESULT ${json.includes("DONE-42") ? "DONE-42" : "MISSING"}`)
        return
    }
  },
}

/** Register the model and the adapter. */
function register(ctx?: ProviderSetupContext): void {
  if (!ctx?.providers) return
  const caps = defaultCapabilities()
  ctx.models.register({
    id: BG_WAIT_FIXTURE_MODEL,
    providerId: BG_WAIT_FIXTURE_PROVIDER,
    surfaceId: BG_WAIT_FIXTURE_PROVIDER,
    displayName: "Background Wait Fixture",
    capabilities: { ...caps, tools: { ...caps.tools, userDefined: true } },
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
export const bgWaitFixtureProviderPlugin: ProviderPlugin = {
  id: BG_WAIT_FIXTURE_PROVIDER,
  displayName: "Background Wait Fixture",
  shortCode: "bw",
  register,
}
