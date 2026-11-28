/**
 * A scripted OpenAI chat-completions model for `scripts/compile-e2e.sh`
 * check 10 (the embedded computer-use helper). The e2e runs it on the
 * compiled binary itself
 * (`BUN_BE_BUN=1 <binary> mock-computer.ts PORT_FILE LOG_FILE`), so the
 * host needs no bun.
 *
 * A request with no `Computer` result yet gets one `Computer` call with
 * `{"action":"ping"}`. A request that carries the result of that call gets
 * the final text `DONE`. The mock logs each request, and one `ping` line
 * with the `pid`, `protocol` and `binary.path` of the helper ping. The e2e
 * stops only the helper with that pid. A ping does not need a TCC grant.
 *
 * The tool result can have text after the JSON (a footer of the host), so
 * the mock reads the fields with patterns, not with `JSON.parse`.
 *
 * @module scripts/compile-e2e-mock-computer
 */

import { appendFileSync, writeFileSync } from "node:fs"

const [portFile = "port", logFile = "log"] = process.argv.slice(2)
const log = (s: string): void => appendFileSync(logFile, `${s}\n`)
/** The id of the one `Computer` call. */
const CALL_ID = "call_ping"
/** The most `Computer` calls with no result, so a bad run cannot loop. */
const MAX_CALLS = 3
let round = 0
let calls = 0

interface Message {
  role?: string
  content?: unknown
  tool_call_id?: string
}

const sse = (chunks: unknown[]): string =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`
const chunk = (delta: unknown, finish: string | null = null) => ({
  id: "c1",
  object: "chat.completion.chunk",
  model: "mock-model",
  choices: [{ index: 0, delta, finish_reason: finish }],
})
const text = (t: string): unknown[] => [chunk({ role: "assistant", content: t }), chunk({}, "stop")]
const pingCall = (): unknown[] => [
  chunk({
    role: "assistant",
    tool_calls: [
      {
        index: 0,
        id: CALL_ID,
        type: "function",
        function: { name: "Computer", arguments: JSON.stringify({ action: "ping" }) },
      },
    ],
  }),
  chunk({}, "tool_calls"),
]

/** The text of a message content: a string, or the text parts of an array. */
const contentText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : ""))
      .join("\n")
  }
  return JSON.stringify(content ?? null)
}

/** The `ping` log line for the text of the ping result. */
const pingLine = (result: string): string => {
  const pid = /"pid":\s*(\d+)/.exec(result)?.[1]
  const protocol = /"protocol":\s*(\d+)/.exec(result)?.[1]
  const path = /"binary":\s*\{[^}]*"path":\s*"([^"]*)"/.exec(result)?.[1]?.replaceAll("\\/", "/")
  if (pid === undefined) return `ping-unparsed ${JSON.stringify(result.slice(0, 600))}`
  return `ping pid=${pid} protocol=${protocol ?? "none"} path=${path ?? "none"}`
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 120,
  async fetch(req) {
    const body = JSON.parse(await req.text()) as {
      messages?: Message[]
      tools?: { function?: { name?: string } }[]
    }
    const tools = (body.tools ?? []).map((t) => t.function?.name)
    round++
    log(`request ${round} computer=${tools.includes("Computer")}`)
    const result = (body.messages ?? []).find(
      (m) => m.role === "tool" && m.tool_call_id === CALL_ID,
    )
    let events: unknown[]
    if (result !== undefined) {
      log(pingLine(contentText(result.content)))
      events = text("DONE")
    } else if (calls < MAX_CALLS) {
      calls++
      events = pingCall()
    } else {
      log("no-ping-result")
      events = text("DONE")
    }
    events.push({
      ...chunk({}),
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    return new Response(sse(events), { headers: { "content-type": "text/event-stream" } })
  },
})
writeFileSync(portFile, String(server.port))
