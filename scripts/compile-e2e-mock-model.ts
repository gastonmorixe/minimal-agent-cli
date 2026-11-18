/**
 * A scripted OpenAI chat-completions model for `scripts/compile-e2e.sh`
 * check 9. The e2e runs it on the compiled binary itself
 * (`BUN_BE_BUN=1 <binary> mock-model.ts PORT_FILE LOG_FILE BG_COMMAND`), so
 * the host needs no bun.
 *
 * Round 1 of the parent turn calls `BackgroundRun` (BG_COMMAND) and
 * `SubAgentsSpawnAgent` with CHILD_TASK. A request that opens with
 * CHILD_TASK is the child agent: it gets a plain answer. Round 2 of the
 * parent waits until the child has called the model, so neither the child
 * nor the job is reaped before it runs, then answers `DONE`. Every request
 * is logged.
 *
 * The mock finds the child by the task text that the mock itself sends. It
 * does not read the sub-agent prompt of the plugin, so a change to that
 * prompt cannot break this check.
 *
 * @module scripts/compile-e2e-mock-model
 */

import { appendFileSync, writeFileSync } from "node:fs"

const [portFile = "port", logFile = "log", bgCommand = "echo bg-hi"] = process.argv.slice(2)
const log = (s: string): void => appendFileSync(logFile, `${s}\n`)
let childSeen = false
let parentRound = 0

/** The task that the parent gives to the child in round 1. */
const CHILD_TASK = "Reply with CHILD-OK and nothing else."
/** CHILD_TASK as it shows in JSON text. */
const CHILD_TASK_JSON = JSON.stringify(CHILD_TASK).slice(1, -1)

interface Message {
  role?: string
  content?: unknown
}

/**
 * True for a request from the child agent: its opening carries CHILD_TASK.
 * The opening is each message up to and including the first `user` message.
 * The opening of the parent is its system prompt and the `-p` text. Later
 * parent messages are not examined: the tool call of the parent has the task
 * text, and a tool result or a notice can repeat it.
 */
const isChildRequest = (messages: Message[]): boolean => {
  const firstUser = messages.findIndex((m) => m.role === "user")
  const opening = firstUser === -1 ? messages : messages.slice(0, firstUser + 1)
  return JSON.stringify(opening.map((m) => m.content ?? null)).includes(CHILD_TASK_JSON)
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
const call = (id: string, name: string, args: unknown, index: number) => ({
  index,
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
})

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const body = JSON.parse(await req.text()) as {
      messages?: Message[]
      tools?: { function?: { name?: string } }[]
    }
    const tools = (body.tools ?? []).map((t) => t.function?.name)
    let events: unknown[]
    if (isChildRequest(body.messages ?? [])) {
      childSeen = true
      log("child-request")
      events = text("CHILD-OK")
    } else {
      parentRound++
      log(
        `parent-request ${parentRound} bg=${tools.includes("BackgroundRun")} spawn=${tools.includes("SubAgentsSpawnAgent")}`,
      )
      if (parentRound === 1) {
        events = [
          chunk({
            role: "assistant",
            tool_calls: [
              call("call_bg", "BackgroundRun", { command: bgCommand }, 0),
              call("call_sa", "SubAgentsSpawnAgent", { task: CHILD_TASK }, 1),
            ],
          }),
          chunk({}, "tool_calls"),
        ]
      } else {
        for (let i = 0; i < 160 && !childSeen; i++) await Bun.sleep(250)
        await Bun.sleep(1500)
        log(`parent-final childSeen=${childSeen}`)
        events = text("DONE")
      }
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
