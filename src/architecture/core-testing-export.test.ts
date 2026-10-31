import { describe, expect, it } from "bun:test"

import type { AuthResult } from "@minimal-agent/core/host/auth"
import { buildTestCore, TEST_CORE_MODEL } from "@minimal-agent/core/testing/test-core"

/**
 * Smoke test for `@minimal-agent/core/testing/test-core` (Y4's export,
 * confirmed resolvable post the S34 Phase 1 re-pin to `89e29cf3`). This is
 * the one core-testing subpath the CLI repo will lean on once its own host
 * tests move here in Phase 2 — a real failure here means the re-pin broke
 * something, not just that the subpath is missing.
 */
describe("@minimal-agent/core/testing/test-core", () => {
  it("builds a working AgentCore through the production factory", async () => {
    const auth: AuthResult = { type: "api-key", token: "test-token" }
    const sendFn = async function* () {
      yield "pong"
      return {
        blocks: [{ type: "text" as const, text: "pong" }],
        text: "pong",
        stopReason: "end_turn",
      }
    }

    const agent = await buildTestCore({ auth, sendFn })

    const gen = agent.run("ping")
    let step = await gen.next()
    while (!step.done) step = await gen.next()

    expect(agent.getModel()).toBe(TEST_CORE_MODEL)
    expect(step.value.outcome).toBe("completed")
  })
})
