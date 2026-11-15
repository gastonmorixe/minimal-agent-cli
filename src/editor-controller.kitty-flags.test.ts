import { describe, expect, it } from "bun:test"
import { Hooks } from "@minimal-agent/core/host-kit/hooks"
import { KITTY_KEYBOARD_ENABLE } from "./editor/types.ts"
import { make } from "./editor-controller.fixtures.ts"
import type { EditorKeyPayload } from "./editor-controller.ts"

// Regression (2026-11-15): the editor enabled the kitty keyboard protocol at
// level 31 (`\x1b[>31u`). Flag 8 ("report all keys as escape codes") makes
// iTerm send a CSI-u sequence for a bare Shift / Alt press, and flag 2 adds
// release events. iTerm scrolls to the prompt whenever it sends input, so a
// lone modifier press yanked the user out of scrollback.
//
// The editor now asks for flag 1 only (disambiguate). These tests pin:
//   1. the exact enable sequence,
//   2. that everything the editor binds still works with flag-1 encodings
//      (modified keys as CSI-u, plain keys as legacy bytes, bracketed paste),
//   3. that modifier-only / release events, if a terminal still sends them,
//      stay inert (no buffer edit, no submit, no editor.key dispatch).

function recorder() {
  const hooks = new Hooks()
  const seen: string[] = []
  hooks.on<EditorKeyPayload>("editor.key", (p) => void seen.push(p.key), { caller: "plugin" })
  return { hooks, seen }
}

describe("kitty keyboard flags", () => {
  it("enables flag 1 only (no event types, no report-all-keys)", () => {
    expect(KITTY_KEYBOARD_ENABLE).toBe("\x1b[>1u")
    const { ctrl, output } = make()
    ctrl.start()
    expect(output.text()).toContain("\x1b[>1u")
    expect(output.text()).not.toMatch(/\x1b\[>(?:[2-9]|[1-9]\d)u/u)
    ctrl.stop()
    expect(output.text()).toContain("\x1b[<u")
  })
})

describe("flag-1 encodings keep every binding working", () => {
  it("plain bytes type and legacy CR submits", () => {
    const { ctrl, stdin } = make()
    const submitted: string[] = []
    ctrl.on("submit", (t: string) => submitted.push(t))
    ctrl.start()
    stdin.send("hello")
    stdin.send("\r")
    expect(submitted).toEqual(["hello"])
    ctrl.stop()
  })

  it("Shift+Enter `\\x1b[13;2u` inserts a newline and does not submit", () => {
    const { ctrl, stdin } = make()
    const submitted: string[] = []
    ctrl.on("submit", (t: string) => submitted.push(t))
    ctrl.start()
    stdin.send("a")
    stdin.send("\x1b[13;2u")
    stdin.send("b")
    expect(ctrl.buffer().toString()).toBe("a\nb")
    expect(submitted).toEqual([])
    ctrl.stop()
  })

  it("Alt+Enter `\\x1b[13;3u` inserts a newline and does not submit", () => {
    const { ctrl, stdin } = make()
    const submitted: string[] = []
    ctrl.on("submit", (t: string) => submitted.push(t))
    ctrl.start()
    stdin.send("a")
    stdin.send("\x1b[13;3u")
    expect(ctrl.buffer().toString()).toBe("a\n")
    expect(submitted).toEqual([])
    ctrl.stop()
  })

  it("Alt+m `\\x1b[109;3u` fires the mode-interrupt handler", () => {
    const { ctrl, stdin } = make()
    let calls = 0
    ctrl.setModeInterruptHandler(() => void calls++)
    ctrl.start()
    stdin.send("\x1b[109;3u")
    expect(calls).toBe(1)
    expect(ctrl.buffer().toString()).toBe("")
    ctrl.stop()
  })

  it("legacy Tab byte still reaches the editor.key hook", () => {
    const { hooks, seen } = recorder()
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("\t")
    expect(seen).toContain("Tab")
    ctrl.stop()
  })

  it("bracketed multi-line paste is inserted verbatim without submitting", () => {
    const { ctrl, stdin } = make()
    const submitted: string[] = []
    ctrl.on("submit", (t: string) => submitted.push(t))
    ctrl.start()
    stdin.send("\x1b[200~line1\nline2\x1b[201~")
    expect(ctrl.buffer().toString()).toBe("line1\nline2")
    expect(submitted).toEqual([])
    ctrl.stop()
  })
})

describe("modifier-only and release events stay inert", () => {
  // Kitty functional-key codes: 57441 LShift, 57442 LCtrl, 57443 LAlt,
  // 57444 LSuper, 57447 RShift, 57449 RAlt. `;mods:3` = release event.
  const inert: Array<[string, string]> = [
    ["left Shift press", "\x1b[57441;2u"],
    ["left Shift release", "\x1b[57441;1:3u"],
    ["left Alt press", "\x1b[57443;3u"],
    ["right Alt press", "\x1b[57449;3u"],
    ["right Shift press", "\x1b[57447;2u"],
    ["left Super (Cmd) press", "\x1b[57444;9u"],
    ["key release of 'a'", "\x1b[97;1:3u"],
    ["Enter release", "\x1b[13;1:3u"],
  ]

  for (const [name, seq] of inert) {
    it(`${name} ${JSON.stringify(seq)} does nothing`, () => {
      const { hooks, seen } = recorder()
      const { ctrl, stdin } = make({ hooks })
      const submitted: string[] = []
      ctrl.on("submit", (t: string) => submitted.push(t))
      ctrl.start()
      stdin.send("draft")
      seen.length = 0
      stdin.send(seq)
      expect(ctrl.buffer().toString()).toBe("draft")
      expect(submitted).toEqual([])
      expect(seen).toEqual([])
      ctrl.stop()
    })
  }
})
