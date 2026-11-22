/**
 * I2 (paste plugin v3, D3): `loadPluginUi` gives a fake plugin's `ui.setup`
 * the CLI extensions. `ctx.paste` and `ctx.chips` are wired to the process
 * registries; a plugin hook priority is clamped to 0..80 (media is 90);
 * `files` is present only with the `sessions:files` capability and a sid,
 * and it is bound to that sid.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NO_SIDEBAND } from "@minimal-agent/core/host/sideband"

import { createPasteChain } from "../paste/paste-chain.ts"
import { clampPluginPriority, PLUGIN_PASTE_PRIORITY_MAX } from "./cli-ui-extensions.ts"
import { loadPluginUi } from "./ui-loader.ts"

const PROBE = "__cliUiExtProbe"
const SID = "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"

interface Probe {
  ctx?: Record<string, unknown>
  events: Array<{ text: string; hasFiles: boolean; sbReady: unknown; create?: string }>
  known: boolean[]
}

/** The fake `ui.setup`: one paste hook (priority 100) and one chip label. */
const SETUP_BODY = `export default function setup(ctx) {
  const probe = (globalThis.${PROBE} ??= { events: [], known: [] })
  probe.ctx = ctx
  ctx.paste?.registerHook({
    id: "text",
    priority: 100,
    onPaste(ev) {
      const e = { text: ev.text, hasFiles: ev.files !== undefined, sbReady: ev.sideband?.ready }
      if (ev.files) e.create = ev.files.create("p1.txt", ev.text)
      probe.events.push(e)
      return ev.text === "pass" ? null : { insert: "PLUGIN" }
    },
  })
  ctx.chips?.register({
    kind: "probe",
    label(attrs, known) {
      probe.known.push(known)
      return "[probe " + attrs.id + "]"
    },
  })
}
`

function probe(): Probe {
  return (globalThis as Record<string, unknown>)[PROBE] as Probe
}

