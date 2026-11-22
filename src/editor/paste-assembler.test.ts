/**
 * U10: whole-paste assembly. The end marker split at each byte offset, 1 KiB
 * chunks, the rest of the chunk as inert literal text (a CR there is not a
 * submit), N pastes in one read, nested start markers, the idle timeout, and
 * the size cap.
 */
import { describe, expect, it } from "bun:test"

import { FakeCompositor, FakeOutput, FakeTTYInput, make } from "../editor-controller.fixtures.ts"
import { EditorController } from "../editor-controller.ts"
import { stripEscapeSequences } from "./key-dispatch.ts"
import { PasteAssembler } from "./paste-assembler.ts"

const START = "\x1b[200~"
const END = "\x1b[201~"

/** A controller with a fake timer, and a spy hook that records each chain run. */
function makeTimed() {
  const timers: Array<{ cb: () => void; ms: number; live: boolean }> = []
  const stdin = new FakeTTYInput()
  const ctrl = new EditorController({
    exitFn: () => {},
    prompt: "> ",
    continuationPrompt: "  ",
    compositor: new FakeCompositor() as never,
    stdin: stdin as never,
    output: new FakeOutput() as never,
    resizeDebounceMs: 0,
    doubleEscapeMs: 0,
    setTimeout: (cb, ms) => {
      const t = { cb, ms, live: true }
      timers.push(t)
      return t
    },
    clearTimeout: (h) => {
      ;(h as { live: boolean }).live = false
    },
  })
  const warns: string[] = []
  const seen: string[] = []
  ;(ctrl.pasteHooks as unknown as { diagnostics: unknown }).diagnostics = {
    warn: (source: string) => warns.push(source),
  }
  ctrl.pasteHooks.register({
    id: "spy",
    priority: 10,
    onPaste: (ev) => {
      seen.push(ev.text)
      return null
    },
  })
  /** Fire each live timer of `ms` (the paste idle timer is 3000 ms). */
  const fire = (ms: number) => {
    for (const t of timers.splice(0)) {
      if (t.live && t.ms === ms) t.cb()
      else if (t.live) timers.push(t)
    }
  }
  const live = (ms: number) => timers.filter((t) => t.live && t.ms === ms).length
  return { ctrl, stdin, warns, seen, fire, live }
}

/** A plain controller with a spy hook and a submit spy. */
function makeSpy() {
  const { ctrl, stdin } = make()
  const seen: string[] = []
  const submits: string[] = []
  ctrl.on("submit", (t: string) => submits.push(t))
  ctrl.pasteHooks.register({
    id: "spy",
    priority: 10,
    onPaste: (ev) => {
      seen.push(ev.text)
      return null
    },
  })
  ctrl.start()
  return { ctrl, stdin, seen, submits }
}

