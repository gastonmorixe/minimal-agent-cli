/**
 * G2 (paste plugin v3, D2): a replayed user message shows each inline to-model
 * node as its chip label, as the live editor does. Display only. Also the
 * MAJOR of the review of B part 1: a peer mention at the start of a message
 * must not show the raw tag on resume.
 */

import { describe, expect, it } from "bun:test"

import { NO_SIDEBAND } from "@minimal-agent/core/host/sideband"
import type { Message } from "@minimal-agent/core/sdk/messages"

import { CHIP_SGR, ChipRegistry } from "./paste/chip-registry.ts"
import { replayToScrollback } from "./session-replay.ts"
import { testSideband as sb, sidebandFixturePresent } from "./test-utils/sideband-fixture.ts"

class CaptureSink {
  out = ""
  write(s: string): void {
    this.out += s
  }
}

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

function fixture(): Message[] {
  const peer = sb.render("intercom-peer", { attrs: { name: "bob", sid: "s1" }, body: "@bob" })
  const ref = sb.render("paste", { attrs: { id: "ab1cd", bytes: 1200, lines: 30 } })
  return [
    { role: "user", content: [{ type: "text", text: `${peer} can you look at this?` }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [{ type: "text", text: `fix it:\n${ref}\nthanks` }] },
  ]
}

describe.skipIf(!sidebandFixturePresent())("replay chips (G2)", () => {
  it("golden: a peer mention and a paste ref show as chips", async () => {
    const sink = new CaptureSink()
    await replayToScrollback(fixture(), sink, { sideband: sb, chips: new ChipRegistry() })
    const users = plain(sink.out)
      .split("\n")
      .filter((l) => l.startsWith("❯ ") || l === "[paste]" || l === "thanks")
    expect(users).toEqual(["❯ @bob can you look at this?", "❯ fix it:", "[paste]", "thanks"])
    expect(sink.out).toContain(`${CHIP_SGR}@bob\x1b[0m`)
    expect(sink.out).not.toContain("intercom")
    expect(sink.out).not.toContain("ab1cd")
  })

  it("a registered label is used", async () => {
    const chips = new ChipRegistry()
    chips.register({ kind: "paste", label: (a) => `P#${String(a.id)}` })
    const sink = new CaptureSink()
    await replayToScrollback(fixture(), sink, { sideband: sb, chips })
    expect(plain(sink.out)).toContain("P#ab1cd")
  })

  it("no codec: the user text is plain (no chip)", async () => {
    const msgs = fixture()
    const sink = new CaptureSink()
    await replayToScrollback(msgs, sink, { sideband: NO_SIDEBAND, chips: new ChipRegistry() })
    expect(sink.out).not.toContain(CHIP_SGR)
    const first = msgs[0]!.content as { type: "text"; text: string }[]
    expect(plain(sink.out)).toContain(first[0]!.text)
  })
})