describe("cli ui extensions (I2)", () => {
  let root: string
  let sessionsDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cli-ui-ext-"))
    sessionsDir = join(root, "sessions")
    mkdirSync(sessionsDir, { recursive: true })
    delete (globalThis as Record<string, unknown>)[PROBE]
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    delete (globalThis as Record<string, unknown>)[PROBE]
  })

  function writePlugin(dirName: string, capabilities: string[]): string {
    const dir = join(root, "plugins", dirName)
    mkdirSync(dir, { recursive: true })
    const manifest = {
      id: "probe",
      name: "probe",
      version: "0.1.0",
      description: "t",
      capabilities,
      ui: { setup: { type: "module", path: "./setup.ts", export: "default" } },
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest))
    writeFileSync(join(dir, "setup.ts"), SETUP_BODY)
    return dir
  }

  async function load(opts: { capabilities: string[]; sid?: string; jsonl?: boolean }) {
    const dir = writePlugin(`p-${Math.random().toString(36).slice(2)}`, opts.capabilities)
    if (opts.sid && opts.jsonl !== false) writeFileSync(join(sessionsDir, `${opts.sid}.jsonl`), "")
    const chain = createPasteChain()
    if (opts.sid) chain.bindSid(opts.sid)
    const logs: string[] = []
    await loadPluginUi({
      packages: [{ id: "probe", packageDir: dir }],
      logger: (m) => logs.push(m),
      sideband: () => NO_SIDEBAND,
      paste: chain.hooks,
      chips: chain.chips,
      sid: chain.sid,
      sessionsDir,
    })
    return { chain, logs }
  }

  it("wires ctx.paste and ctx.chips; core fields stay", async () => {
    const { chain, logs } = await load({ capabilities: [] })
    expect(logs).toEqual([])
    const ctx = probe().ctx!
    expect(ctx.pluginId).toBe("probe")
    expect(typeof (ctx.tui as { capability: string }).capability).toBe("string")
    expect(chain.hooks.size).toBe(1)
    const out = chain.hooks.run(chain.hooks.event("hello", "bracketed"))
    expect(out).toEqual({ kind: "insert", text: "PLUGIN" })
    expect(probe().events[0]).toMatchObject({ text: "hello", sbReady: NO_SIDEBAND.ready })
    // null passes the paste on.
    expect(chain.hooks.run(chain.hooks.event("pass", "bracketed"))).toBeNull()
  })

  it("clamps a plugin priority to 0..80: a priority-100 plugin runs after media (90)", async () => {
    const { chain } = await load({ capabilities: [] })
    chain.hooks.register({
      id: "media",
      priority: 90,
      onPaste: () => ({ kind: "insert", text: "MEDIA" }),
    })
    expect(chain.hooks.run(chain.hooks.event("x", "bracketed"))).toEqual({
      kind: "insert",
      text: "MEDIA",
    })
    // A host hook at 81 also runs before the clamped plugin hook (80).
    const chain2 = (await load({ capabilities: [] })).chain
    chain2.hooks.register({
      id: "h81",
      priority: 81,
      onPaste: () => ({ kind: "insert", text: "81" }),
    })
    expect(chain2.hooks.run(chain2.hooks.event("x", "bracketed"))).toEqual({
      kind: "insert",
      text: "81",
    })
    expect(clampPluginPriority(100)).toBe(PLUGIN_PASTE_PRIORITY_MAX)
    expect(clampPluginPriority(-5)).toBe(0)
    expect(clampPluginPriority(Number.NaN)).toBe(0)
    expect(clampPluginPriority(undefined)).toBe(0)
    expect(clampPluginPriority(50)).toBe(50)
  })

  it("gives no files without the sessions:files capability", async () => {
    const { chain } = await load({ capabilities: [], sid: SID })
    chain.hooks.run(chain.hooks.event("hello", "bracketed"))
    expect(probe().events[0]?.hasFiles).toBe(false)
  })

  it("gives no files when no sid exists", async () => {
    const { chain } = await load({ capabilities: ["sessions:files"] })
    chain.hooks.run(chain.hooks.event("hello", "bracketed"))
    expect(probe().events[0]?.hasFiles).toBe(false)
  })

  it("binds files to the sid and the manifest id (0600 under <sid>.files/<id>/)", async () => {
    const { chain } = await load({ capabilities: ["sessions:files"], sid: SID })
    chain.hooks.run(chain.hooks.event("saved text", "bracketed"))
    expect(probe().events[0]).toMatchObject({ hasFiles: true, create: "ok" })
    const file = join(sessionsDir, `${SID}.files`, "probe", "p1.txt")
    expect(existsSync(file)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // A second create of the same name: "exists" (no overwrite).
    chain.hooks.run(chain.hooks.event("other", "bracketed"))
    expect(probe().events[1]?.create).toBe("exists")
  })

  it("a sid with no session file gives files whose create fails (owned rule)", async () => {
    const { chain } = await load({ capabilities: ["sessions:files"], sid: SID, jsonl: false })
    chain.hooks.run(chain.hooks.event("x", "bracketed"))
    expect(probe().events[0]).toMatchObject({ hasFiles: true, create: "error" })
  })

  it("chips.register maps the label; known is the store check of <id>.txt", async () => {
    const { chain } = await load({ capabilities: ["sessions:files"], sid: SID })
    const sb = {
      ready: true,
      find: (text: string) =>
        text.includes("@")
          ? [{ kind: "probe", span: { start: 0, end: text.length }, body: undefined }]
          : [],
      kindInfo: () => ({ placement: "inline", direction: "to-model" }),
      attrs: () => ({ id: "p1" }),
    }
    // No file yet: known is false.
    expect(chain.chips.renderText("@", sb as never)).toBe("[probe p1]")
    expect(probe().known.at(-1)).toBe(false)
    chain.hooks.run(chain.hooks.event("saved", "bracketed"))
    expect(chain.chips.renderText("@", sb as never)).toBe("[probe p1]")
    expect(probe().known.at(-1)).toBe(true)
  })

  it("chips known is true for a plugin with no files", async () => {
    const { chain } = await load({ capabilities: [] })
    const sb = {
      ready: true,
      find: () => [{ kind: "probe", span: { start: 0, end: 1 }, body: undefined }],
      kindInfo: () => ({ placement: "inline", direction: "to-model" }),
      attrs: () => ({ id: "zz" }),
    }
    chain.chips.renderText("@", sb as never)
    expect(probe().known.at(-1)).toBe(true)
  })
})
