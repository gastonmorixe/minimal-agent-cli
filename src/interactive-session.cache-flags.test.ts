/**
 * The F1/F2 prompt-cache flags reach the interactive (REPL) session core, not
 * only `-p`. (An older attempt read the env only on the `-p` path: C-59.)
 *
 * @module interactive-session.cache-flags.test
 */

import { describe, expect, it } from "bun:test"
import type { AuthResult } from "@minimal-agent/core/host/auth"
import type { BuildAgentCoreDeps } from "@minimal-agent/core/host-kit/build-agent-core"
import type { Message } from "@minimal-agent/core/sdk/messages"
import { InteractiveSession } from "./interactive-session.ts"
import type {
  TestSendParams as SendOptions,
  TestSendResult as StreamedResponse,
} from "./test-utils/transport-types.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

function deps(sendFn: BuildAgentCoreDeps["sendFn"], cacheAnchor?: boolean): BuildAgentCoreDeps {
  return {
    auth: AUTH,
    model: "test-model",
    sendFn,
    loader: null,
    modeManager: null,
    store: null,
    blobStore: null,
    saveEcho: null,
    turnAttachments: [],
    ...(cacheAnchor !== undefined ? { cacheAnchor } : {}),
  }
}

async function drain(gen: AsyncGenerator<string, unknown>): Promise<void> {
  while (!(await gen.next()).done) {}
}

/** Count the message cache markers of each request across 3 user turns. */
async function markersPerRequest(cacheAnchor?: boolean): Promise<number[]> {
  const seen: Message[][] = []
  const sendFn = async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse> {
    seen.push(structuredClone(opts.messages) as Message[])
    yield "ok"
    return { blocks: [{ type: "text", text: "ok" }], text: "ok", stopReason: "end_turn" }
  }
  const session = await InteractiveSession.create(deps(sendFn, cacheAnchor))
  for (const t of ["one", "two", "three"]) await drain(session.run(t))
  return seen.map((msgs) => (JSON.stringify(msgs).match(/"cache_control"/g) ?? []).length)
}

describe("InteractiveSession prompt-cache flags", () => {
  it("default: one rolling marker per request", async () => {
    expect(await markersPerRequest()).toEqual([1, 1, 1])
  })

  it("cacheAnchor: the third request (2 assistant turns) also carries the anchor", async () => {
    expect(await markersPerRequest(true)).toEqual([1, 1, 2])
  })
})
