/**
 * U11: the paste hook chain. Priority order, first non-null, throw skip, the
 * defer path, and the Ctrl+V order (W-2).
 */
import { describe, expect, it } from "bun:test"

import { make } from "../editor-controller.fixtures.ts"
import {
  interceptorHook,
  type PasteEvent,
  type PasteHook,
  PasteHookRegistry,
} from "./paste-hooks.ts"

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

function spyDiagnostics() {
  const warns: string[] = []
  const diagnostics = { warn: (source: string) => warns.push(source) } as never
  return { diagnostics, warns }
}

function hook(id: string, priority: number, fn: PasteHook["onPaste"]): PasteHook {
  return { id, priority, onPaste: fn }
}

const ev = (text: string): PasteEvent => ({ text, source: "bracketed", sid: undefined })

describe("PasteHookRegistry (U11)", () => {
  it("runs hooks by priority, higher first; same priority keeps registration order", () => {
    const reg = new PasteHookRegistry()
    const order: string[] = []
    const spy = (id: string, p: number) =>
      reg.register(
        hook(id, p, () => {
          order.push(id)
          return null
        }),
      )
    spy("low", 0)
    spy("mid-a", 50)
    spy("high", 90)
    spy("mid-b", 50)
    expect(reg.run(ev("x"))).toBeNull()
    expect(order).toEqual(["high", "mid-a", "mid-b", "low"])
  })

  it("returns the first non-null outcome and skips the rest", () => {
    const reg = new PasteHookRegistry()
    let lowRan = false
    reg.register(hook("a", 90, () => null))
    reg.register(hook("b", 50, () => ({ kind: "insert", text: "B" })))
    reg.register(
      hook("c", 10, () => {
        lowRan = true
        return { kind: "insert", text: "C" }
      }),
    )
    expect(reg.run(ev("x"))).toEqual({ kind: "insert", text: "B" })
    expect(lowRan).toBe(false)
  })

  it("a throw skips to the next hook and is logged", () => {
    const { diagnostics, warns } = spyDiagnostics()
    const reg = new PasteHookRegistry({ diagnostics })
    reg.register(
      hook("bad", 90, () => {
        throw new Error("boom")
      }),
    )
    reg.register(hook("good", 10, () => ({ kind: "insert", text: "ok" })))
    expect(reg.run(ev("x"))).toEqual({ kind: "insert", text: "ok" })
    expect(warns).toEqual(["paste.hook_failed"])
  })

  it("a bad outcome shape is skipped and logged", () => {
    const { diagnostics, warns } = spyDiagnostics()
    const reg = new PasteHookRegistry({ diagnostics })
    reg.register(hook("bad", 90, () => ({ kind: "insert" }) as never))
    expect(reg.run(ev("x"))).toBeNull()
    expect(warns).toEqual(["paste.hook_failed"])
  })

  it("unregister removes the hook (idempotent)", () => {
    const reg = new PasteHookRegistry()
    const off = reg.register(hook("a", 1, () => ({ kind: "insert", text: "A" })))
    off()
    off()
    expect(reg.size).toBe(0)
    expect(reg.run(ev("x"))).toBeNull()
  })

  it("setSlot replaces the hook in a slot", () => {
    const reg = new PasteHookRegistry()
    reg.setSlot(
      "s",
      hook("one", 1, () => ({ kind: "insert", text: "1" })),
    )
    reg.setSlot(
      "s",
      hook("two", 1, () => ({ kind: "insert", text: "2" })),
    )
    expect(reg.size).toBe(1)
    expect(reg.run(ev("x"))).toEqual({ kind: "insert", text: "2" })
    reg.setSlot("s", undefined)
    expect(reg.size).toBe(0)
  })

  it("the event carries the lazy sid, read at paste time", () => {
    let sid: string | undefined
    const reg = new PasteHookRegistry({ sid: () => sid })
    expect(reg.event("t", "clipboard")).toEqual({ text: "t", source: "clipboard", sid: undefined })
    sid = "s-1"
    expect(reg.event("t", "bracketed").sid).toBe("s-1")
  })
})

describe("EditorController — paste chain outcomes (U11)", () => {
  it("an insert replaces the paste (sanitized)", () => {
    const { ctrl, stdin } = make()
    ctrl.pasteHooks.register(hook("h", 50, () => ({ kind: "insert", text: "[X]\x07" })))
    ctrl.start()
    stdin.send("\x1b[200~raw\x1b[201~")
    expect(ctrl.buffer().toString()).toBe("[X]")
    ctrl.stop()
  })

  it("null from every hook inserts the literal text", () => {
    const { ctrl, stdin } = make()
    ctrl.pasteHooks.register(hook("h", 50, () => null))
    ctrl.start()
    stdin.send("\x1b[200~a\r\nb\x1b[201~")
    expect(ctrl.buffer().toString()).toBe("a\nb")
    ctrl.stop()
  })

  it("defer path: a blank paste runs the deferred step and inserts its result", async () => {
    const { ctrl, stdin } = make()
    ctrl.pasteHooks.register(hook("h", 90, () => ({ kind: "defer", run: async () => "TOKEN" })))
    ctrl.start()
    stdin.send("\x1b[200~\x1b[201~")
    await tick()
    expect(ctrl.buffer().toString()).toBe("TOKEN")
    ctrl.stop()
  })

  it("defer path: a non-blank paste never runs the deferred step (J2)", async () => {
    const { ctrl, stdin } = make()
    let calls = 0
    ctrl.pasteHooks.register(
      hook("h", 90, () => ({
        kind: "defer",
        run: async () => {
          calls++
          return "TOKEN"
        },
      })),
    )
    ctrl.start()
    stdin.send("\x1b[200~text\x1b[201~")
    await tick()
    expect(calls).toBe(0)
    expect(ctrl.buffer().toString()).toBe("text")
    ctrl.stop()
  })
})

