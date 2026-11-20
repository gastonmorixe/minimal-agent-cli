/**
 * Design step 13: the CLI gives the loader's one sideband API to the two
 * paths that did not get it before.
 *
 * 1. The turn-attachment factories (`main.ts` →
 *    `instantiateSessionTurnAttachments(loader, sid, logger)`).
 * 2. The session core (`interactive-session.ts`, `textProvidersOf`):
 *    `AgentCore.sideband` is the same object as `loader.sideband()`.
 *
 * @module interactive-session.sideband-wiring.test
 */

import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AuthResult } from "@minimal-agent/core/host/auth"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"

import { InteractiveSession, textProvidersOf } from "./interactive-session.ts"
import { instantiateSessionTurnAttachments } from "./startup/turn-attachment-context.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const SEEN_KEY = "__cliTurnAttachmentSidebandSeen"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete (globalThis as Record<string, unknown>)[SEEN_KEY]
})

/** A plugin with one turn-attachment factory that records its context. */
function writeProbe(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-sideband-wiring-"))
  dirs.push(root)
  const pluginsDir = join(root, "plugins")
  const dir = join(pluginsDir, "sb-wiring-probe")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "sb-wiring-probe",
      name: "sb-wiring-probe",
      version: "0.1.0",
      description: "test",
      headless: {
        turnAttachments: [
          { id: "probe", handler: { type: "module", path: "./attach.ts", export: "default" } },
        ],
      },
    }),
  )
  writeFileSync(
    join(dir, "attach.ts"),
    `export default (ctx) => {
  globalThis.${SEEN_KEY} = ctx
  return { toAttachment: () => null }
}`,
  )
  return pluginsDir
}

describe("sideband wiring (design step 13)", () => {
  it("each turn-attachment factory gets the same object as loader.sideband()", async () => {
    const loader = await PluginLoader.load({
      roots: { embedded: [writeProbe()] },
      logger: () => {},
    })
    const logs: string[] = []
    await instantiateSessionTurnAttachments(loader, "sid-wiring", (m) => logs.push(m))
    const seen = (globalThis as Record<string, unknown>)[SEEN_KEY] as
      | { sessionId: unknown; sideband: unknown }
      | undefined
    expect({ seen: seen !== undefined, logs }).toEqual({ seen: true, logs: [] })
    expect(seen?.sessionId).toBe("sid-wiring")
    expect(seen?.sideband).toBe(loader.sideband())
  })

  it("textProvidersOf gives the loader's sideband API; an explicit one wins", async () => {
    const loader = await PluginLoader.load({ roots: { embedded: [] }, logger: () => {} })
    expect(textProvidersOf({ loader }).sideband).toBe(loader.sideband())
    const explicit = loader.sideband()
    expect(textProvidersOf({ loader: null, sideband: explicit }).sideband).toBe(explicit)
    expect(textProvidersOf({ loader: null }).sideband).toBeUndefined()
  })

  it("AgentCore.sideband is the same object as loader.sideband()", async () => {
    const loader = await PluginLoader.load({ roots: { embedded: [] }, logger: () => {} })
    const session = await InteractiveSession.create({
      auth: AUTH,
      model: "test-model",
      loader,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
      writeTranscript: () => {},
    })
    expect(session.agentCore().sideband).toBe(loader.sideband())
  })
})