describe("PasteAssembler (U10)", () => {
  it("collects chunks and finishes at the end marker", () => {
    const a = new PasteAssembler()
    expect(a.push("hello ").done).toBe(false)
    expect(a.bytes).toBe(6)
    const r = a.push(`world${END}tail`)
    expect(r).toEqual({ done: true, rest: "tail", spill: "" })
    expect(a.finish()).toBe("hello world")
    expect(a.bytes).toBe(0)
  })

  it("finds the end marker split at each offset", () => {
    const whole = `abc\ndef${END}xyz`
    const markerAt = whole.indexOf(END)
    // Each split from inside the text to inside the marker.
    for (let i = 1; i < markerAt + END.length; i++) {
      const a = new PasteAssembler()
      const first = a.push(whole.slice(0, i))
      expect(first.done).toBe(false)
      const second = a.push(whole.slice(i))
      expect(second.done).toBe(true)
      expect(second.rest).toBe("xyz")
      expect(a.finish()).toBe("abc\ndef")
    }
  })

  it("finds the end marker when each byte is its own chunk", () => {
    const a = new PasteAssembler()
    const whole = `p${END}`
    let last = { done: false, rest: "", spill: "" }
    for (const ch of whole) last = a.push(ch)
    expect(last.done).toBe(true)
    expect(a.finish()).toBe("p")
  })

  it("keeps a partial marker that is not a marker as text", () => {
    const a = new PasteAssembler()
    a.push("x\x1b[20")
    a.push("0y")
    a.push(END)
    expect(a.finish()).toBe("x\x1b[200y")
  })

  it("counts UTF-8 bytes, not code units", () => {
    const a = new PasteAssembler()
    a.push("é😀")
    expect(a.bytes).toBe(2 + 4)
  })

  it("1 KiB chunks assemble to the same text", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${"z".repeat(i % 40)}`).join("\r")
    const stream = `${text}${END}`
    const a = new PasteAssembler()
    let r = { done: false, rest: "", spill: "" }
    for (let i = 0; i < stream.length; i += 1024) r = a.push(stream.slice(i, i + 1024))
    expect(r.done).toBe(true)
    expect(a.finish()).toBe(text)
  })

  it("over the cap: one warning, the text spills as literal, nothing is dropped", () => {
    const caps: number[] = []
    const a = new PasteAssembler({ capBytes: 10, onCap: (c) => caps.push(c) })
    const spills: string[] = []
    spills.push(a.push("12345678").spill)
    spills.push(a.push("9abc").spill)
    spills.push(a.push("def").spill)
    const r = a.push(`gh${END}`)
    spills.push(r.spill)
    expect(r.done).toBe(true)
    expect(a.overflowed).toBe(true)
    expect(caps).toEqual([10])
    expect(spills.join("") + a.finish()).toBe("123456789abcdefgh")
  })

  it("over the cap: a CRLF split across chunks stays one newline", () => {
    const a = new PasteAssembler({ capBytes: 2 })
    const out = [a.push("abc\r").spill, a.push("\nd").spill, a.push(END).spill]
    expect(out.join("") + a.finish()).toBe("abc\r\nd")
    expect(out[0]).toBe("abc")
  })

  it("removes nested start markers, also a marker split across chunks", () => {
    const a = new PasteAssembler()
    a.push(`one${START}two\x1b[2`)
    a.push(`00~three${END}`)
    expect(a.finish()).toBe("onetwothree")
  })

  it("abandon gives the text with the held marker tail", () => {
    const a = new PasteAssembler()
    a.push("abc\x1b[20")
    expect(a.abandon()).toBe("abc\x1b[20")
    expect(a.bytes).toBe(0)
  })

  it("abort drops the paste in progress", () => {
    const a = new PasteAssembler()
    a.push("partial\x1b[20")
    a.abort()
    expect(a.bytes).toBe(0)
    a.push(`new${END}`)
    expect(a.finish()).toBe("new")
  })
})

describe("EditorController — whole-paste assembly (U10)", () => {
  it("runs the paste chain once, at the end marker, with the whole text", () => {
    const { ctrl, stdin } = make()
    const seen: string[] = []
    ctrl.pasteHooks.register({
      id: "spy",
      priority: 10,
      onPaste: (ev) => {
        seen.push(ev.text)
        return null
      },
    })
    ctrl.start()
    stdin.send("\x1b[200~line one\r")
    stdin.send("line two\r")
    stdin.send("line three\x1b[20")
    expect(seen).toEqual([])
    expect(ctrl.buffer().toString()).toBe("")
    stdin.send("1~")
    expect(seen).toEqual(["line one\rline two\rline three"])
    expect(ctrl.buffer().toString()).toBe("line one\nline two\nline three")
    ctrl.stop()
  })

  it("the rest of the end chunk is literal text: a CR there is not a submit", () => {
    const { ctrl, stdin } = make()
    const submits: string[] = []
    ctrl.on("submit", (t: string) => submits.push(t))
    ctrl.start()
    stdin.send(`\x1b[200~a${END}b\rc\x1b[Ad`)
    expect(submits).toEqual([])
    // Whole escape sequences in the rest are dropped, not run as keys.
    expect(ctrl.buffer().toString()).toBe("ab\ncd")
    // The next chunk is keys again: Enter submits.
    stdin.send("\r")
    expect(submits).toEqual(["ab\ncd"])
    ctrl.stop()
  })

  it("tail rule: CSI, SS3 and C0 controls are dropped, CR and CRLF are newlines", () => {
    const { ctrl, stdin, submits } = makeSpy()
    stdin.send(`${START}x${END}\x1b[A\x03\r`)
    expect(ctrl.buffer().toString()).toBe("x\n")
    stdin.send(`${START}y${END}a\x1bOPb\x1b[1;5Cc\r\nd\x7f\x08\te\x1b]0;t\x07f`)
    expect(ctrl.buffer().toString()).toBe("x\nyabc\nd\tef")
    expect(submits).toEqual([])
    ctrl.stop()
  })

  it("stripEscapeSequences drops whole sequences and keeps other text", () => {
    expect(stripEscapeSequences("a\x1b[Ab")).toBe("ab")
    expect(stripEscapeSequences("a\x1b[27;5;99~b")).toBe("ab")
    expect(stripEscapeSequences("a\x1bOPb")).toBe("ab")
    expect(stripEscapeSequences("a\x1b]0;title\x1b\\b")).toBe("ab")
    expect(stripEscapeSequences("a\x1bxb")).toBe("ab")
    expect(stripEscapeSequences("a\x1b[12")).toBe("a")
    // The C1 CSI (U+009B) is a one-byte CSI: its params go with it.
    expect(stripEscapeSequences("a\x9b31mb")).toBe("ab")
    expect(stripEscapeSequences("plain")).toBe("plain")
  })

  it("two pastes in one read: the second paste starts, a CR in it is not a submit", () => {
    const { ctrl, stdin, seen, submits } = makeSpy()
    stdin.send(`${START}one${END}${START}two`)
    stdin.send("\r")
    stdin.send(`three${END}`)
    expect(submits).toEqual([])
    expect(ctrl.buffer().toString()).toBe("onetwo\nthree")
    // The chain runs one time for each paste.
    expect(seen).toEqual(["one", "two\rthree"])
    ctrl.stop()
  })

  it("three pastes in one read, with tail text between them", () => {
    const { ctrl, stdin, seen, submits } = makeSpy()
    stdin.send(`${START}a${END}-\r${START}b${END}\x1b[A${START}c${END}z`)
    expect(seen).toEqual(["a", "b", "c"])
    expect(ctrl.buffer().toString()).toBe("a-\nbcz")
    expect(submits).toEqual([])
    // The next read is keys again.
    stdin.send("\r")
    expect(submits).toEqual(["a-\nbcz"])
    ctrl.stop()
  })

  it("a paste start split across reads starts the next paste", () => {
    const { ctrl, stdin, seen, submits } = makeSpy()
    stdin.send(`${START}one${END}\x1b[2`)
    stdin.send("00~two\r")
    stdin.send(`three${END}`)
    expect(seen).toEqual(["one", "two\rthree"])
    expect(ctrl.buffer().toString()).toBe("onetwo\nthree")
    expect(submits).toEqual([])
    ctrl.stop()
  })

  it("a held tail byte that is not a paste start is dropped; the next read is keys", () => {
    const { ctrl, stdin, submits } = makeSpy()
    stdin.send(`${START}one${END}\x1b`)
    stdin.send("x")
    expect(ctrl.buffer().toString()).toBe("onex")
    stdin.send("\r")
    expect(submits).toEqual(["onex"])
    ctrl.stop()
  })

  it("nested start markers in each chunk never reach the hooks", () => {
    const { ctrl, stdin, seen } = makeSpy()
    stdin.send(`${START}aa`)
    stdin.send(`${START}bb`)
    stdin.send(`${START}cc${END}`)
    expect(seen).toEqual(["aabbcc"])
    expect(ctrl.buffer().toString()).toBe("aabbcc")
    ctrl.stop()
  })

  it("idle timeout: a paste with no end marker goes in as literal text, one warning", () => {
    const { ctrl, stdin, warns, seen, fire, live } = makeTimed()
    ctrl.start()
    stdin.send(`${START}part one\r`)
    stdin.send("part two")
    expect(ctrl.composeFooter()).toEqual(["pasting 1 kB"])
    // Each chunk restarts the timer: only one is live.
    expect(live(3000)).toBe(1)
    fire(3000)
    expect(ctrl.buffer().toString()).toBe("part one\npart two")
    expect(ctrl.composeFooter()).toEqual([])
    expect(warns).toEqual(["paste.unterminated"])
    // No chain run: the user sees the literal text.
    expect(seen).toEqual([])
    // Later typing is keys again: Enter submits.
    const submits: string[] = []
    ctrl.on("submit", (t: string) => submits.push(t))
    stdin.send("!\r")
    expect(submits).toEqual(["part one\npart two!"])
    ctrl.stop()
  })

  it("idle timeout: the end marker clears the timer", () => {
    const { ctrl, stdin, warns, fire, live } = makeTimed()
    ctrl.start()
    stdin.send(`${START}abc`)
    stdin.send(END)
    expect(live(3000)).toBe(0)
    fire(3000)
    expect(warns).toEqual([])
    expect(ctrl.buffer().toString()).toBe("abc")
    ctrl.stop()
  })

  it("shows the 'pasting N kB' status row while the paste is in progress", () => {
    const { ctrl, stdin } = make()
    ctrl.start()
    stdin.send(`\x1b[200~${"x".repeat(3000)}`)
    expect(ctrl.composeFooter()).toEqual(["pasting 3 kB"])
    stdin.send("y".repeat(2000))
    expect(ctrl.composeFooter()).toEqual(["pasting 5 kB"])
    stdin.send(END)
    expect(ctrl.composeFooter()).toEqual([])
    expect(ctrl.buffer().toString().length).toBe(5000)
    ctrl.stop()
  })

  it("stop() mid-paste drops the paste and the status row", () => {
    const { ctrl, stdin } = make()
    ctrl.start()
    stdin.send("\x1b[200~partial")
    ctrl.stop()
    expect(ctrl.composeFooter()).toEqual([])
    ctrl.start()
    stdin.send("typed")
    expect(ctrl.buffer().toString()).toBe("typed")
    ctrl.stop()
  })
})
