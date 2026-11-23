/**
 * Paste refs in the `sessions dump` text. The expected strings are the same
 * as in the twin test of the `SessionHistory` dump
 * (`ma-session-history-plugin/lib/paste-refs.test.ts`): the two dumps must
 * stay equal.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { testSideband as sb, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"
import { formatSessionAsMarkdown, formatSessionAsXml } from "./session-dump.ts"
import { pasteFileReader, pasteMarkdown } from "./session-dump-paste.ts"

const SID = "paste-dump-sid"
const dir = join(import.meta.dir, ".paste-dump-sessions")
const pasteDir = join(dir, `${SID}.files`, "paste")
mkdirSync(pasteDir, { recursive: true })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const BODY = "line one\nhas ``` fence\nline three\n"
writeFileSync(join(pasteDir, "abc12.txt"), BODY)
// A secret next to the sessions dir: a bad id must never reach it.
writeFileSync(join(dir, "secret.txt"), "SECRET")
writeFileSync(join(pasteDir, "ok.txt"), "SECRET")
symlinkSync(join(dir, "secret.txt"), join(pasteDir, "lnk99.txt"))

const read = pasteFileReader(dir, SID)

function ref(id: string): string {
  return sb.render("paste", { attrs: { id, bytes: 1, lines: 1 } })
}

function session(content: string | { type: "text"; text: string }[]) {
  return { meta: null, messages: [{ role: "user" as const, content }] }
}

describe.skipIf(!sidebandFixturePresent())("dump of paste refs", () => {
  test("paste ref with a file: label and body, no raw tag (markdown)", () => {
    const md = formatSessionAsMarkdown(session(`see ${ref("abc12")} done`), sb, {
      readPaste: read,
    })
    expect(md).toBe(
      "## User\n\nsee \n[Paste #abc12 34B 3L]\n````\nline one\nhas ``` fence\nline three\n````\n done\n",
    )
    expect(sb.has(md, { kinds: ["paste"] })).toBe(false)
  })

  test("paste ref with a file in a text block (xml)", () => {
    const xml = formatSessionAsXml(session([{ type: "text", text: `a ${ref("abc12")}` }]), sb, {
      readPaste: read,
    })
    expect(xml).toBe(
      '<session>\n  <turn role="user">\n    <text>a <paste id="abc12" label="[Paste #abc12 34B 3L]">line one\nhas ``` fence\nline three\n</paste></text>\n  </turn>\n</session>\n',
    )
    expect(sb.has(xml, { kinds: ["paste"] })).toBe(false)
  })

  test("missing file: missing label (markdown and xml)", () => {
    const s = session(`x ${ref("zzzzz")} y`)
    expect(formatSessionAsMarkdown(s, sb, { readPaste: read })).toBe(
      "## User\n\nx [Paste #zzzzz missing] y\n",
    )
    const xml = formatSessionAsXml(s, sb, { readPaste: read })
    expect(xml).toContain('<paste id="zzzzz" label="[Paste #zzzzz missing]" missing="true"/>')
    expect(sb.has(xml, { kinds: ["paste"] })).toBe(false)
  })

  test("no reader: each ref shows as missing", () => {
    const md = formatSessionAsMarkdown(session(ref("abc12")), sb)
    expect(md).toContain("Paste #abc12 missing")
    expect(md).not.toContain("line one")
  })

  test("bad id: no file read outside the paste dir", () => {
    for (const id of ["../../secret", "ok", "../ok", "ABC12"]) {
      const md = formatSessionAsMarkdown(session(ref(id)), sb, { readPaste: read })
      expect(md).not.toContain("SECRET")
      expect(md).toContain(`Paste #${id} missing`)
      expect(sb.has(md, { kinds: ["paste"] })).toBe(false)
    }
  })

  test("a symlink in the paste dir is not followed", () => {
    expect(read("lnk99")).toBeNull()
    const md = formatSessionAsMarkdown(session(ref("lnk99")), sb, { readPaste: read })
    expect(md).not.toContain("SECRET")
  })

  test("unsafe sid: the reader finds nothing", () => {
    expect(pasteFileReader(dir, "../x")("abc12")).toBeNull()
  })

  test("assistant text and text with no ref do not change", () => {
    const s = {
      meta: null,
      messages: [
        { role: "user" as const, content: "plain `text`" },
        { role: "assistant" as const, content: [{ type: "text" as const, text: ref("abc12") }] },
      ],
    }
    const md = formatSessionAsMarkdown(s, sb, { readPaste: read })
    expect(md).toContain("plain `text`")
    expect(md).not.toContain("line one")
  })

  test("no codec: the text does not change", () => {
    const t = `a ${ref("abc12")}`
    expect(pasteMarkdown(t, undefined, read)).toBe(t)
  })
})
