/**
 * 15e.3: every typed compaction error, fallback code and `/compact` argv code
 * renders a non-empty CLI line, built from the fields only.
 */
import { describe, expect, test } from "bun:test"

import {
  CompactBusyError,
  CompactModeUnsupportedError,
  CompactRaceError,
  CompactSendPolicyError,
  CompactSummaryStreamError,
  LifecycleDeniedError,
} from "@minimal-agent/core/errors"
import type { CompactFailure, CompactStats } from "@minimal-agent/core/host/compact-contract"
import { parseCompactArgs } from "@minimal-agent/core/host/compact-contract"

import { buildCompactNoticeBlock, createCompactHostCommand } from "../commands/compact.ts"
import {
  compactArgsErrorText,
  compactFailureText,
  createCliErrorRegistry,
  errorEventText,
  errorText,
  failureText,
} from "./core-text.ts"

const ERRORS = [
  new CompactBusyError(),
  new CompactRaceError(),
  new CompactModeUnsupportedError("fork"),
  new CompactSendPolicyError("TypeError"),
  new CompactSummaryStreamError({ retryable: false }),
  new CompactSummaryStreamError({
    retryable: true,
    category: "api",
    upstreamType: "overloaded_error",
    detail: "boom",
  }),
]

describe("typed compaction errors: CLI text", () => {
  for (const err of ERRORS) {
    test(`${err.kind} renders non-empty (message is "")`, () => {
      expect(err.message).toBe("")
      const text = errorText(err)
      expect(text.trim().length).toBeGreaterThan(0)
      expect(text).not.toBe(err.kind)
      // The JSON form and the error event form give the same text.
      expect(createCliErrorRegistry().render(err.toJSON())).toBe(text)
      const json = err.toJSON()
      expect(errorEventText({ message: "", error: { kind: json.kind, fields: json.fields } })).toBe(
        text,
      )
      expect(failureText("compact failed", err)).toBe(`compact failed: ${text}`)
    })
  }

  test("texts carry the facts", () => {
    expect(errorText(new CompactModeUnsupportedError("fork"))).toContain("SessionStore.fork")
    expect(errorText(new CompactSendPolicyError("TypeError"))).toContain("TypeError")
    const stream = errorText(
      new CompactSummaryStreamError({ retryable: true, category: "api", detail: "boom" }),
    )
    expect(stream).toContain("retryable: yes")
    expect(stream).toContain("category: api")
    expect(stream).toContain("boom")
  })
})

describe("CompactFailure codes: CLI text", () => {
  const failures: CompactFailure[] = [
    { code: "send_denied" },
    { code: "send_denied", reason: "no" },
    { code: "remote_unavailable" },
    { code: "unknown_model", model: "m-x" },
    { code: "empty_summary" },
    { code: "request_failed" },
    { code: "request_failed", detail: "HTTP 500" },
    { code: "request_failed", error: new CompactSendPolicyError("Error").toJSON() },
    { code: "request_failed", error: { kind: "SomeFutureError", fields: {} } },
    {
      code: "request_failed",
      error: new LifecycleDeniedError({ hook: "message.willSend" }).toJSON(),
    },
  ]
  for (const f of failures) {
    test(`${JSON.stringify(f)} renders non-empty`, () => {
      expect(compactFailureText(f).trim().length).toBeGreaterThan(0)
    })
  }

  test("facts appear in the text", () => {
    expect(compactFailureText({ code: "send_denied", reason: "no" })).toContain(": no")
    expect(compactFailureText({ code: "unknown_model", model: "m-x" })).toContain('"m-x"')
    expect(compactFailureText({ code: "unknown_model", model: "m-x" })).toBe(
      'the model "m-x" is unknown',
    )
    // No model fact: a model-free text, never `""`.
    expect(compactFailureText({ code: "unknown_model" })).toBe("the model is unknown")
    expect(compactFailureText({ code: "unknown_model", model: " " })).toBe("the model is unknown")
    expect(compactFailureText({ code: "request_failed", detail: "HTTP 500" })).toBe("HTTP 500")
    expect(
      compactFailureText({
        code: "request_failed",
        error: { kind: "SomeFutureError", fields: {} },
      }),
    ).toBe("SomeFutureError")
  })

  test("the /compact footer renders a code with no text facts", () => {
    const stats: CompactStats = {
      reason: "manual",
      kind: "local",
      messagesBefore: 4,
      messagesAfter: 2,
      summaryError: { code: "send_denied" },
    }
    const block = buildCompactNoticeBlock(stats, { mode: "local", keepTail: 6 })
    expect(block.footer).toBe("summary failed: the send policy hook denied the request")
    const remote = buildCompactNoticeBlock(
      { ...stats, summaryError: undefined, remoteError: { code: "remote_unavailable" } },
      { mode: "remote", keepTail: 6 },
    )
    expect(remote.footer).toStartWith("remote unavailable: remote compaction is not available")
  })
})

describe("/compact argv codes: CLI text", () => {
  test.each(["bogus", "local tail", "mode=wide", "tail=x", "zap=1"])("%s", (argv) => {
    const parsed = parseCompactArgs(argv)
    expect(parsed.error).toBeDefined()
    if (parsed.error === undefined) return
    expect(compactArgsErrorText(parsed.error)).toStartWith("/compact: ")
    expect(compactArgsErrorText(parsed.error)).toContain(parsed.error.value ?? parsed.error.token)
  })

  test("the host command returns the rendered argv error", async () => {
    const cmd = createCompactHostCommand({
      compact: async () => {
        throw new Error("not called")
      },
    })
    const result = await cmd.invoke({ argv: "tail=x", rawLine: "/compact tail=x" } as never)
    expect(result).toEqual({
      kind: "error",
      message: '/compact: tail must be an integer >= 0 (got "x")',
    })
  })

  test("a compaction failure still returns an error result with text (fork)", async () => {
    const cmd = createCompactHostCommand({
      compact: async () => {
        throw new CompactModeUnsupportedError("fork")
      },
    })
    const result = await cmd.invoke({ argv: "fork", rawLine: "/compact fork" } as never)
    expect(result.kind).toBe("error")
    const message = (result as { message: string }).message
    expect(message).toStartWith("compact failed: compact mode fork is not available")
  })
})
