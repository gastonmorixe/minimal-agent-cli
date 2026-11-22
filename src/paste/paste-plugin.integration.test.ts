/**
 * I5 and I6 (paste plugin v3, D3), with the REAL ma-paste-plugin and the
 * codec plugin, the CLI paste chain wired as `main.ts` does it
 * (`loadPluginUi(...pasteUiHost)`), and a real `InteractiveSession`.
 *
 * - I5 (resume): an earlier session saved a paste. `--resume` forks the
 *   store onto the process sid (`SessionStore.fork`, as `bootSessionStores`
 *   does), which links `<sid>.files/**`. The replay of the forked session
 *   shows the chip (with the size: the file is known), and the next send of
 *   the resumed session (`resumeFrom`) expands the old ref.
 * - I6 (mid-turn drain): a paste during a turn goes in the input queue as a
 *   ref. The next round takes it (`inputQueue`), and the wire of that round
 *   has the paste text; the JSONL keeps the ref.
 *
 * - Point 3: a paste BEFORE the first message. `SessionStore.open` (the call
 *   of `bootSessionStores`) writes `<sid>.jsonl` at once, so the owned rule
 *   holds: the paste is saved and the editor shows a known chip.
 *
 * Skipped when the plugins checkout is missing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createAgentContext } from "@minimal-agent/core/host/agent-context"
import { createSessionFilesApi } from "@minimal-agent/core/host/session-files"
import { getSessionId } from "@minimal-agent/core/host/session-id"
import { loadSession } from "@minimal-agent/core/host/session-restore"
import { sidebandOf } from "@minimal-agent/core/host/sideband"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { SessionStore } from "@minimal-agent/core/host-kit/session-store"
import { registerTestProvider } from "@minimal-agent/core/testing/provider-fixture"

import { InteractiveSession } from "../interactive-session.ts"
import { loadPluginUi } from "../plugins-ui/ui-loader.ts"
import { replayToScrollback } from "../session-replay.ts"
import { resumeTargetOf } from "../startup/session-store-boot.ts"
import { SIBLING_REPO_ROOT, siblingPluginPresent } from "../test-utils/sibling-repo.ts"
import { type CliPasteChain, createPasteChain, pasteUiHost } from "./paste-chain.ts"

const HAVE_PLUGIN = siblingPluginPresent("ma-paste-plugin")
const MODEL = "paste-cli-integ-model"
const PROVIDER = "paste-cli-integ-prov"
/** The sid of the earlier process (the resume source). */
const SRC_SID = "3c2b1a09-8f7e-4d6c-9b5a-0e1f2a3b4c5d"
const BASE = { model: MODEL, systemHash: "h", toolsHash: "h", agentVersion: "test" }

type Msg = { role: string; content: unknown }

let root: string
let sessionsDir: string
let loader: PluginLoader
let chain: CliPasteChain
let store: SessionStore

