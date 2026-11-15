import { describe, expect, it } from "bun:test"

import { isKittyFunctionalKey, isTypableKeyCode, parseCsiUKey } from "./key-codec.ts"

describe("isKittyFunctionalKey / isTypableKeyCode", () => {
  it("flags kitty modifier, lock and keypad codes as functional", () => {
    // 57358 CapsLock, 57399 KP_0, 57441 LShift, 57443 LAlt, 57444 LSuper, 57452 RMeta
    for (const cp of [57344, 57358, 57399, 57441, 57443, 57444, 57452, 63743]) {
      expect(isKittyFunctionalKey(cp)).toBe(true)
      expect(isTypableKeyCode(cp)).toBe(false)
    }
  })

  it("keeps normal text typable", () => {
    for (const ch of ["a", "Z", "/", "$", " ", "é", "😀", "漢"]) {
      const cp = ch.codePointAt(0) ?? 0
      expect(isKittyFunctionalKey(cp)).toBe(false)
      expect(isTypableKeyCode(cp)).toBe(true)
    }
  })

  it("rejects control codes", () => {
    for (const cp of [0, 9, 13, 27, 0x7f]) expect(isTypableKeyCode(cp)).toBe(false)
  })
})

describe("parseCsiUKey event types", () => {
  it("defaults to press and reads repeat/release", () => {
    expect(parseCsiUKey("\x1b[57441;2u")?.eventType).toBe(1)
    expect(parseCsiUKey("\x1b[57441;2:2u")?.eventType).toBe(2)
    expect(parseCsiUKey("\x1b[57441;1:3u")?.eventType).toBe(3)
  })
})
