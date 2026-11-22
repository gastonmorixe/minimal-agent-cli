/**
 * I2 (paste plugin v3, D3): `loadPluginUi` gives a fake plugin's `ui.setup`
 * the CLI extensions. `ctx.paste` and `ctx.chips` are wired to the process
 * registries; a plugin hook priority is clamped to 0..80 (media is 90);
 * `files` is present only with the `sessions:files` capability and a sid,
 * and it is bound to that sid. `ctx.paste` needs the `ui:paste` permission;
 * a chip registers only for a kind that the plugin owns; every plugin gets
 * `ctx.log` (source `plugin.<id>.<source>`). The facts come from the
 * accepted package (validated values), not from the raw manifest.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NO_SIDEBAND } from "@minimal-agent/core/host/sideband"
import type { Diagnostics } from "@minimal-agent/core/host-kit/media"

import { createPasteChain } from "../paste/paste-chain.ts"
import { PasteHookRegistry } from "../paste/paste-hooks.ts"
import {
  type CliUiHost,
  clampPluginPriority,
  cliUiExtensions,
  PLUGIN_PASTE_PRIORITY_MAX,
} from "./cli-ui-extensions.ts"
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

  async function load(opts: {
    capabilities: string[]
    permissions?: string[]
    sidebandKinds?: string[]
    sid?: string
    jsonl?: boolean
  }) {
    const dir = writePlugin(`p-${Math.random().toString(36).slice(2)}`, opts.capabilities)
    if (opts.sid && opts.jsonl !== false) writeFileSync(join(sessionsDir, `${opts.sid}.jsonl`), "")
    const chain = createPasteChain()
    if (opts.sid) chain.bindSid(opts.sid)
    const logs: string[] = []
    await loadPluginUi({
      packages: [
        {
          id: "probe",
          packageDir: dir,
          capabilities: opts.capabilities,
          permissions: opts.permissions ?? ["ui:paste"],
          sidebandKinds: opts.sidebandKinds ?? ["probe"],
        },
      ],
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

  it("uses the validated package facts, not the raw manifest JSON", async () => {
    // The raw manifest has id "probe" and sessions:files; the validated
    // package has another id and no capability.
    const dir = writePlugin("p-raw", ["sessions:files"])
    writeFileSync(join(sessionsDir, `${SID}.jsonl`), "")
    const chain = createPasteChain()
    chain.bindSid(SID)
    await loadPluginUi({
      packages: [
        {
          id: "valid-id",
          packageDir: dir,
          capabilities: [],
          permissions: ["ui:paste"],
          sidebandKinds: [],
        },
      ],
      logger: () => {},
      paste: chain.hooks,
      chips: chain.chips,
      sid: chain.sid,
      sessionsDir,
    })
    chain.hooks.run(chain.hooks.event("hello", "bracketed"))
    expect(probe().ctx!.pluginId).toBe("valid-id")
    expect(probe().events[0]?.hasFiles).toBe(false)
  })

  it("gives no ctx.paste without the ui:paste permission", async () => {
    const { chain } = await load({ capabilities: [], permissions: [] })
    const ctx = probe().ctx!
    expect(ctx.paste).toBeUndefined()
    expect(chain.hooks.size).toBe(0)
    // ctx.log and ctx.chips stay.
    expect(typeof (ctx.log as { warn: unknown }).warn).toBe("function")
    expect(ctx.chips).toBeDefined()
  })

  it("an empty insert is treated as null with one warning (never drop content)", () => {
    const warns: string[] = []
    const paste = new PasteHookRegistry({ diagnostics: fakeDiagnostics(warns) })
    const ext = cliUiExtensions({ paste }, plugin({ permissions: ["ui:paste"] }), () => {})
    ext.paste!.registerHook({ id: "empty", onPaste: () => ({ insert: "" }) })
    expect(paste.run(paste.event("keep me", "bracketed"))).toBeNull()
    expect(warns).toEqual(["paste.hook_empty"])
  })
})

/** A plugin fact set; every list is empty by default. */
function plugin(over: Partial<Parameters<typeof cliUiExtensions>[1]> = {}) {
  return { id: "x", capabilities: [], permissions: [], sidebandKinds: [], ...over }
}

/** Diagnostics that record the source of each warning. */
function fakeDiagnostics(warns: string[], data: unknown[] = []): Diagnostics {
  return {
    warn: (source: string, _m: string, d?: unknown) => {
      warns.push(source)
      data.push(d)
    },
  } as unknown as Diagnostics
}