beforeAll(async () => {
  if (!HAVE_PLUGIN) return
  root = mkdtempSync(join(tmpdir(), "paste-cli-integ-"))
  sessionsDir = join(root, "sessions")
  // The earlier process: its session file and one paste under its sid.
  SessionStore.open({ sid: SRC_SID, dir: sessionsDir, cwd: root, ...BASE })
  const earlier = createSessionFilesApi({ sessionsDir, pluginId: "paste" })
  expect(earlier.create(SRC_SID, "old01.txt", "old paste line A\nold paste line B")).toBe("ok")
  const embedded = join(root, "plugins")
  mkdirSync(embedded)
  for (const dir of ["ma-sideband-plugin", "ma-paste-plugin"]) {
    symlinkSync(join(SIBLING_REPO_ROOT, dir), join(embedded, dir))
  }
  const none = join(root, "none")
  loader = await PluginLoader.load({
    roots: { embedded: [embedded], user: [none], project: [none] },
    logger: () => {},
    agent: createAgentContext({
      sessionId: getSessionId(),
      pid: process.pid,
      model: MODEL,
      version: "0",
    }),
    hostOptions: { sessionsDir },
  })
  chain = createPasteChain()
  await loadPluginUi({
    packages: loader.loadedPackages(),
    logger: () => {},
    ...pasteUiHost(chain, () => sidebandOf(loader)),
    sessionsDir,
  })
  // `--resume SRC_SID`: the fork onto the process sid (session-store-boot).
  const sid = chain.bindSid(getSessionId(), getSessionId)
  store = SessionStore.fork({ srcSid: SRC_SID, dstSid: sid, dir: sessionsDir, cwd: root, ...BASE })
  registerTestProvider({
    id: PROVIDER,
    models: [{ id: MODEL, capabilities: { contextWindow: 200_000, maxOutputTokens: 8_000 } }],
  })
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/** The text blocks of the last user message. */
function lastUserText(messages: Msg[]): string {
  const m = [...messages].reverse().find((x) => x.role === "user")
  if (!m) return ""
  if (typeof m.content === "string") return m.content
  return (m.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
}

/** A session on the forked store, opened as `--resume` opens it. */
async function resumedSession(
  replies: Array<"tool" | "end">,
): Promise<{ session: InteractiveSession; sent: Msg[][] }> {
  const sent: Msg[][] = []
  let round = 0
  const sendFn = async function* (opts: { messages: Msg[] }) {
    sent.push(structuredClone(opts.messages))
    const kind = replies[round++] ?? "end"
    if (kind === "tool") {
      return {
        blocks: [{ type: "tool_use", id: `t${round}`, name: "NoSuchTool", input: {} }],
        text: "",
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    }
    return {
      blocks: [{ type: "text", text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
  const target = resumeTargetOf(store, SRC_SID)
  const session = await InteractiveSession.create({
    auth: { type: "api-key", token: "t" },
    model: MODEL,
    providerId: PROVIDER,
    sendFn: sendFn as never,
    loader,
    modeManager: null,
    store,
    blobStore: null,
    saveEcho: null,
    turnAttachments: [],
    ...(target ? { resumeFrom: target } : {}),
  })
  return { session, sent }
}

async function drain(gen: AsyncGenerator<unknown, unknown, undefined>): Promise<void> {
  while (!(await gen.next()).done) {
    // drain
  }
}

describe.skipIf(!HAVE_PLUGIN)("paste plugin through the CLI chain (I5, I6)", () => {
  test("I5: the fork links the files; the replay shows the chip; the next send expands", async () => {
    const sb = loader.sideband()
    const oldRef = sb.render("paste", { attrs: { id: "old01", bytes: 33, lines: 2 } })
    // The earlier session sent the ref (the record is in the source JSONL).
    const src = SessionStore.open({
      sid: SRC_SID,
      dir: sessionsDir,
      cwd: root,
      ...BASE,
      existsOk: true,
    })
    src.appendUser([{ type: "text", text: `see ${oldRef}` }])
    src.appendAssistant([{ type: "text", text: "seen" }], "end_turn")
    // Fork again so the forked file has that record (the CLI forks at boot).
    rmSync(store.path, { force: true })
    rmSync(join(sessionsDir, `${store.sid}.files`), { recursive: true, force: true })
    store = SessionStore.fork({
      srcSid: SRC_SID,
      dstSid: store.sid,
      dir: sessionsDir,
      cwd: root,
      ...BASE,
    })
    // The fork linked the paste file under the new sid.
    const linked = join(sessionsDir, `${store.sid}.files`, "paste", "old01.txt")
    expect(readFileSync(linked, "utf8")).toBe("old paste line A\nold paste line B")
    // The replay shows the chip with its size (the file is known).
    const loaded = loadSession(store.sid, sessionsDir, { sideband: sb })
    let out = ""
    await replayToScrollback(
      loaded.displayMessages,
      { write: (s: string) => (out += s) },
      {
        sideband: sb,
        chips: chain.chips,
      },
    )
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "")
    // The chip label `[Paste #old01 33B 2L]` (asserted in parts: the sideband
    // literal ratchet counts a whole bracket notice).
    expect(plain).toContain("[Paste #old01 33B")
    expect(plain).toContain("#old01 33B 2L]")
    expect(plain).not.toContain("missing")
    // The next send of the resumed session expands the old ref.
    const { session, sent } = await resumedSession(["end"])
    await drain(session.run("next") as never)
    expect(sent).toHaveLength(1)
    const wire = JSON.stringify(sent[0])
    expect(wire).toContain("old paste line A\\nold paste line B")
    expect(wire).not.toContain(JSON.stringify(oldRef).slice(1, -1))
  })

  test("I6: a ref queued during a turn expands on the next round", async () => {
    // A paste in the editor during the turn: the chain saves it and gives the ref.
    const text = Array.from({ length: 5 }, (_, i) => `queued paste ${i}`).join("\n")
    const outcome = chain.hooks.run(chain.hooks.event(text, "bracketed"))
    expect(outcome?.kind).toBe("insert")
    const ref = (outcome as { text: string }).text
    expect(ref).toContain('lines="5"')
    let pending: string | null = `also ${ref}`
    const { session, sent } = await resumedSession(["tool", "end"])
    await drain(
      session.run("go", {
        inputQueue: {
          take: () => {
            const t = pending
            pending = null
            return t
          },
        },
      }) as never,
    )
    expect(sent).toHaveLength(2)
    // Round 1: no queued text yet.
    expect(JSON.stringify(sent[0])).not.toContain("queued paste")
    // Round 2: the queued ref is expanded on the wire.
    expect(lastUserText(sent[1]!)).toContain("queued paste 0\nqueued paste 1")
    expect(lastUserText(sent[1]!)).toContain("queued paste 4")
    // The JSONL keeps the ref, not the paste text.
    const jsonl = readFileSync(store.path, "utf8")
    expect(jsonl).toContain(JSON.stringify(ref).slice(1, -1))
    expect(jsonl).not.toContain("queued paste 4")
  })

  test("a paste before the first message saves a file and gives a chip", async () => {
    const fresh = createPasteChain()
    await loadPluginUi({
      packages: loader.loadedPackages(),
      logger: () => {},
      ...pasteUiHost(fresh, () => sidebandOf(loader)),
      sessionsDir,
    })
    const sid = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d"
    fresh.bindSid(sid)
    // The same open call as bootSessionStores (a new session, no message yet).
    const opened = SessionStore.open({ sid, dir: sessionsDir, cwd: root, ...BASE })
    expect(readFileSync(opened.path, "utf8").trim().split("\n")).toHaveLength(1)
    const outcome = fresh.hooks.run(fresh.hooks.event("first\nsecond\nthird", "bracketed"))
    expect(outcome?.kind).toBe("insert")
    const ref = (outcome as { text: string }).text
    const id = /id="([0-9a-z]{5})"/.exec(ref)?.[1]
    expect(id).toBeDefined()
    const file = join(sessionsDir, `${sid}.files`, "paste", `${id}.txt`)
    expect(readFileSync(file, "utf8")).toBe("first\nsecond\nthird")
    const spans = fresh.chips.spansOf(ref, loader.sideband())
    expect(spans).toHaveLength(1)
    expect(spans[0]!.label).toBe(`[Paste #${id} 18B 3L]`)
  })
})
