/**
 * Driver for the I3 case of `paste-pty.e2e.test.ts` (paste plugin v3, D3).
 *
 * It runs in a real PTY with the REAL ma-paste-plugin (and the sideband
 * codec plugin) and the same wiring as `main.ts`:
 * - `PluginLoader.load` with only these two plugins (links in a temp root);
 * - `loadPluginUi(...pasteUiHost(chain, sideband))`, so `ui.setup` registers
 *   the text hook and the chip label;
 * - `chain.bindSid` and `bootSessionStores` (the CLI boot path), so the
 *   session file exists BEFORE the first message;
 * - the media hook (`createMediaPasteHook`, priority 90), as `live-repl.ts`
 *   registers it, so the plugin hook runs after the real media hook. The
 *   report has the media results (`null` for a text paste);
 * - an `EditorController` with the chain hooks and the chip spans.
 *
 * Then it pastes 129 lines (no message was sent before), presses Enter, and
 * runs one turn of a real `AgentCore` with a stub send on the same store.
 *
 * Exit protocol: one line "PASTE-PLUGIN-PTY" and the base64 of a JSON
 * report (screen bytes after the paste, buffer, submitted text, the files
 * under `<sid>.files/paste/` with their modes, the sent user text, the JSONL).
 *
 * Env: `MINIMAL_AGENT_HOME` (the temp agent home, set by the parent) and
 * `PASTE_PTY_PLUGINS` (the plugins checkout).
 */
import { EventEmitter } from "node:events"
import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs"
import { join } from "node:path"

import { createAgentContext } from "@minimal-agent/core/host/agent-context"
import { getSessionId } from "@minimal-agent/core/host/session-id"
import { sidebandOf } from "@minimal-agent/core/host/sideband"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { defaultSessionsDir } from "@minimal-agent/core/host-kit/session-store"
import { registerTestProvider } from "@minimal-agent/core/testing/provider-fixture"
import { buildTestCore } from "@minimal-agent/core/testing/test-core"

import { EditorController } from "../../editor-controller.ts"
import { createMediaPasteHook } from "../../paste/media-paste.ts"
import { createPasteChain, pasteUiHost } from "../../paste/paste-chain.ts"
import { loadPluginUi } from "../../plugins-ui/ui-loader.ts"
import { bootSessionStores } from "../../startup/session-store-boot.ts"
import { Compositor } from "../../ui/compositor.ts"

const MODEL = "paste-pty-model"
const PROVIDER = "paste-pty-prov"
const LINES = 129

