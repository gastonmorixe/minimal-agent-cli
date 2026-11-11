import { describe, expect, it } from "bun:test"
import { Hooks } from "@minimal-agent/core/host-kit/hooks"

import { make } from "../editor-controller.fixtures.ts"
import type { EditorKeyPayload } from "../editor-controller.ts"

// Regression (2026-11-11): iTerm with the kitty keyboard protocol on
// (`\x1b[>31u`, sent at startup) ships Tab, Enter and typed characters as
// CSI-u sequences. The legacy byte path dispatches `editor.key` for Tab,
// Enter, "/" and "$". The CSI-u path did not. So the slash menu did not open
// on "/", Tab inserted a literal tab instead of completing a "&" prompt or an
// "@" mention, and Enter submitted the raw buffer instead of picking the item.

function recorder(halt: (key: string) => boolean = () => false) {
  const hooks = new Hooks()
  const seen: Array<{ key: string; buffer: string }> = []
  hooks.on<EditorKeyPayload>(
    "editor.key",
    (payload) => {
      seen.push({ key: payload.key, buffer: payload.buffer })
      if (halt(payload.key)) payload.result.halt = true
    },
    { caller: "plugin" },
  )
  return { hooks, seen }
}

describe("CSI-u keys reach the editor.key hook (kitty keyboard protocol)", () => {
  it("plain Tab `\\x1b[9u` dispatches Tab and a halt suppresses the literal tab", () => {
    const { hooks, seen } = recorder((k) => k === "Tab")
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("&de")
    stdin.send("\x1b[9u")
    expect(seen.map((s) => s.key)).toContain("Tab")
    expect(ctrl.buffer().toString()).toBe("&de")
    ctrl.stop()
  })

  it("plain Tab `\\x1b[9u` still inserts a tab when no listener halts", () => {
    const { hooks } = recorder()
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("\x1b[9u")
    expect(ctrl.buffer().toString()).toBe("\t")
    ctrl.stop()
  })

  it("typed `/` as `\\x1b[47u` is inserted, then dispatched (same order as the byte path)", () => {
    const { hooks, seen } = recorder()
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("\x1b[47u")
    expect(ctrl.buffer().toString()).toBe("/")
    expect(seen).toContainEqual({ key: "/", buffer: "/" })
    ctrl.stop()
  })

  it("typed `/` with associated text `\\x1b[47;;47u` is dispatched", () => {
    const { hooks, seen } = recorder()
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("\x1b[47;;47u")
    expect(ctrl.buffer().toString()).toBe("/")
    expect(seen.map((s) => s.key)).toContain("/")
    ctrl.stop()
  })

  it("Shift+4 `$` as `\\x1b[52;2;36u` is dispatched as `$`", () => {
    const { hooks, seen } = recorder()
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("\x1b[52;2;36u")
    expect(ctrl.buffer().toString()).toBe("$")
    expect(seen.map((s) => s.key)).toContain("$")
    ctrl.stop()
  })

  it("other typed letters do not dispatch (no per-key hook cost)", () => {
    const { hooks, seen } = recorder()
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("\x1b[97u")
    expect(ctrl.buffer().toString()).toBe("a")
    expect(seen).toEqual([])
    ctrl.stop()
  })

  it("bare Enter `\\x1b[13u` on a non-empty buffer: a halt blocks the submit", () => {
    const { hooks, seen } = recorder((k) => k === "Enter")
    const { ctrl, stdin } = make({ hooks })
    const submitted: string[] = []
    ctrl.on("submit", (text: string) => submitted.push(text))
    ctrl.start()
    stdin.send("&de")
    stdin.send("\x1b[13u")
    expect(seen.map((s) => s.key)).toContain("Enter")
    expect(submitted).toEqual([])
    ctrl.stop()
  })

  it("bare Enter `\\x1b[13u` still submits when no listener halts", () => {
    const { hooks } = recorder()
    const { ctrl, stdin } = make({ hooks })
    const submitted: string[] = []
    ctrl.on("submit", (text: string) => submitted.push(text))
    ctrl.start()
    stdin.send("hello")
    stdin.send("\x1b[13u")
    expect(submitted).toEqual(["hello"])
    ctrl.stop()
  })

  it("bare Enter `\\x1b[13u` on an empty buffer: an overlay can claim it", () => {
    const { hooks, seen } = recorder((k) => k === "Enter")
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("\x1b[13u")
    expect(seen.map((s) => s.key)).toContain("Enter")
    ctrl.stop()
  })
})