describe("legacy adapters", () => {
  it("an interceptor that gives its input unchanged declines (null)", () => {
    const h = interceptorHook((p) => p)
    expect(h.onPaste({ text: "  ", source: "bracketed", sid: undefined })).toBeNull()
    expect(
      interceptorHook(() => "[T]").onPaste({ text: "x", source: "bracketed", sid: undefined }),
    ).toEqual({ kind: "insert", text: "[T]" })
  })

  it("an identity interceptor and a blank paste run the async read once", async () => {
    const { ctrl, stdin } = make()
    let reads = 0
    ctrl.setPasteInterceptor((p) => p)
    ctrl.setAsyncClipboardImageHandler(async () => {
      reads++
      return "[Image #1]"
    })
    ctrl.start()
    stdin.send("\x1b[200~ \x1b[201~")
    await tick()
    expect(reads).toBe(1)
    expect(ctrl.buffer().toString()).toBe(" [Image #1]")
    ctrl.stop()
  })
})

describe("EditorController — Ctrl+V order (U11, W-2)", () => {
  /** A media-like hook: sync image on "", defer on blank, else null. */
  function mediaLike(opts: { syncImage?: string; asyncImage?: string }, log: string[]) {
    return hook("media", 90, (e) => {
      log.push(`chain:${JSON.stringify(e.text)}:${e.source}`)
      if (/\S/.test(e.text))
        return e.text === "/drop.png" ? { kind: "insert", text: "[IMG]" } : null
      if (opts.syncImage) return { kind: "insert", text: opts.syncImage }
      return {
        kind: "defer",
        run: async () => {
          log.push("defer")
          return opts.asyncImage ?? null
        },
      }
    })
  }

  it("step 1: a sync insert on '' ends the flow (no clipboard text read)", async () => {
    const { ctrl, stdin } = make()
    const log: string[] = []
    ctrl.pasteHooks.register(mediaLike({ syncImage: "[SYNC]" }, log))
    ctrl.setClipboardPasteHandler(() => {
      log.push("text")
      return "hello"
    })
    ctrl.start()
    stdin.send("\x16")
    await tick()
    expect(log).toEqual(['chain:"":clipboard'])
    expect(ctrl.buffer().toString()).toBe("[SYNC]")
    ctrl.stop()
  })

  it("step 2: clipboard text runs the chain; null gives the literal text; the defer is ignored", async () => {
    const { ctrl, stdin } = make()
    const log: string[] = []
    ctrl.pasteHooks.register(mediaLike({ asyncImage: "[ASYNC]" }, log))
    ctrl.setClipboardPasteHandler(() => {
      log.push("text")
      return "hello"
    })
    ctrl.start()
    stdin.send("\x16")
    await tick()
    expect(log).toEqual(['chain:"":clipboard', "text", 'chain:"hello":clipboard'])
    expect(ctrl.buffer().toString()).toBe("hello")
    ctrl.stop()
  })

  it("step 2: an insert from the chain on the clipboard text wins", () => {
    const { ctrl, stdin } = make()
    const log: string[] = []
    ctrl.pasteHooks.register(mediaLike({}, log))
    ctrl.setClipboardPasteHandler(() => "/drop.png")
    ctrl.start()
    stdin.send("\x16")
    expect(ctrl.buffer().toString()).toBe("[IMG]")
    ctrl.stop()
  })

  it("step 2: blank clipboard text does not run the defer (it is not empty)", async () => {
    const { ctrl, stdin } = make()
    const log: string[] = []
    ctrl.pasteHooks.register(mediaLike({ asyncImage: "[ASYNC]" }, log))
    ctrl.setClipboardPasteHandler(() => "  ")
    ctrl.start()
    stdin.send("\x16")
    await tick()
    expect(log).not.toContain("defer")
    expect(ctrl.buffer().toString()).toBe("  ")
    ctrl.stop()
  })

  it("step 3: empty or null clipboard text runs the media defer", async () => {
    for (const text of [null, ""]) {
      const { ctrl, stdin } = make()
      const log: string[] = []
      ctrl.pasteHooks.register(mediaLike({ asyncImage: "[ASYNC]" }, log))
      ctrl.setClipboardPasteHandler(() => text)
      ctrl.start()
      stdin.send("\x16")
      await tick()
      expect(log).toEqual(['chain:"":clipboard', "defer"])
      expect(ctrl.buffer().toString()).toBe("[ASYNC]")
      ctrl.stop()
    }
  })
})
