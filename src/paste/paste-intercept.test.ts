/**
 * The media paste interceptor: drag-drop paths to tokens, the model gate and
 * the rejection text. Moved from core (`media/wiring.test.ts`,
 * `media/per-model-input.test.ts`, `sdk/agent-core.runtime-text.test.ts`) with
 * the code (paste plugin v3, phase A).
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearModelRegistry,
  clearProviderRegistry,
  registerModel,
  registerProvider,
} from "@minimal-agent/core/host/model-registry"
import {
  createMediaRegistry,
  type Diagnostics,
  parseMediaTokens,
  type SyntheticTextResolver,
} from "@minimal-agent/core/host-kit/media"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"

import { mediaPasteInterceptor } from "./paste-intercept.ts"

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = w
  b[23] = h
  return b
}

const dirs: string[] = []
async function tmpFile(name: string, bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "media-wire-"))
  dirs.push(dir)
  const p = join(dir, name)
  await writeFile(p, bytes)
  return p
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

afterEach(() => {
  clearModelRegistry()
  clearProviderRegistry()
})

/** Register `id` with these modalities on a stub provider with no media hook. */
function registerPasteModel(
  id: string,
  modalities: { image: boolean; audio: boolean; pdf: boolean; video: boolean },
): void {
  registerModel({
    id,
    providerId: "paste-prov",
    surfaceId: "paste-surface",
    displayName: id,
    capabilities: { ...defaultCapabilities(), modalities },
    pricing: {
      inputUSD: 0,
      outputUSD: 0,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  })
  registerProvider({
    id: "paste-prov",
    displayName: "Paste",
    surfaces: ["paste-surface"],
    validate: () => ({ ok: true, errors: [] }),
    run: async function* () {},
  } as unknown as Parameters<typeof registerProvider>[0])
}

describe("mediaPasteInterceptor (drag-drop)", () => {
  it("converts a dropped image path to a token", async () => {
    const reg = createMediaRegistry()
    const p = await tmpFile("dropped.png", png(2, 2))
    const out = mediaPasteInterceptor(p, reg)
    expect(out).not.toBeNull()
    expect(parseMediaTokens(out!)).toHaveLength(1)
  })

  it("returns null for ordinary pasted prose", () => {
    const reg = createMediaRegistry()
    expect(mediaPasteInterceptor("just some pasted text", reg)).toBeNull()
  })

  it("returns null for a non-existent dropped path", () => {
    const reg = createMediaRegistry()
    expect(mediaPasteInterceptor("/nope/ghost.png", reg)).toBeNull()
  })
})

describe("paste gates on the active model", () => {
  it("rejects a dropped wav for an image-only model, accepts it with no model", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-paste-"))
    try {
      const p = join(dir, "a.wav")
      const wav = new Uint8Array(32)
      wav.set([...Buffer.from("RIFF", "latin1"), 0, 0, 0, 0, ...Buffer.from("WAVE", "latin1")])
      writeFileSync(p, wav)
      registerPasteModel("img-only", { image: true, audio: false, pdf: true, video: true })
      const warns: string[] = []
      const diag = { warn: (code: string) => warns.push(code) } as never
      expect(mediaPasteInterceptor(p, createMediaRegistry(), diag, undefined, "img-only")).toBe(
        null,
      )
      expect(warns).toEqual(["media.rejected"])
      expect(mediaPasteInterceptor(p, createMediaRegistry(), diag)).toMatch(/Audio/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("paste diagnostic uses the resolved rejection text", () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it("warns with the provider text (site check)", () => {
    dir = mkdtempSync(join(tmpdir(), "ma-paste-"))
    const path = join(dir, "x.pdf")
    writeFileSync(path, new Uint8Array([1, 2, 3, 4]))
    const facts: Array<Readonly<Record<string, unknown>>> = []
    const text: SyntheticTextResolver = {
      resolve: (kind, f) => {
        facts.push(f)
        return `STUB ${kind} ${JSON.stringify(f)}`
      },
    }
    const warnings: string[] = []
    const diagnostics = {
      warn: (source: string, message: string) => {
        if (source === "media.rejected") warnings.push(message)
      },
    } as unknown as Diagnostics
    registerPasteModel("paste-model", { image: true, audio: false, pdf: true, video: false })
    const out = mediaPasteInterceptor(path, createMediaRegistry(), diagnostics, text, "paste-model")
    expect(out).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.startsWith("STUB user_media.rejected")).toBe(true)
    expect(facts[0]).toMatchObject({ site: "check", reason: "unsupported-type" })
  })
})