/** A one-node sideband: every text is one `kind` node with attrs `{ id }`. */
function oneNode(kind: string, id = "p1") {
  return {
    ready: true,
    find: (text: string) => [{ kind, span: { start: 0, end: text.length }, body: undefined }],
    kindInfo: () => ({ placement: "inline", direction: "to-model" }),
    attrs: () => ({ id }),
  } as never
}

describe("cli ui extensions: ownership, log and the known cache", () => {
  it("ctx.log: source plugin.<id>.<source>, for a plugin with no ui:paste too", () => {
    const warns: string[] = []
    const data: unknown[] = []
    const paste = new PasteHookRegistry({ diagnostics: fakeDiagnostics(warns, data) })
    const ext = cliUiExtensions({ paste }, plugin({ id: "acme" }), () => {})
    expect(ext.paste).toBeUndefined()
    ext.log!.warn("parse", "bad")
    expect(warns).toEqual(["plugin.acme.parse"])
    expect(data).toEqual([{ plugin: "acme" }])
  })

  it("ctx.log exists with no paste chain and no chips", () => {
    const ext = cliUiExtensions({}, plugin(), () => {})
    expect(() => ext.log!.warn("s", "m")).not.toThrow()
  })

  it("plugin X cannot change the label of a kind that plugin Y owns; the owner can", () => {
    const warns: string[] = []
    const paste = new PasteHookRegistry({ diagnostics: fakeDiagnostics(warns) })
    const chips = createPasteChain().chips
    const host: CliUiHost = { paste, chips }
    const owner = cliUiExtensions(
      host,
      plugin({ id: "y", sidebandKinds: ["intercom-peer"] }),
      () => {},
    )
    const thief = cliUiExtensions(host, plugin({ id: "x", sidebandKinds: ["paste"] }), () => {})
    owner.chips!.register({ kind: "intercom-peer", label: () => "OWNER" })
    const off = thief.chips!.register({ kind: "intercom-peer", label: () => "THIEF" })
    expect(chips.renderText("@", oneNode("intercom-peer"))).toBe("OWNER")
    expect(warns).toEqual(["plugin.x.chips.kind_not_owned"])
    off()
    expect(chips.renderText("@", oneNode("intercom-peer"))).toBe("OWNER")
    // The owner can change its own label.
    owner.chips!.register({ kind: "intercom-peer", label: () => "OWNER2" })
    expect(chips.renderText("@", oneNode("intercom-peer"))).toBe("OWNER2")
    expect(warns).toHaveLength(1)
  })
})

describe("chip known cache (one stat for each (sid, id))", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cli-ui-known-"))
    writeFileSync(join(root, `${SID}.jsonl`), "")
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** A plugin with files whose hook saves `p2.txt` and whose chip records `known`. */
  function withFiles() {
    const chain = createPasteChain()
    chain.bindSid(SID)
    const host: CliUiHost = {
      paste: chain.hooks,
      chips: chain.chips,
      sid: chain.sid,
      sessionsDir: root,
    }
    const ext = cliUiExtensions(
      host,
      plugin({
        id: "probe",
        capabilities: ["sessions:files"],
        permissions: ["ui:paste"],
        sidebandKinds: ["probe"],
      }),
      () => {},
    )
    const known: boolean[] = []
    ext.paste!.registerHook({
      id: "save",
      onPaste: (ev) => (ev.files ? { insert: ev.files.create("p2.txt", ev.text) } : null),
    })
    ext.chips!.register({
      kind: "probe",
      label: (_a, k) => {
        known.push(k)
        return "chip"
      },
    })
    return { chain, known }
  }

  it("a miss does one stat and caches it: a file made later is not seen", () => {
    const { chain, known } = withFiles()
    chain.chips.renderText("@", oneNode("probe", "p1"))
    // A stat on each paint would now see the file. The cache keeps false.
    mkdirSync(join(root, `${SID}.files`, "probe"), { recursive: true })
    writeFileSync(join(root, `${SID}.files`, "probe", "p1.txt"), "x")
    for (let i = 0; i < 4; i++) chain.chips.renderText("@", oneNode("probe", "p1"))
    expect(known).toEqual([false, false, false, false, false])
  })

  it("the plugin's own create sets known to true with no stat", () => {
    const { chain, known } = withFiles()
    expect(chain.hooks.run(chain.hooks.event("body", "bracketed"))).toEqual({
      kind: "insert",
      text: "ok",
    })
    // Remove the file: a stat would give false. The cache gives true.
    rmSync(join(root, `${SID}.files`, "probe", "p2.txt"))
    for (let i = 0; i < 3; i++) chain.chips.renderText("@", oneNode("probe", "p2"))
    expect(known).toEqual([true, true, true])
  })
})
