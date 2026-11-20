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
import { testSideband as sb, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"
import { fixtures } from "./__fixtures__/session-dump-fixtures.ts"
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
