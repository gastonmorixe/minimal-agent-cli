import { describe, expect, test } from "bun:test"

import {
  MAX_REOPEN_SGR_LENGTH,
  SCROLLBACK_SGR_RESET,
  sanitizeScrollbackLines,
  sanitizeScrollbackText,
  stripAllTerminalControls,
} from "./sanitize-scrollback.ts"

const R = SCROLLBACK_SGR_RESET

/**
 * Output size bound: `K * input + C` code units. A tab gives up to 8
 * spaces, and each row after the first needs at least 2 input code units
 * (a break and one character) but adds at most the reopened style, the
 * reset and the `\n`: (8 + MAX_REOPEN_SGR_LENGTH + 4 + 1) / 2 = 34.5.
 */
const SIZE_K = 35
const SIZE_C = 64

function assertSizeBound(out: string, input: string): void {
  if (out.length > SIZE_K * input.length + SIZE_C) {
    throw new Error(`output ${out.length} > ${SIZE_K}x input ${input.length} + ${SIZE_C}`)
  }
}

/** The safety property: only `\n`, printable text, and `ESC [` digits/`;` `m`. */
function assertSafe(out: string, input: string): void {
  for (let i = 0; i < out.length; i += 1) {
    const c = out.charCodeAt(i)
    if (c === 0x1b) {
      const m = /^\x1b\[[0-9;]*m/.exec(out.slice(i))
      if (m === null) throw new Error(`unsafe ESC at ${i} for input ${JSON.stringify(input)}`)
      i += m[0].length - 1
      continue
    }
    if ((c < 0x20 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f)) {
      throw new Error(
        `unsafe code point 0x${c.toString(16)} at ${i} for input ${JSON.stringify(input)}`,
      )
    }
  }
}

describe("sanitizeScrollbackText: hostile samples", () => {
  test("CSI erase display is dropped", () => {
    expect(sanitizeScrollbackText("a\x1b[2Jb")).toBe("ab")
  })

  test("OSC 52 clipboard write is dropped (BEL and ST terminators)", () => {
    expect(sanitizeScrollbackText("a\x1b]52;c;QkFTRTY0\x07b")).toBe("ab")
    expect(sanitizeScrollbackText("a\x1b]52;c;QkFTRTY0\x1b\\b")).toBe("ab")
    expect(sanitizeScrollbackText("a\u009d52;c;QkFTRTY0\u009cb")).toBe("ab")
  })

  test("OSC 0 window title is dropped", () => {
    expect(sanitizeScrollbackText("a\x1b]0;title\x07b")).toBe("ab")
    expect(sanitizeScrollbackText("a\x1b]0;title\x1b\\b")).toBe("ab")
  })

  test("a bare CR becomes a line break, CRLF is one break", () => {
    expect(sanitizeScrollbackLines("progress 10%\rprogress 20%")).toEqual([
      "progress 10%",
      "progress 20%",
    ])
    expect(sanitizeScrollbackLines("a\r\nb")).toEqual(["a", "b"])
    expect(sanitizeScrollbackLines("a\r\rb")).toEqual(["a", "", "b"])
    expect(sanitizeScrollbackText("a\n\r\nb")).toBe("a\n\nb")
  })

  test("BEL is dropped", () => {
    expect(sanitizeScrollbackText("ding\x07dong\x07")).toBe("dingdong")
  })

  test("C1 controls are dropped, with the sequences they start", () => {
    expect(sanitizeScrollbackText("a\u009b2Jb")).toBe("ab")
    expect(sanitizeScrollbackText("a\u0090q;payload\u009cb")).toBe("ab")
    expect(sanitizeScrollbackText("a\u0085b\u008dc")).toBe("abc")
    // A C1 CSI that looks like an SGR is still dropped (only 7-bit SGR is kept).
    expect(sanitizeScrollbackText("a\u009b31mb")).toBe("ab")
  })

  test("DCS, SOS, PM and APC strings are dropped up to ST", () => {
    expect(sanitizeScrollbackText("a\x1bP1$r0m\x1b\\b")).toBe("ab")
    expect(sanitizeScrollbackText("a\x1bPq#0;2;0;0;0\x07still dcs\x1b\\b")).toBe("ab")
    expect(sanitizeScrollbackText("a\x1bXsos\x1b\\b")).toBe("ab")
    expect(sanitizeScrollbackText("a\x1b^pm\x1b\\b")).toBe("ab")
    expect(sanitizeScrollbackText("a\x1b_Gf=100;AAAA\x1b\\b")).toBe("ab")
  })

  test("a partial escape at the end is dropped", () => {
    expect(sanitizeScrollbackText("abc\x1b[3")).toBe("abc")
    expect(sanitizeScrollbackText("abc\x1b")).toBe("abc")
    expect(sanitizeScrollbackText("abc\x1b]0;tit")).toBe("abc")
    expect(sanitizeScrollbackText("abc\x1bP")).toBe("abc")
    expect(sanitizeScrollbackText("abc\u009b")).toBe("abc")
  })
})

describe("sanitizeScrollbackText: what is kept", () => {
  test("a lone surrogate becomes U+FFFD; two halves never join", () => {
    expect(sanitizeScrollbackText("a\ud800b\udc00")).toBe("a\ufffdb\ufffd")
    expect(sanitizeScrollbackText("\ud83c\x1b[2J\udf89")).toBe("\ufffd\ufffd")
    expect(stripAllTerminalControls("x\ud800")).toBe("x\ufffd")
  })

  test("plain unicode text and newlines are unchanged", () => {
    const s = "Stop → run-tests.sh · 日本\nemoji 🎉 e\u0301\n"
    expect(sanitizeScrollbackText(s)).toBe(s)
  })

  test("closed SGR is kept as is", () => {
    const s = "a \x1b[1;31mred\x1b[0m b \x1b[38;5;208mx\x1b[m"
    expect(sanitizeScrollbackText(s)).toBe(s)
  })

  test("CSI that is not a plain SGR is dropped", () => {
    expect(sanitizeScrollbackText("a\x1b[?25lb")).toBe("ab")
    expect(sanitizeScrollbackText("a\x1b[38:2:1:2:3mb")).toBe("ab")
    expect(sanitizeScrollbackText("a\x1b[5;10Hb\x1b[Kc\x1b[6n")).toBe("abc")
    expect(sanitizeScrollbackText("a\x1b[1 mb")).toBe("ab")
  })

  test("other escapes, C0 controls and DEL are dropped", () => {
    expect(sanitizeScrollbackText("a\x1bcb\x1b(Bc\x1b7d\x1b8")).toBe("abcd")
    expect(sanitizeScrollbackText("a\x00\x01\x08\x0b\x0c\x7fb")).toBe("ab")
  })

  test("CAN and SUB cancel a sequence; the rest is text", () => {
    expect(sanitizeScrollbackText("a\x1b[3\x18Xb")).toBe("aXb")
    expect(sanitizeScrollbackText("a\x1b]0;t\x1aXb")).toBe("aXb")
  })

  test("DEL inside a CSI is ignored; a C0 control is executed and the CSI goes on", () => {
    expect(sanitizeScrollbackText("a\x1b[\x7f31mb")).toBe("a\x1b[31mb\x1b[0m")
    expect(sanitizeScrollbackLines("a\x1b[3\n1mb")).toEqual(["a", `\x1b[31mb${R}`])
    expect(sanitizeScrollbackLines("a\x1b[3\r\n1mb")).toEqual(["a", `\x1b[31mb${R}`])
    expect(sanitizeScrollbackText("a\x1b[3\x07\x001mb")).toBe("a\x1b[31mb\x1b[0m")
    expect(sanitizeScrollbackText("a\x1b[2\x7fJb")).toBe("ab")
  })

  test("tabs expand to stops of 8 from the row start, SGR is zero width", () => {
    expect(sanitizeScrollbackText("\tx")).toBe("        x")
    expect(sanitizeScrollbackText("ab\tx\ncd\x1b[31m\tx\x1b[0m")).toBe(
      "ab      x\ncd\x1b[31m      x\x1b[0m",
    )
    expect(sanitizeScrollbackText("漢\tx")).toBe(`漢${" ".repeat(6)}x`)
    // A dropped escape takes no column.
    expect(sanitizeScrollbackText("a\x1b]0;long title\x07\tx")).toBe(`a${" ".repeat(7)}x`)
  })
})

describe("sanitizeScrollbackLines: SGR closes at each row end", () => {
  test("an open style is closed and reopened on the next row", () => {
    expect(sanitizeScrollbackLines("\x1b[31mred\nstill red\x1b[0m\nplain")).toEqual([
      `\x1b[31mred${R}`,
      "\x1b[31mstill red\x1b[0m",
      "plain",
    ])
  })

  test("several open styles are carried as one merged SGR", () => {
    expect(sanitizeScrollbackLines("\x1b[1m\x1b[32mA\rB")).toEqual([
      `\x1b[1m\x1b[32mA${R}`,
      `\x1b[1;32mB${R}`,
    ])
    expect(sanitizeScrollbackLines("\x1b[31;44m\x1b[38;5;208;3mA\nB\x1b[23;49m\nC")).toEqual([
      `\x1b[31;44m\x1b[38;5;208;3mA${R}`,
      `\x1b[3;38;5;208;44mB\x1b[23;49m${R}`,
      `\x1b[38;5;208mC${R}`,
    ])
    expect(sanitizeScrollbackLines("\x1b[1;2;4m\x1b[22;48;2;1;2;3mA\nB")).toEqual([
      `\x1b[1;2;4m\x1b[22;48;2;1;2;3mA${R}`,
      `\x1b[4;48;2;1;2;3mB${R}`,
    ])
  })

  test("the last value per attribute wins; 39 and 49 reset the colour", () => {
    expect(sanitizeScrollbackLines("\x1b[31mA\x1b[32m\x1b[39m\nB")).toEqual([
      `\x1b[31mA\x1b[32m\x1b[39m${R}`,
      "B",
    ])
    expect(sanitizeScrollbackLines("\x1b[41;31mA\x1b[32;49m\nB")).toEqual([
      `\x1b[41;31mA\x1b[32;49m${R}`,
      `\x1b[32mB${R}`,
    ])
  })

  test("unknown and underline-colour parameters are not carried", () => {
    expect(sanitizeScrollbackLines("\x1b[58;5;1;1;73mA\nB")).toEqual([
      `\x1b[58;5;1;1;73mA${R}`,
      `\x1b[1mB${R}`,
    ])
    // Not carried, but the row that sets them still closes with a reset.
    expect(sanitizeScrollbackLines("\x1b[73;59mA\nB")).toEqual([`\x1b[73;59mA${R}`, "B"])
  })

  test("bold set before 32 colours is still carried", () => {
    const colours = Array.from({ length: 32 }, (_, k) => `\x1b[38;5;${k}m`).join("")
    expect(sanitizeScrollbackLines(`\x1b[1m${colours}A\nB`)[1]).toBe(`\x1b[1;38;5;31mB${R}`)
  })

  test("the carried prefix is bounded: no output amplification", () => {
    const longSgrs = Array.from({ length: 32 }, (_, k) => {
      const p = `38;5;${k}${";1".repeat(27)}`
      return `\x1b[${p.slice(0, 64)}m`
    }).join("")
    const every = "\x1b[1;2;3;4;5;7;8;9;53;38;2;255;255;255;48;2;255;255;255m"
    for (const prefix of [longSgrs, every, `${longSgrs}${every}`]) {
      const input = `${prefix}${"x\n".repeat(2000)}`
      const rows = sanitizeScrollbackLines(input)
      for (const row of rows.slice(1, -1)) {
        expect(row.length).toBeLessThanOrEqual(MAX_REOPEN_SGR_LENGTH + 1 + R.length)
      }
      assertSizeBound(rows.join("\n"), input)
    }
    // The widest style opens with one SGR of the documented length.
    const widest = "\x1b[1;2;3;21;6;7;8;9;53;38;2;255;255;255;48;2;255;255;255mA\nB"
    expect(sanitizeScrollbackLines(widest)[1]?.length).toBe(MAX_REOPEN_SGR_LENGTH + 1 + R.length)
  })

  test("an empty row in a styled block stays empty", () => {
    expect(sanitizeScrollbackLines("\x1b[33ma\n\nb")).toEqual([
      `\x1b[33ma${R}`,
      "",
      `\x1b[33mb${R}`,
    ])
  })

  test("a reset in the middle ends the carry; ESC[m, ESC[00m and ESC[;m are resets", () => {
    expect(sanitizeScrollbackLines("\x1b[31ma\x1b[mb\nc")).toEqual(["\x1b[31ma\x1b[mb", "c"])
    expect(sanitizeScrollbackLines("\x1b[31ma\x1b[00m\nc")).toEqual(["\x1b[31ma\x1b[00m", "c"])
    expect(sanitizeScrollbackLines("\x1b[31ma\x1b[;m\nc")).toEqual(["\x1b[31ma\x1b[;m", "c"])
    // A 0 inside the list resets what comes before it.
    expect(sanitizeScrollbackLines("\x1b[1;31;0;32ma\nc")).toEqual([
      `\x1b[1;31;0;32ma${R}`,
      `\x1b[32mc${R}`,
    ])
  })

  test("a trailing newline gives a last empty row", () => {
    expect(sanitizeScrollbackLines("a\n")).toEqual(["a", ""])
    expect(sanitizeScrollbackLines("")).toEqual([""])
  })

  test("no row of the output leaves a style open", () => {
    const rows = sanitizeScrollbackLines("\x1b[1;4;35mA\rB\x1b[22m\nC\tD\x1b]0;x\x07\nE")
    for (const row of rows) {
      const seqs = row.match(/\x1b\[[0-9;]*m/g) ?? []
      if (seqs.length === 0) continue
      expect(/^\x1b\[[0;]*m$/.test(seqs.at(-1) ?? "")).toBe(true)
    }
  })
})

describe("stripAllTerminalControls", () => {
  test("drops SGR too and turns breaks and tabs into one space", () => {
    expect(stripAllTerminalControls("x\x1b[31mRED\ny\x1b]0;title\x07z\t\x00\x7f\x9b2Jq")).toBe(
      "xRED yz q",
    )
    expect(stripAllTerminalControls("l\x1b[1ma\r")).toBe("la ")
    expect(stripAllTerminalControls("Stop → run-tests.sh · 日本")).toBe(
      "Stop → run-tests.sh · 日本",
    )
  })
})

/** mulberry32: a small seeded PRNG, so a failure is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FRAGMENTS = [
  "\x1b",
  "\x1b[",
  "\x1b]",
  "\x1bP",
  "\x1bX",
  "\x1b^",
  "\x1b_",
  "\x1b\\",
  "\x1b[31m",
  "\x1b[0m",
  "\x1b[1;38;5;208m",
  "\x1b[2J",
  "\x1b[?1049h",
  "\x1b]52;c;QUJD\x07",
  "\x1b]8;;https://x\x1b\\",
  "\x1b(B",
  "\x1b[38:2::1:2:3m",
  // An SGR at the 64-parameter limit (kept) and one past it (dropped).
  `\x1b[${"1;".repeat(32).slice(0, 64)}m`,
  `\x1b[${"1;".repeat(33)}m`,
  `\x1b[38;5;${"9".repeat(70)}m`,
  "\x1b[;m",
  "\x1b[3\x7f1m",
  "\x1b[3\n1m",
  // Lone surrogates.
  "\ud800",
  "\udc00",
  "\udfff\ud83c",
  "\r\n",
  "\t",
  ";",
  "m",
  "[",
  "\\",
  "0",
  "9",
]
const TEXT = ["a", "Z", " ", "é", "漢", "🎉", "→", "\u0301"]

function randomInput(rand: () => number): string {
  const n = Math.floor(rand() * 40)
  let s = ""
  for (let k = 0; k < n; k += 1) {
    const r = rand()
    if (r < 0.3) s += String.fromCharCode(Math.floor(rand() * 0x20))
    else if (r < 0.35) s += "\x7f"
    else if (r < 0.5) s += String.fromCharCode(0x80 + Math.floor(rand() * 0x20))
    else if (r < 0.8) s += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]
    else s += TEXT[Math.floor(rand() * TEXT.length)]
  }
  return s
}

describe("sanitizeScrollbackText: property", () => {
  test("5000 random inputs give only text, \\n and plain SGR", () => {
    const rand = mulberry32(0x5eed_42)
    for (let n = 0; n < 5000; n += 1) {
      const input = randomInput(rand)
      const out = sanitizeScrollbackText(input)
      assertSafe(out, input)
      assertSizeBound(out, input)
      // Idempotent: a safe text passes through unchanged.
      expect(sanitizeScrollbackText(out)).toBe(out)
      // Every printable code point of the output was in the input.
      for (const ch of out.replace(/\x1b\[[0-9;]*m/g, "")) {
        if (ch !== "\n" && ch !== " " && ch !== "\ufffd") expect(input.includes(ch)).toBe(true)
      }
    }
  })

  test("random inputs: no row ends with a style open", () => {
    const rand = mulberry32(7)
    for (let n = 0; n < 2000; n += 1) {
      const input = randomInput(rand)
      for (const row of sanitizeScrollbackLines(input)) {
        const seqs = row.match(/\x1b\[[0-9;]*m/g) ?? []
        if (seqs.length > 0) expect(/^\x1b\[[0;]*m$/.test(seqs.at(-1) ?? "")).toBe(true)
        expect(row.includes("\n")).toBe(false)
      }
    }
  })
})
