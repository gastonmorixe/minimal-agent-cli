/**
 * Parity test: the CLI dump text must stay byte-equal to the golden files.
 * The golden files were written from the old core path (`sessions.dump`, now
 * removed) on 3 synthetic fixtures. The text now comes from `records()` data
 * and the local formatter.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createSessionsReadApi } from "@minimal-agent/core/host/sessions-read"
import { loadSidebandOnly } from "@minimal-agent/core/host/sideband"
import { SIBLING_REPO_ROOT, siblingPluginPresent } from "../test-utils/sibling-repo.ts"
import { testSideband as sb, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"
import {
  fixtures,
  PASTE_FX,
  pasteFiles,
  pasteFixture,
} from "./__fixtures__/session-dump-fixtures.ts"
import { formatSessionAsMarkdown, formatSessionAsXml } from "./session-dump.ts"

const dir = join(import.meta.dir, ".parity-sessions")
mkdirSync(dir, { recursive: true })
afterAll(() => rmSync(dir, { recursive: true, force: true }))
for (const [sid, recs] of Object.entries(fixtures)) {
  writeFileSync(join(dir, `${sid}.jsonl`), `${recs.map((r) => JSON.stringify(r)).join("\n")}\n`)
}
const api = createSessionsReadApi({ dir })

async function render(sid: string, format: "markdown" | "xml"): Promise<string> {
  const r = await api.records(sid)
  if (!r) return ""
  return format === "xml" ? formatSessionAsXml(r, sb) : formatSessionAsMarkdown(r, sb)
}

const goldenPath = (sid: string) => join(import.meta.dir, "__fixtures__", `dump-${sid}.golden.json`)

// The codec renders the data-URI stubs: the goldens need the real codec.
describe.skipIf(!sidebandFixturePresent()).each(Object.keys(fixtures))("dump parity: %s", (sid) => {
  test("markdown is byte-equal to golden", async () => {
    const g = JSON.parse(readFileSync(goldenPath(sid), "utf8")) as { markdown: string; xml: string }
    expect(await render(sid, "markdown")).toBe(g.markdown)
  })
  test("xml is byte-equal to golden", async () => {
    const g = JSON.parse(readFileSync(goldenPath(sid), "utf8")) as { markdown: string; xml: string }
    expect(await render(sid, "xml")).toBe(g.xml)
  })
})

// Paste case (A5): the display handler of the sibling paste plugin reads the
// paste files under `.parity-sessions/fx-paste.files/paste/`. The plugin twin
// of this test must give the same text for the same session.

const pastePresent = sidebandFixturePresent() && siblingPluginPresent("ma-paste-plugin")
const pasteDir = join(dir, `${PASTE_FX}.files`, "paste")
mkdirSync(pasteDir, { recursive: true })
for (const [id, text] of Object.entries(pasteFiles))
  writeFileSync(join(pasteDir, `${id}.txt`), text)

/** The same sideband boot as the `dump` command, over the sibling checkout. */
const dsb = pastePresent
  ? await loadSidebandOnly({
      roots: { embedded: [SIBLING_REPO_ROOT], user: [], project: [] },
      diagnostics: { sessionId: undefined, emit: () => {} } as never,
      display: { hostOptions: { sessionsDir: dir } },
    })
  : sb
const pasteRecs = pasteFixture((id) => dsb.render("paste", { attrs: { id, bytes: 1, lines: 1 } }))
writeFileSync(
  join(dir, `${PASTE_FX}.jsonl`),
  `${pasteRecs.map((r) => JSON.stringify(r)).join("\n")}\n`,
)

async function renderPaste(format: "markdown" | "xml"): Promise<string> {
  const r = await api.records(PASTE_FX)
  if (!r) return ""
  const opts = { sid: PASTE_FX }
  return format === "xml" ? formatSessionAsXml(r, dsb, opts) : formatSessionAsMarkdown(r, dsb, opts)
}

describe.skipIf(!pastePresent)(`dump parity: ${PASTE_FX}`, () => {
  for (const format of ["markdown", "xml"] as const) {
    test(`${format} is byte-equal to golden`, async () => {
      const out = await renderPaste(format)
      if (process.env.UPDATE_DUMP_GOLDEN === "1") {
        const g = { markdown: await renderPaste("markdown"), xml: await renderPaste("xml") }
        writeFileSync(goldenPath(PASTE_FX), `${JSON.stringify(g, null, 2)}\n`)
      }
      const g = JSON.parse(readFileSync(goldenPath(PASTE_FX), "utf8")) as Record<string, string>
      expect(out).toBe(g[format] ?? "")
    })
  }

  test("only the compaction ref stays raw", async () => {
    const md = await renderPaste("markdown")
    const raw = dsb.find(md, { kinds: ["paste"] })
    expect(raw.length).toBe(1)
    expect(md).toContain("summary <")
  })
})
