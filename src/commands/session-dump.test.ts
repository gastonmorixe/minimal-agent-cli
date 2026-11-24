import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { loadSidebandOnly } from "@minimal-agent/core/host/sideband"
import { SIBLING_REPO_ROOT, siblingPluginPresent } from "../test-utils/sibling-repo.ts"
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

// Display of sideband refs in user text (paste plugin display handler).

const PASTE_SID = "dump-display-sid"
const pasteSessions = join(import.meta.dir, ".dump-display-sessions")
const pasteFiles = join(pasteSessions, `${PASTE_SID}.files`, "paste")
const BODY = "line one\nhas ``` fence\nline three\n"

/** True when the codec and the paste plugin are in the sibling checkout. */
const pastePresent = sidebandFixturePresent() && siblingPluginPresent("ma-paste-plugin")

mkdirSync(pasteFiles, { recursive: true })
writeFileSync(join(pasteSessions, `${PASTE_SID}.jsonl`), "")
writeFileSync(join(pasteFiles, "abc12.txt"), BODY)
afterAll(() => rmSync(pasteSessions, { recursive: true, force: true }))

/** The same sideband boot as the `dump` command, over the sibling checkout. */
const dsb = pastePresent
  ? await loadSidebandOnly({
      roots: { embedded: [SIBLING_REPO_ROOT], user: [], project: [] },
      diagnostics: { sessionId: undefined, emit: () => {} } as never,
      display: { hostOptions: { sessionsDir: pasteSessions } },
    })
  : sb

function pasteRef(id: string): string {
  return dsb.render("paste", { attrs: { id, bytes: 1, lines: 1 } })
}

function userSession(content: LoadedSession["messages"][number]["content"]): LoadedSession {
  return { meta: null, messages: [{ role: "user", content }] }
}

describe.skipIf(!pastePresent)("dump display of paste refs", () => {
  test("paste ref shows label and fenced body", () => {
    const md = formatSessionAsMarkdown(userSession(`see ${pasteRef("abc12")} done`), dsb, {
      sid: PASTE_SID,
    })
    expect(md).toBe(
      "## User\n\nsee \n[Paste #abc12 34B 3L]\n````\nline one\nhas ``` fence\nline three\n````\n done\n",
    )
    expect(dsb.has(md, { kinds: ["paste"] })).toBe(false)
    const xml = formatSessionAsXml(
      userSession([{ type: "text", text: `a ${pasteRef("abc12")}` }]),
      dsb,
      {
        sid: PASTE_SID,
      },
    )
    expect(xml).toBe(
      '<session>\n  <turn role="user">\n    <text>a <display kind="paste" label="[Paste #abc12 34B 3L]">line one\nhas ``` fence\nline three\n</display></text>\n  </turn>\n</session>\n',
    )
  })

  test("harness-marked block is not expanded", () => {
    const text = `summary ${pasteRef("abc12")}`
    const s = userSession([{ type: "text", text, sideband: { kind: "compaction" } }])
    const md = formatSessionAsMarkdown(s, dsb, { sid: PASTE_SID })
    expect(md).toBe(`## User\n\n${text}\n`)
    expect(md).not.toContain("line one")
  })

  test("a block with a null sideband mark is user text (the same rule as SessionHistory)", () => {
    const block = { type: "text", text: `a ${pasteRef("abc12")}`, sideband: null }
    const s = userSession([block as never])
    const md = formatSessionAsMarkdown(s, dsb, { sid: PASTE_SID })
    expect(md).toContain("[Paste #abc12 34B 3L]\n````\nline one\n")
    expect(dsb.has(md, { kinds: ["paste"] })).toBe(false)
  })

  test("missing file shows the missing label", () => {
    const s = userSession(`x ${pasteRef("zzz99")} y`)
    expect(formatSessionAsMarkdown(s, dsb, { sid: PASTE_SID })).toBe(
      "## User\n\nx [Paste #zzz99 missing] y\n",
    )
    expect(formatSessionAsXml(s, dsb, { sid: PASTE_SID })).toContain(
      '<display kind="paste" label="[Paste #zzz99 missing]" missing="true"/>',
    )
  })

  test("no sid gives the attrs label", () => {
    const s = userSession(`x ${pasteRef("abc12")} y`)
    expect(formatSessionAsMarkdown(s, dsb)).toBe("## User\n\nx [Paste #abc12 1B 1L] y\n")
  })

  test("a ref inside a user backtick fence: the body gets a tilde fence", () => {
    // A backtick fence as long or longer would close the user fence (CommonMark).
    const s = userSession(`\`\`\`\`\n${pasteRef("abc12")}\n\`\`\`\``)
    const md = formatSessionAsMarkdown(s, dsb, { sid: PASTE_SID })
    expect(md).toBe(
      "## User\n\n````\n[Paste #abc12 34B 3L]\n~~~\nline one\nhas ``` fence\nline three\n~~~\n````\n",
    )
  })
})

describe.skipIf(!sidebandFixturePresent())("dump with no display", () => {
  test("a fake sideband with no display keeps the text byte for byte", () => {
    const fake = { render: sb.render, trailing: sb.trailing }
    const text = `a & <b> ${sb.render("paste", { attrs: { id: "abc12" } })}`
    const s = userSession(text)
    expect(formatSessionAsMarkdown(s, fake, { sid: PASTE_SID })).toBe(`## User\n\n${text}\n`)
    expect(formatSessionAsXml(s, fake)).toContain("<text>a &amp; &lt;b&gt; &lt;ma::")
  })
})

test("xml drops the chars that XML does not allow", () => {
  const s = userSession("a\u0001b\uFFFEc")
  expect(formatSessionAsXml(s, sb)).toContain("<text>abc</text>")
})

/**
 * XML parity with the SessionHistory dump: a C0 char and a lone surrogate in
 * user text and in a tool result. The plugin test
 * `ma-session-history-plugin/lib/dump-display.test.ts` has the same input
 * and the same expected text. Keep the two copies equal. (The cli boundary
 * rule forbids a computed import of the plugin, so each side has a copy.)
 */
test("xml parity: a C0 char and a lone surrogate give the same XML as SessionHistory", () => {
  const s: LoadedSession = {
    meta: null,
    messages: [
      { role: "user", content: "u\u0001s\uD800r" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "c\u0001", content: "x\u0001y\uDC00z" }],
      },
    ],
  }
  expect(formatSessionAsXml(s, sb)).toBe(
    '<session>\n  <turn role="user">\n    <text>usr</text>\n  </turn>\n  <turn role="user">\n    <tool_result tool_use_id="c">\n      <content>xyz</content>\n    </tool_result>\n  </turn>\n</session>\n',
  )
})
