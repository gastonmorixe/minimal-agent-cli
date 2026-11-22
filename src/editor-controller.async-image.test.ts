import { describe, expect, it } from "bun:test"

import { make } from "./editor-controller.fixtures.ts"

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe("EditorController — async clipboard image fallback", () => {
  it("empty bracketed paste (Ghostty, image-only clipboard) inserts the async token", async () => {
    const { ctrl, stdin } = make()
    ctrl.setAsyncClipboardImageHandler(async () => "tok-abc")
    ctrl.start()
    stdin.send("\x1b[200~\x1b[201~")
    await tick()
    expect(ctrl.buffer().toString()).toBe("tok-abc")
    ctrl.stop()
  })

  it("whitespace-only paste also triggers the fallback", async () => {
    const { ctrl, stdin } = make()
    ctrl.setAsyncClipboardImageHandler(async () => "tok-w")
    ctrl.start()
    stdin.send("\x1b[200~  \x1b[201~")
    await tick()
    expect(ctrl.buffer().toString()).toContain("tok-w")
    ctrl.stop()
  })

  it("repaints the live area after the async insert", async () => {
    const { ctrl, stdin, compositor } = make()
    ctrl.setAsyncClipboardImageHandler(async () => "tok-r")
    ctrl.start()
    stdin.send("\x1b[200~\x1b[201~")
    await tick()
    expect(compositor.last().lines.join("\n")).toContain("tok-r")
    ctrl.stop()
  })

  it("Ctrl+V with nothing from the sync handler falls back to the async token", async () => {
    const { ctrl, stdin } = make()
    ctrl.setClipboardPasteHandler(() => null)
    ctrl.setAsyncClipboardImageHandler(async () => "tok-cv")
    ctrl.start()
    stdin.send("\x16")
    await tick()
    expect(ctrl.buffer().toString()).toBe("tok-cv")
    ctrl.stop()
  })

  it("Ctrl+V with no sync handler wired still tries the async token", async () => {
    const { ctrl, stdin } = make()
    ctrl.setAsyncClipboardImageHandler(async () => "tok-nh")
    ctrl.start()
    stdin.send("\x16")
    await tick()
    expect(ctrl.buffer().toString()).toBe("tok-nh")
    ctrl.stop()
  })

  it("does NOT call the async handler when the sync Ctrl+V handler returned text", async () => {
    const { ctrl, stdin } = make()
    let calls = 0
    ctrl.setClipboardPasteHandler(() => "sync text")
    ctrl.setAsyncClipboardImageHandler(async () => {
      calls++
      return "tok-x"
    })
    ctrl.start()
    stdin.send("\x16")
    await tick()
    expect(calls).toBe(0)
    expect(ctrl.buffer().toString()).toBe("sync text")
    ctrl.stop()
  })

  it("does NOT call the async handler when the interceptor already made a token", async () => {
    const { ctrl, stdin } = make()
    let calls = 0
    ctrl.setPasteInterceptor((p) => (p.trim() === "" ? "tok-sync" : null))
    ctrl.setAsyncClipboardImageHandler(async () => {
      calls++
      return "tok-async"
    })
    ctrl.start()
    stdin.send("\x1b[200~\x1b[201~")
    await tick()
    expect(calls).toBe(0)
    expect(ctrl.buffer().toString()).toBe("tok-sync")
    ctrl.stop()
  })

  it("does NOT call the async handler for a non-empty text paste", async () => {
    const { ctrl, stdin } = make()
    let calls = 0
    ctrl.setAsyncClipboardImageHandler(async () => {
      calls++
      return "tok-x"
    })
    ctrl.start()
    stdin.send("\x1b[200~hello\x1b[201~")
    await tick()
    expect(calls).toBe(0)
    expect(ctrl.buffer().toString()).toBe("hello")
    ctrl.stop()
  })

  it("leaves the buffer alone when the async handler finds no image", async () => {
    const { ctrl, stdin } = make()
    ctrl.setAsyncClipboardImageHandler(async () => null)
    ctrl.start()
    stdin.send("\x1b[200~\x1b[201~")
    await tick()
    expect(ctrl.buffer().toString()).toBe("")
    ctrl.stop()
  })

  it("swallows a rejecting async handler", async () => {
    const { ctrl, stdin } = make()
    ctrl.setAsyncClipboardImageHandler(async () => {
      throw new Error("pasteboard busy")
    })
    ctrl.start()
    stdin.send("\x1b[200~\x1b[201~")
    await tick()
    expect(ctrl.buffer().toString()).toBe("")
    // A later paste still works: the pending flag was reset.
    ctrl.setAsyncClipboardImageHandler(async () => "tok-ok")
    stdin.send("\x1b[200~\x1b[201~")
    await tick()
    expect(ctrl.buffer().toString()).toBe("tok-ok")
    ctrl.stop()
  })

  it("ignores a second paste while one async read is pending (no double token)", async () => {
    const { ctrl, stdin } = make()
    let calls = 0
    let release!: (v: string) => void
    ctrl.setAsyncClipboardImageHandler(() => {
      calls++
      return new Promise<string>((r) => {
        release = r
      })
    })
    ctrl.start()
    stdin.send("\x1b[200~\x1b[201~")
    stdin.send("\x16")
    stdin.send("\x1b[200~\x1b[201~")
    expect(calls).toBe(1)
    release("tok-one")
    await tick()
    expect(ctrl.buffer().toString()).toBe("tok-one")
    ctrl.stop()
  })

  it("drops a late result after stop()", async () => {
    const { ctrl, stdin } = make()
    let release!: (v: string) => void
    ctrl.setAsyncClipboardImageHandler(
      () =>
        new Promise<string>((r) => {
          release = r
        }),
    )
    ctrl.start()
    stdin.send("\x1b[200~\x1b[201~")
    ctrl.stop()
    release("tok-late")
    await tick()
    expect(ctrl.buffer().toString()).toBe("")
  })

  it("drops a late result after a stop/start cycle", async () => {
    const { ctrl, stdin } = make()
    let release!: (v: string) => void
    ctrl.setAsyncClipboardImageHandler(
      () =>
        new Promise<string>((r) => {
          release = r
        }),
    )
    ctrl.start()
    stdin.send("\x1b[200~\x1b[201~")
    ctrl.stop()
    ctrl.start()
    release("tok-stale")
    await tick()
    expect(ctrl.buffer().toString()).toBe("")
    ctrl.stop()
  })

  it("is a no-op when no async handler is wired", async () => {
    const { ctrl, stdin } = make()
    ctrl.start()
    stdin.send("\x1b[200~\x1b[201~")
    stdin.send("\x16")
    await tick()
    expect(ctrl.buffer().toString()).toBe("")
    ctrl.stop()
  })

  it("setAsyncClipboardImageHandler(undefined) removes the handler", async () => {
    const { ctrl, stdin } = make()
    let calls = 0
    ctrl.setAsyncClipboardImageHandler(async () => {
      calls++
      return "tok-x"
    })
    ctrl.setAsyncClipboardImageHandler(undefined)
    ctrl.start()
    stdin.send("\x1b[200~\x1b[201~")
    await tick()
    expect(calls).toBe(0)
    ctrl.stop()
  })

  it("appends the token after existing text at the cursor", async () => {
    const { ctrl, stdin } = make()
    ctrl.setAsyncClipboardImageHandler(async () => "tok-t")
    ctrl.start()
    stdin.send("look: ")
    stdin.send("\x1b[200~\x1b[201~")
    await tick()
    expect(ctrl.buffer().toString()).toBe("look: tok-t")
    ctrl.stop()
  })
})
