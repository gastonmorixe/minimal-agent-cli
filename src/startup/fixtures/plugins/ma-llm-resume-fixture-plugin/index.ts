/**
 * Test-only provider plugin for the `--resume` spawn tests (S50). It ships
 * with the CLI test, so the test never needs the sibling plugins repo.
 *
 * The provider scripts each round from the request: round = 1 + the count
 * of `TOOLDONE-` markers (the output of each earlier Bash call). Rounds 1
 * and 2 ask for one Bash call each, which appends `r<round>` to the mark
 * file. Later rounds answer with the text `ROUND-<round>-ANSWER`. Each
 * request appends its round to the request log. When the round equals
 * `RESUME_TEST_KILL_AT_ROUND`, the process kills itself with SIGKILL, as a
 * crash would.
 *
 * Env: `RESUME_TEST_LOG`, `RESUME_TEST_MARK`, `RESUME_TEST_KILL_AT_ROUND`.
 *
 * @module startup/fixtures/plugins/ma-llm-resume-fixture-plugin
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
export const RESUME_FIXTURE_PROVIDER = "resume-fixture"
/** The one model id of the provider. */
export const RESUME_FIXTURE_MODEL = "resume-fixture-model"

const USAGE = { inputTokens: 1, outputTokens: 1 }

/** The round of a request: 1 + the count of `TOOLDONE-` markers in it. */
function roundOf(req: CanonicalRequest): number {
  return 1 + (JSON.stringify(req.messages).match(/TOOLDONE-\d/g)?.length ?? 0)
}

/** The canonical events of one scripted round. */
function roundEvents(round: number): CanonicalEvent[] {
  const start: CanonicalEvent = {
    type: "message_start",
    messageId: `msg_${round}`,
    modelId: RESUME_FIXTURE_MODEL,
    initialUsage: USAGE,
  }
  const end = (stopReason: "tool_use" | "end_turn"): CanonicalEvent[] => [
    { type: "message_delta", stopReason, usage: USAGE },
    { type: "message_stop" },
  ]
  if (round <= 2) {
    const markPath = process.env.RESUME_TEST_MARK ?? ""
    // `TOOL''DONE` keeps the marker out of the tool input. Only the output has it.
    const input = { command: `echo r${round} >> ${markPath} && echo TOOL''DONE-${round}` }
    return [
      start,
      { type: "tool_use_start", index: 0, id: `toolu_${round}`, name: "Bash" },
      { type: "tool_use_input_delta", index: 0, partialJson: JSON.stringify(input) },
      { type: "tool_use_stop", index: 0, input },
      ...end("tool_use"),
    ]
  }
  const text = `ROUND-${round}-ANSWER`
  return [
    start,
    { type: "text_start", index: 0 },
    { type: "text_delta", index: 0, text },
    { type: "text_stop", index: 0, finalText: text },
    ...end("end_turn"),
  ]
}

const adapter: ProviderAdapterView = {
  id: RESUME_FIXTURE_PROVIDER,
  displayName: "Resume Fixture",
  surfaces: [RESUME_FIXTURE_PROVIDER],
  validate: () => ({ ok: true, errors: [] }),
  async *run(req: CanonicalRequest): AsyncIterable<CanonicalEvent> {
    const round = roundOf(req)
    appendFileSync(process.env.RESUME_TEST_LOG ?? "", `${round}\n`)
    if (round === Number(process.env.RESUME_TEST_KILL_AT_ROUND ?? "0")) {
      process.kill(process.pid, "SIGKILL")
    }
    yield* roundEvents(round)
  },
}

/** Register the model and the adapter. */
function register(ctx?: ProviderSetupContext): void {
  if (!ctx?.providers) return
  const caps = defaultCapabilities()
  ctx.models.register({
    id: RESUME_FIXTURE_MODEL,
    providerId: RESUME_FIXTURE_PROVIDER,
    surfaceId: RESUME_FIXTURE_PROVIDER,
    displayName: "Resume Fixture",
    capabilities: { ...caps, tools: { ...caps.tools, userDefined: true } },
    pricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0, webSearchPerCallUSD: 0 },
  })
  ctx.providers.register(adapter)
}

/** The provider plugin that `provider.json` names. */
export const resumeFixtureProviderPlugin: ProviderPlugin = {
  id: RESUME_FIXTURE_PROVIDER,
  displayName: "Resume Fixture",
  shortCode: "rf",
  register,
}
