/**
 * The media paste hook (priority 90): drop path → insert, blank → defer to
 * `clipboardImageToken` (J1), other text → null.
 */
import { describe, expect, it } from "bun:test"
import { createMediaRegistry } from "@minimal-agent/core/host-kit/media"

import { createMediaPasteHook, MEDIA_PASTE_PRIORITY } from "./media-paste.ts"
import type { PasteEvent } from "./paste-hooks.ts"

function spyDiagnostics() {
  const warns: Array<{ source: string; data: unknown }> = []
  const diagnostics = {
    warn: (source: string, _msg: string, data?: unknown) => warns.push({ source, data }),
  } as never
  return { diagnostics, warns }
}

const ev = (text: string): PasteEvent => ({ text, source: "bracketed", sid: undefined })

describe("media paste hook", () => {
  it("has priority 90", () => {
    expect(createMediaPasteHook().priority).toBe(MEDIA_PASTE_PRIORITY)
    expect(MEDIA_PASTE_PRIORITY).toBe(90)
  })

  it("a dropped media path gives an insert with the interceptor token", () => {
    const hook = createMediaPasteHook({
      intercept: (p) => (p === "/tmp/a.png" ? "[Image #a1 1x1 1B]" : null),
    })
    expect(hook.onPaste(ev("/tmp/a.png"))).toEqual({ kind: "insert", text: "[Image #a1 1x1 1B]" })
  })

  it("other text gives null, and prose never reaches the interceptor", () => {
    let calls = 0
    const hook = createMediaPasteHook({
      intercept: () => {
        calls++
        return null
      },
    })
    expect(hook.onPaste(ev("hello world"))).toBeNull()
    expect(calls).toBe(0)
    expect(hook.onPaste(ev("/not/media.txt and words"))).toBeNull()
    expect(calls).toBe(1)
  })

  it("a blank paste with a sync image (Linux) gives an insert", () => {
    const hook = createMediaPasteHook({ intercept: (p) => (p === "" ? "[Image #s]" : null) })
    expect(hook.onPaste(ev(""))).toEqual({ kind: "insert", text: "[Image #s]" })
  })

  it("a blank paste with no sync image defers to the clipboard image token", async () => {
    const registry = createMediaRegistry()
    const png = new Uint8Array(24)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    png.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
    png[19] = 3
    png[23] = 3
    const hook = createMediaPasteHook({
      registry: () => registry,
      intercept: () => null,
      readImage: async () => ({ bytes: png }),
    })
    const out = hook.onPaste(ev("  "))
    expect(out?.kind).toBe("defer")
    if (out?.kind !== "defer") return
    expect(await out.run()).toMatch(/^\[Image #/)
    expect(registry.list()).toHaveLength(1)
  })

  it("J1: a reader that returns {bytes: null, error} emits media.clipboard_failed", async () => {
    const { diagnostics, warns } = spyDiagnostics()
    const hook = createMediaPasteHook({
      diagnostics,
      registry: () => createMediaRegistry(),
      intercept: () => null,
      readImage: async () => ({ bytes: null, error: "pasteboard busy" }),
    })
    const out = hook.onPaste(ev(""))
    expect(out?.kind).toBe("defer")
    if (out?.kind !== "defer") return
    expect(await out.run()).toBeNull()
    expect(warns).toEqual([
      { source: "media.clipboard_failed", data: { reason: "pasteboard busy" } },
    ])
  })

  it("a clipboard image over the size floor emits media.rejected and gives no token", async () => {
    const { diagnostics, warns } = spyDiagnostics()
    const registry = createMediaRegistry()
    const png = new Uint8Array(24 + 6 * 1024 * 1024)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    png.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
    png[19] = 2
    png[23] = 2
    const hook = createMediaPasteHook({
      diagnostics,
      registry: () => registry,
      intercept: () => null,
      readImage: async () => ({ bytes: png }),
    })
    const out = hook.onPaste(ev(""))
    if (out?.kind !== "defer") throw new Error("expected defer")
    expect(await out.run()).toBeNull()
    expect(warns.map((w) => w.source)).toEqual(["media.rejected"])
  })

  it("J1: an empty clipboard is not a failure (no warning)", async () => {
    const { diagnostics, warns } = spyDiagnostics()
    const hook = createMediaPasteHook({
      diagnostics,
      registry: () => createMediaRegistry(),
      intercept: () => null,
      readImage: async () => ({ bytes: null }),
    })
    const out = hook.onPaste(ev(""))
    if (out?.kind !== "defer") throw new Error("expected defer")
    expect(await out.run()).toBeNull()
    expect(warns).toEqual([])
  })
})
