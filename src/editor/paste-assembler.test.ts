/**
 * U10: whole-paste assembly. The end marker split at each byte offset, 1 KiB
 * chunks, the rest of the chunk as literal text (a CR there is not a submit),
 * and the size cap.
 */
import { describe, expect, it } from "bun:test"

import { make } from "../editor-controller.fixtures.ts"
import { PasteAssembler } from "./paste-assembler.ts"

const END = "\x1b[201~"

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
    // ESC and other control bytes in the rest are dropped, not run as keys.
    expect(ctrl.buffer().toString()).toBe("ab\nc[Ad")
    // The next chunk is keys again: Enter submits.
    stdin.send("\r")
    expect(submits).toEqual(["ab\nc[Ad"])
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
