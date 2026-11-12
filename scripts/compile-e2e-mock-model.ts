/**
 * A scripted OpenAI chat-completions model for `scripts/compile-e2e.sh`
 * check 9. The e2e runs it on the compiled binary itself
 * (`BUN_BE_BUN=1 <binary> mock-model.ts PORT_FILE LOG_FILE BG_COMMAND`), so
 * the host needs no bun.
 *
 * Round 1 of the parent turn calls `BackgroundRun` (BG_COMMAND) and
 * `SubAgentsSpawnAgent`. A request with the leaf-worker prompt is the child
 * agent: it gets a plain answer. Round 2 of the parent waits until the
 * child has called the model, so neither the child nor the job is reaped
 * before it runs, then answers `DONE`. Every request is logged.
 *
 * @module scripts/compile-e2e-mock-model
 */

import { appendFileSync, writeFileSync } from "node:fs"

const [portFile = "port", logFile = "log", bgCommand = "echo bg-hi"] = process.argv.slice(2)
const log = (s: string): void => appendFileSync(logFile, `${s}\n`)
let childSeen = false
let parentRound = 0

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
      messages?: unknown[]
      tools?: { function?: { name?: string } }[]
    }
    const all = JSON.stringify(body.messages ?? [])
    const tools = (body.tools ?? []).map((t) => t.function?.name)
    let events: unknown[]
    if (all.includes("leaf worker")) {
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
              call(
                "call_sa",
                "SubAgentsSpawnAgent",
                { task: "Reply with CHILD-OK and nothing else." },
                1,
              ),
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