class FakeStdin extends EventEmitter {
  isTTY = true
  encoding: BufferEncoding | null = null
  setEncoding(enc: BufferEncoding): this {
    this.encoding = enc
    return this
  }
  resume(): this {
    return this
  }
  pause(): this {
    return this
  }
  setRawMode(_v: boolean): this {
    return this
  }
  send(chunk: string): void {
    this.emit("data", chunk)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The text of the last user message of a request. */
function lastUserText(messages: Array<{ role: string; content: unknown }>): string {
  const m = [...messages].reverse().find((x) => x.role === "user")
  if (!m) return ""
  if (typeof m.content === "string") return m.content
  return (m.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
}

async function main(): Promise<void> {
  const home = process.env.MINIMAL_AGENT_HOME
  const pluginsDir = process.env.PASTE_PTY_PLUGINS
  if (!home || !pluginsDir) throw new Error("MINIMAL_AGENT_HOME and PASTE_PTY_PLUGINS are required")
  const sessionsDir = defaultSessionsDir()
  const embedded = join(home, "plugins")
  mkdirSync(embedded, { recursive: true })
  for (const dir of ["ma-sideband-plugin", "ma-paste-plugin"]) {
    symlinkSync(join(pluginsDir, dir), join(embedded, dir))
  }
  const none = join(home, "none")
  const logs: string[] = []
  const loader = await PluginLoader.load({
    roots: { embedded: [embedded], user: [none], project: [none] },
    logger: (m) => logs.push(m),
    agent: createAgentContext({
      sessionId: getSessionId(),
      pid: process.pid,
      model: MODEL,
      version: "0",
    }),
    hostOptions: { sessionsDir },
  })
  const sideband = sidebandOf(loader)
  const chain = createPasteChain()
  await loadPluginUi({
    packages: loader.loadedPackages(),
    logger: (m) => logs.push(m),
    ...pasteUiHost(chain, () => sidebandOf(loader)),
  })
  // live-repl.ts registers the media hook (90) after the plugin UI loads.
  const media = createMediaPasteHook()
  const mediaOutcomes: Array<string | null> = []
  chain.hooks.register({
    ...media,
    onPaste: (ev) => {
      const out = media.onPaste(ev)
      mediaOutcomes.push(out === null ? null : out.kind)
      return out
    },
  })
  // The plugin text hook and the media hook.
  const hookCount = chain.hooks.size
  // main.ts order: bind the sid, then boot the session stores.
  const sid = chain.bindSid(getSessionId(), getSessionId)
  const bootOut: string[] = []
  const { store } = await bootSessionStores({
    sid,
    resumeSid: null,
    selectedModel: MODEL,
    providerId: PROVIDER,
    systemHash: "h",
    toolsHash: "h",
    sideband,
    output: { write: (s: string) => (bootOut.push(s), true) } as never,
  })

  let raw = ""
  const compositor = new Compositor({
    output: {
      isTTY: process.stdout.isTTY,
      get columns() {
        return process.stdout.columns
      },
      get rows() {
        return process.stdout.rows
      },
      write: (s: string) => {
        raw += s
        return true
      },
    } as never,
  })
  const stdin = new FakeStdin()
  const editor = new EditorController({
    prompt: "ASK ❯ ",
    continuationPrompt: "  ",
    maxLiveHeight: 12,
    compositor,
    stdin: stdin as never,
    pasteHooks: chain.hooks,
    spanSource: (line) => chain.chips.spansOf(line, sideband),
  })
  chain.chips.subscribe(() => editor.buffer().invalidateSpans())
  let submitted: string | null = null
  editor.on("submit", (text: string) => {
    submitted = text
  })
  compositor.mount()
  editor.start()

  // 129 lines, sent in 8 chunks inside one bracketed paste (CR as the terminal sends it).
  const payload = Array.from({ length: LINES }, (_, i) => `line ${i} of the paste`).join("\r")
  const per = Math.ceil(payload.length / 8)
  await sleep(150)
  stdin.send("\x1b[200~")
  for (let i = 0; i < payload.length; i += per) {
    stdin.send(payload.slice(i, i + per))
    await sleep(10)
  }
  stdin.send("\x1b[201~")
  await sleep(250)
  const screen = raw
  const buffer = editor.buffer().toString()
  stdin.send("\r")
  await sleep(150)
  editor.stop()
  compositor.unmount()

  const filesDir = join(sessionsDir, `${sid}.files`, "paste")
  let files: Array<{ name: string; mode: number; text: string }> = []
  try {
    files = readdirSync(filesDir).map((name) => ({
      name,
      mode: statSync(join(filesDir, name)).mode & 0o777,
      text: readFileSync(join(filesDir, name), "utf8"),
    }))
  } catch {
    // No dir: the report shows no files.
  }

  // One turn of a real AgentCore on the same store, with a stub send.
  registerTestProvider({
    id: PROVIDER,
    models: [{ id: MODEL, capabilities: { contextWindow: 200_000, maxOutputTokens: 8_000 } }],
  })
  const sent: string[] = []
  // A stub send with no stream text: it returns the final response only.
  // oxlint-disable-next-line require-yield
  const sendFn = async function* (opts: { messages: Array<{ role: string; content: unknown }> }) {
    sent.push(lastUserText(opts.messages))
    return {
      blocks: [{ type: "text", text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
  if (submitted !== null && store) {
    const core = await buildTestCore({
      auth: { type: "api-key", token: "t" },
      sendFn: sendFn as never,
      loader,
      model: MODEL,
      providerId: PROVIDER,
      store,
    } as never)
    const gen = core.run(submitted)
    while (!(await gen.next()).done) {
      // drain
    }
  }
  const jsonl = store ? readFileSync(store.path, "utf8") : ""
  const report = {
    sid,
    expected: payload.replace(/\r/g, "\n"),
    screen,
    buffer,
    submitted,
    files,
    sent,
    jsonl,
    logs,
    bootOut,
    hookCount,
    mediaOutcomes,
  }
  process.stdout.write(
    `\nPASTE-PLUGIN-PTY ${Buffer.from(JSON.stringify(report)).toString("base64")}\n`,
  )
  process.exit(0)
}

const keepAlive = setInterval(() => {}, 1_000)
main().catch((e) => {
  clearInterval(keepAlive)
  process.stdout.write(`\nPASTE-PLUGIN-PTY-ERROR ${String(e?.stack ?? e)}\n`)
  process.exit(1)
})
