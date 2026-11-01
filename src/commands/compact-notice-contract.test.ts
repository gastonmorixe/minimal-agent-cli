/**
 * Moved from core `host/commands/compact-contract.test.ts` (S34 Phase 4).
 * The compact notice block is CLI code. These tests prove the notice shows
 * the exact checkpoint body that core commits, with no truncation.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { clearModelRegistry, clearProviderRegistry } from "@minimal-agent/core/host/model-registry"
import { clearProviderPlugins } from "@minimal-agent/core/host/provider-plugin"
import { SessionPersistenceAdapter } from "@minimal-agent/core/host-kit/session-persistence-adapter"
import type { CompactRecord, SessionStore } from "@minimal-agent/core/host-kit/session-store"
import { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import type { Message } from "@minimal-agent/core/sdk/messages"
import { registerTestProvider } from "@minimal-agent/core/testing/provider-fixture"

import { buildCompactNoticeBlock } from "./compact.ts"

const MODEL = "compact-notice-model"
const PROVIDER = "compact-notice-provider"
const SUMMARY = "## Goal\nPreserve the complete checkpoint."

function fixtureCore(messages: Message[], appendCompact: (record: unknown) => void) {
  const store = {
    appendNote() {},
    appendCompact,
  } as unknown as SessionStore
  return new AgentCore({
    auth: { type: "api-key", token: "fixture" },
    model: MODEL,
    providerId: PROVIDER,
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: {
      async execute() {
        return { content: "", isError: false }
      },
    },
    transcriptSink: { write() {} },
    sessionPersistence: new SessionPersistenceAdapter(store),
    initialMessages: messages,
    sendFn: async function* () {
      return { blocks: [], text: "", stopReason: "end_turn" }
    },
  })
}

function history(): Message[] {
  return Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: "original " + index }],
  }))
}

function checkpointRecord(record: unknown): CompactRecord {
  return JSON.parse(JSON.stringify({ ...(record as object), kind: "compact", ts: "t" }))
}

describe("compact notice contract", () => {
  beforeEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    const provider = registerTestProvider({ id: PROVIDER, models: [{ id: MODEL }] })
    provider.adapter.run = async function* () {
      yield { type: "text_delta", index: 0, text: SUMMARY }
      yield { type: "message_stop" }
    }
  })

  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
  })

  it("does not truncate long summary bodies before Markdown rendering", () => {
    const summary = Array.from(
      { length: 75 },
      (_, index) => "line " + index + " " + "context ".repeat(30),
    ).join("\n")
    const block = buildCompactNoticeBlock(
      {
        reason: "manual",
        kind: "local",
        messagesBefore: 20,
        messagesAfter: 7,
        summaryText: summary,
      },
      { mode: "local", keepTail: 6 },
    )
    expect(block.body?.join("\n")).toBe(summary.trim())
  })

  it("renders the exact committed checkpoint body including focus", async () => {
    const records: unknown[] = []
    const core = fixtureCore(history(), (record) => records.push(record))
    const focus = "Preserve exact paths"
    const stats = await core.compact({ mode: "local", focus })
    const record = checkpointRecord(records[0])
    const content = record.replacementMessages[0].content
    const checkpoint =
      typeof content === "string"
        ? content
        : content.map((block) => (block.type === "text" ? block.text : "")).join("\n")
    const notice = buildCompactNoticeBlock(stats, { mode: "local", keepTail: 6, focus })
    expect(notice.body?.join("\n")).toBe(checkpoint)
  })
})
