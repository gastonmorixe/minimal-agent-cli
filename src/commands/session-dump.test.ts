import { expect, test } from "bun:test"
import { testSideband as sb, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"
import {
  formatSessionAsMarkdown,
  formatSessionAsXml,
  type DumpSessionData as LoadedSession,
} from "./session-dump.ts"

const mockSession: LoadedSession = {
  meta: {
    kind: "meta",
    formatVersion: 1,
    sid: "test-sid-123",
    model: "test-model",
    createdAt: "2026-05-03T00:00:00Z",
    cwd: "/test/cwd",
    systemHash: "abc",
    toolsHash: "def",
    agentVersion: "1.0",
  },
  messages: [
    {
      role: "user",
      content: "Hello",
    },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "I need to say hi",
          signature: "sig123",
        },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: { command: "echo hi" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "hi",
          is_error: false,
        },
      ],
    },
  ],
}

test("formatSessionAsMarkdown", () => {
  const md = formatSessionAsMarkdown(mockSession, sb)
  expect(md).toContain("# Session: test-sid-123")
  expect(md).toContain("## User")
  expect(md).toContain("## Assistant")
  expect(md).toContain("> 🤔 **Thinking**")
  expect(md).toContain("> I need to say hi")
  expect(md).toContain("> 🛠️ **Tool Use**: `Bash` (id: toolu_1)")
  expect(md).toContain("> 🔙 **Tool Result**: (id: toolu_1)")
  expect(md).toContain("hi")
})

test("formatSessionAsXml", () => {
  const xml = formatSessionAsXml(mockSession, sb)
  expect(xml).toContain('<session id="test-sid-123"')
  expect(xml).toContain('<turn role="user">')
  expect(xml).toContain("<text>Hello</text>")
  expect(xml).toContain('<turn role="assistant">')
  expect(xml).toContain("<thinking>I need to say hi</thinking>")
  expect(xml).toContain('<tool_use name="Bash" id="toolu_1">')
  expect(xml).toContain("<input>{&quot;command&quot;:&quot;echo hi&quot;}</input>")
  expect(xml).toContain('<tool_result tool_use_id="toolu_1">')
  expect(xml).toContain("<content>hi</content>")
})

const mockSessionRedacted: LoadedSession = {
  meta: null,
  messages: [
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
          signature: "very-long-signature-xyz",
        },
      ],
    },
  ],
}

test("formatSessionAsMarkdown redacted thinking", () => {
  const md = formatSessionAsMarkdown(mockSessionRedacted, sb)
  expect(md).toContain("> 🤔 **Thinking**")
  expect(md).toContain("*(Redacted thinking, signature: very-long-signat...)*")
})

test("formatSessionAsXml redacted thinking", () => {
  const xml = formatSessionAsXml(mockSessionRedacted, sb)
  expect(xml).toContain('<thinking signature="very-long-signature-xyz"/>')
})

test.skipIf(!sidebandFixturePresent())(
  "formatSessionAsMarkdown scrubs data-URIs in tool_result text",
  () => {
    const payload = "A".repeat(400)
    const uri = `data:image/png;base64,${payload}`
    const session: LoadedSession = {
      meta: null,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: `page body\n\n![x](${uri})\n\ndone`,
              is_error: false,
            },
          ],
        },
      ],
    }
    const md = formatSessionAsMarkdown(session, sb)
    expect(md).not.toContain(";base64,")
    expect(md).not.toContain(payload.slice(0, 40))
    expect(md).toContain("<ma::agent::redacted-asset")
    expect(md).toContain("page body")
    expect(md).toContain("done")
  },
)

test.skipIf(!sidebandFixturePresent())(
  "formatSessionAsXml scrubs data-URIs in tool_result text",
  () => {
    const payload = "B".repeat(400)
    const uri = `data:image/jpeg;base64,${payload}`
    const session: LoadedSession = {
      meta: null,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_2",
              content: `img ${uri}`,
              is_error: false,
            },
          ],
        },
      ],
    }
    const xml = formatSessionAsXml(session, sb)
    expect(xml).not.toContain(";base64,")
    expect(xml).toContain("redacted-asset")
  },
)
