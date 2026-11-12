/**
 * One real core producer driven through the real diagnostics path.
 * `synthetic.duplicate_owner` has an empty message and the attr `kind`.
 * Building an AgentCore with two providers for one kind emits it on the
 * process bus. The CLI scrollback sink reads that bus.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AuthResult } from "@minimal-agent/core/host/auth"
import { getDiagnosticBus } from "@minimal-agent/core/host/diagnostics"
import type { SyntheticTextProvider } from "@minimal-agent/core/plugin-api/types/synthetic-text"
import { buildTestCore } from "@minimal-agent/core/testing/test-core"
import { ScrollbackDiagnosticSink } from "../ui/status/scrollback.ts"

/** Strip ANSI SGR sequences. */
function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

const SOURCE = "synthetic.duplicate_owner"
const auth: AuthResult = { type: "api-key", token: "test-token" }
const sendFn = async function* () {
  return { blocks: [], text: "", stopReason: "end_turn" }
}

function provider(kind: SyntheticTextProvider["kinds"][number]): SyntheticTextProvider {
  return { kinds: [kind], text: () => "x" }
}

/** Two providers own the same kind, so core warns `synthetic.duplicate_owner`. */
async function emitDuplicate(kind: SyntheticTextProvider["kinds"][number]): Promise<void> {
  await buildTestCore({
    auth,
    sendFn: sendFn as never,
    syntheticTextProviders: [provider(kind), provider(kind)],
  })
}

describe("real producer: synthetic.duplicate_owner", () => {
  let lines: string[]
  let sink: ScrollbackDiagnosticSink
  beforeEach(() => {
    lines = []
    sink = new ScrollbackDiagnosticSink({
      write: (s) => {
        lines.push(s)
      },
      now: () => 1000,
      dedupRepaintMinMs: 0,
    })
    sink.attach(getDiagnosticBus())
  })
  afterEach(() => sink.detach())

  const ours = () => lines.map(strip).filter((l) => l.includes(SOURCE))

  test("same stable attrs collapse to one line with count 2", async () => {
    await emitDuplicate("continue.max_tokens")
    await emitDuplicate("continue.max_tokens")
    const got = ours()
    expect(got).toHaveLength(2)
    expect(got[0]).toContain("kind: continue.max_tokens")
    expect(got[1]).toContain("×2")
    for (const l of got) expect(l).not.toMatch(/╰\s*$/m)
  })

  test("another stable attr gives a second line", async () => {
    await emitDuplicate("continue.max_tokens")
    await emitDuplicate("continue.max_tokens")
    await emitDuplicate("assistant.placeholder")
    const got = ours()
    expect(got).toHaveLength(3)
    expect(got[2]).toContain("kind: assistant.placeholder")
    expect(got[2]).not.toContain("×")
  })
})
