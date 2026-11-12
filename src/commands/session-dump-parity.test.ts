/**
 * Parity test (old path): the golden files are written from the core
 * `sessions.dump` path on 3 synthetic fixtures. This file runs that path and
 * compares its text with the golden files.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createSessionsReadApi } from "@minimal-agent/core/host/sessions-read"
import { fixtures } from "./__fixtures__/session-dump-fixtures.ts"

const dir = join(import.meta.dir, ".parity-sessions")
mkdirSync(dir, { recursive: true })
afterAll(() => rmSync(dir, { recursive: true, force: true }))
for (const [sid, recs] of Object.entries(fixtures)) {
  writeFileSync(join(dir, `${sid}.jsonl`), `${recs.map((r) => JSON.stringify(r)).join("\n")}\n`)
}
const api = createSessionsReadApi({ dir })

async function render(sid: string, format: "markdown" | "xml"): Promise<string> {
  const r = await api.dump(sid, { format })
  return r ? r.text : ""
}

const goldenPath = (sid: string) => join(import.meta.dir, "__fixtures__", `dump-${sid}.golden.json`)

describe.each(Object.keys(fixtures))("dump parity: %s", (sid) => {
  test("markdown is byte-equal to golden", async () => {
    const g = JSON.parse(readFileSync(goldenPath(sid), "utf8")) as { markdown: string; xml: string }
    expect(await render(sid, "markdown")).toBe(g.markdown)
  })
  test("xml is byte-equal to golden", async () => {
    const g = JSON.parse(readFileSync(goldenPath(sid), "utf8")) as { markdown: string; xml: string }
    expect(await render(sid, "xml")).toBe(g.xml)
  })
})
