/**
 * Design step 8: an old session holds a runtime attachment block with no
 * `sideband` marker (it was written before the marker). The replay finds it
 * only through the codec of the sideband API. With the codec (the resume
 * path passes `sidebandOf(loader)`), the block is hidden in the scrollback.
 * With `NO_SIDEBAND`, only a marked block is hidden.
 *
 * The block text comes from the codec (`render`), so the test holds no tag
 * literal.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NO_SIDEBAND, type SidebandReader } from "@minimal-agent/core/host/sideband"
import { SessionStore } from "@minimal-agent/core/host-kit/session-store"

import { replayToScrollback } from "./session-replay.ts"
import { loadResumeState } from "./startup/resume-load.ts"
import { sidebandFixturePresent, testSideband } from "./test-utils/sideband-fixture.ts"

const ANSI_RE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "")

const SECRET = "old-memory-entry-xyz"
const HUMAN = "what is the next step"
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)
const at = (s: number) => new Date(T0 + s * 1000)

const homes: string[] = []
const prevHome = process.env.MINIMAL_AGENT_HOME
afterEach(() => {
  if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = prevHome
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

/** Write an old session: one user turn with an UNMARKED attachment block. */
function writeOldSession(dir: string, sid: string): void {
  const store = SessionStore.open({
    sid,
    dir,
    model: "test-model",
    cwd: "/tmp",
    systemHash: "h",
    toolsHash: "h",
    agentVersion: "test",
    now: () => at(0),
  })
  const attachment = testSideband.render("short-term-memory", { body: SECRET })
  // No `sideband` key on the block: the form of a session from before the marker.
  store.appendUser(
    [
      { type: "text", text: attachment },
      { type: "text", text: HUMAN },
    ],
    at(1),
  )
  store.appendAssistant([{ type: "text", text: "ok" }], "end_turn", undefined, at(2))
}

/** Resume the old session through the CLI path and replay it to plain text. */
async function replayOld(sb: SidebandReader): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "cli-unmarked-"))
  homes.push(home)
  process.env.MINIMAL_AGENT_HOME = home
  const sid = "unmarked-old"
  writeOldSession(join(home, "sessions"), sid)
  const state = loadResumeState(sid, process.env, sb)
  let out = ""
  await replayToScrollback(
    state.displayMessages,
    { write: (s: string) => (out += s) },
    { userTimestamps: state.userTimestamps, toolPresentation: new Map(), sideband: sb },
  )
  return stripAnsi(out)
}

describe.skipIf(!sidebandFixturePresent())("replay of an unmarked runtime attachment block", () => {
  it("is hidden when the API has the codec", async () => {
    const plain = await replayOld(testSideband)
    expect(plain).toContain(HUMAN)
    expect(plain).not.toContain(SECRET)
  })

  it("leaks with NO_SIDEBAND (no codec reads the tag): the codec is necessary", async () => {
    const plain = await replayOld(NO_SIDEBAND)
    expect(plain).toContain(HUMAN)
    expect(plain).toContain(SECRET)
  })
})
