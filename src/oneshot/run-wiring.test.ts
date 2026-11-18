/**
 * `runNonInteractivePrompt` arms the one-shot run values (`--temperature`,
 * `--strict`) on the core before the prompt run, on the text route and on
 * the event-stream route.
 *
 * @module oneshot/run-wiring.test
 */

import { beforeEach, describe, expect, test } from "bun:test"

import type { Session } from "@minimal-agent/core"
import type { ReplAgentLike } from "../repl.ts"
import {
  type RunNonInteractivePromptInput,
  runNonInteractivePrompt,
} from "../startup/run-non-interactive.ts"
import { resetStreamJsonWriterForTests } from "../startup/stream-json-writer.ts"

beforeEach(() => resetStreamJsonWriterForTests())

/** A core that records setter calls, and the order against `run`. */
function recordingCore(log: string[]) {
  return {
    setNextRunTemperature(t: unknown) {
      log.push(`temperature=${String(t)}`)
    },
    setNextRunOutputStrict(s: unknown) {
      log.push(`strict=${String(s)}`)
    },
  }
}

function textAgent(log: string[], core: object | null): ReplAgentLike {
  return {
    ...(core ? { agentCore: () => core } : {}),
    run(prompt: string) {
      log.push(`run:${prompt}`)
      return (async function* () {
        yield "ok"
        return { blocks: [], text: "ok", stopReason: "end_turn" }
      })()
    },
  } as unknown as ReplAgentLike
}

function fakeSession(log: string[], core: object): Session {
  return {
    id: "sid",
    agentCore: () => core,
    run(text: string) {
      log.push(`run:${text}`)
      const entries = (async function* () {})()
      return Object.assign(entries, { result: Promise.resolve({ outcome: "done" }) })
    },
  } as unknown as Session
}

function input(over: Partial<RunNonInteractivePromptInput>): RunNonInteractivePromptInput {
  return {
    agent: textAgent([], null),
    prompt: "go",
    formatterCmd: undefined,
    showHeader: false,
    wantJsonOutput: false,
    outputSchema: undefined,
    loader: null,
    cwd: process.cwd(),
    stdout: () => {},
    exit: ((code: number) => {
      throw new Error(`exit ${code}`)
    }) as (code: number) => never,
    ...over,
  }
}

async function quietStdout(fn: () => Promise<void>): Promise<void> {
  const orig = process.stdout.write.bind(process.stdout)
  ;(process.stdout as unknown as { write: () => boolean }).write = () => true
  try {
    await fn()
  } finally {
    ;(process.stdout as unknown as { write: typeof orig }).write = orig
  }
}

describe("runNonInteractivePrompt one-shot run options", () => {
  test("text route: setters run before the prompt run", async () => {
    const log: string[] = []
    const agent = textAgent(log, recordingCore(log))
    await quietStdout(() =>
      runNonInteractivePrompt(
        input({ agent, oneShotRunOptions: { temperature: 0.2, outputStrict: true } }),
      ),
    )
    expect(log).toEqual(["temperature=0.2", "strict=true", "run:go"])
  })

  test("text route: an agent with no core (older core) runs without them, no throw", async () => {
    const log: string[] = []
    await quietStdout(() =>
      runNonInteractivePrompt(
        input({ agent: textAgent(log, null), oneShotRunOptions: { temperature: 1 } }),
      ),
    )
    expect(log).toEqual(["run:go"])
  })

  test("event-stream route: setters run before session.run", async () => {
    const log: string[] = []
    const session = fakeSession(log, recordingCore(log))
    await runNonInteractivePrompt(
      input({
        outputFormat: "json",
        openEventStreamSession: () => Promise.resolve(session),
        oneShotRunOptions: { temperature: 0.4 },
      }),
    )
    expect(log).toEqual(["temperature=0.4", "run:go"])
  })

  test("event-stream route: a core with no setters → run goes on", async () => {
    const log: string[] = []
    const session = fakeSession(log, {})
    await runNonInteractivePrompt(
      input({
        outputFormat: "json",
        openEventStreamSession: () => Promise.resolve(session),
        oneShotRunOptions: { temperature: 0.4, outputStrict: true },
      }),
    )
    expect(log).toEqual(["run:go"])
  })
})
