/**
 * Child process for the resume-after-kill spawn test (S50). It runs the
 * real CLI `main()` with a scripted provider. The script replaces the
 * request method of the test network transport (`MINIMAL_AGENT_TRANSPORT=test`)
 * before `main()` loads.
 *
 * The script picks the round from the request body: round = 1 + the count
 * of `TOOLDONE-` markers (the output of each earlier Bash call). Rounds 1
 * and 2 ask for one Bash call each, which appends `r<round>` to the mark
 * file. Round 3 answers with text. Each request appends its round to the
 * request log. When the round equals `RESUME_TEST_KILL_AT_ROUND`, the
 * process kills itself with SIGKILL, as a crash would.
 *
 * Env: `RESUME_TEST_LOG`, `RESUME_TEST_MARK`, `RESUME_TEST_KILL_AT_ROUND`.
 * Argv: the CLI argv.
 *
 * @module startup/fixtures/resume-kill-child
 */

import { appendFileSync } from "node:fs"

import { NetworkResponse, TestTransport } from "@minimal-agent/core/host/network"

const logPath = process.env.RESUME_TEST_LOG ?? ""
const markPath = process.env.RESUME_TEST_MARK ?? ""
const killAt = Number(process.env.RESUME_TEST_KILL_AT_ROUND ?? "0")

/** Anthropic-messages SSE events for one scripted round. */
function roundEvents(round: number): object[] {
  const start = {
    type: "message_start",
    message: { id: `msg_${round}`, model: "test-model", usage: { input_tokens: 1 } },
  }
  if (round <= 2) {
    // `TOOL''DONE` keeps the marker out of the tool input. Only the output has it.
    const input = { command: `echo r${round} >> ${markPath} && echo TOOL''DONE-${round}` }
    return [
      start,
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: `toolu_${round}`, name: "Bash", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null } },
      { type: "message_stop" },
    ]
  }
  return [
    start,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: `ROUND-${round}-ANSWER` },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
    { type: "message_stop" },
  ]
}

TestTransport.prototype.request = async function scripted(req): Promise<NetworkResponse> {
  const body =
    typeof req.body === "string" ? req.body : new TextDecoder().decode(req.body ?? new Uint8Array())
  const round = 1 + (body.match(/TOOLDONE-\d/g)?.length ?? 0)
  appendFileSync(logPath, `${round}\n`)
  if (round === killAt) process.kill(process.pid, "SIGKILL")
  const encoder = new TextEncoder()
  const events = roundEvents(round)
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    transport: { id: "test", protocol: "h2", reused: true },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n`))
        }
        controller.enqueue(encoder.encode("data: [DONE]\n"))
        controller.close()
      },
    }),
  })
}

const { main } = await import("../../main.ts")
process.exitCode = await main({ argv: process.argv.slice(2) })
