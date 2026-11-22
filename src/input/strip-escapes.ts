/**
 * Remove terminal escape sequences from text that is shown or inserted as
 * plain text (the tail of a bracketed paste, a chip label).
 *
 * @module input/strip-escapes
 */

/** The byte after ESC that starts a string control (OSC, DCS, SOS, PM, APC). */
const STRING_CONTROL_INTRO = new Set(["]", "P", "X", "^", "_"])

/** The C1 control CSI (U+009B), the one-byte form of `ESC [`. */
const C1_CSI = "\x9b"

/** The index after the CSI parameters and final byte that start at `from`. */
function csiEnd(s: string, from: number): number {
  let j = from
  while (j < s.length) {
    const k = s.charCodeAt(j)
    if (k >= 0x40 && k <= 0x7e) return j + 1
    // A byte that cannot be in a CSI ends it (and stays as text).
    if (k < 0x20 || k > 0x3f) return j
    j++
  }
  return j
}

/**
 * Remove whole escape sequences from `s`: CSI (`ESC [` or C1 `U+009B`,
 * params, final byte), SS3 (`ESC O` + one char), string controls (`ESC ]`,
 * `ESC P`, ... up to BEL or `ESC \\`), and `ESC` + one char. An incomplete
 * sequence at the end is removed too. Other bytes stay as they are.
 */
export function stripEscapeSequences(s: string): string {
  if (!s.includes("\x1b") && !s.includes(C1_CSI)) return s
  let out = ""
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === C1_CSI) {
      i = csiEnd(s, i + 1)
      continue
    }
    if (ch !== "\x1b") {
      out += ch
      i++
      continue
    }
    const intro = s[i + 1]
    if (intro === undefined) break
    if (intro === "[") {
      i = csiEnd(s, i + 2)
    } else if (intro === "O") {
      i = Math.min(s.length, i + 3)
    } else if (STRING_CONTROL_INTRO.has(intro)) {
      const bel = s.indexOf("\x07", i + 2)
      const st = s.indexOf("\x1b\\", i + 2)
      const ends = [bel === -1 ? -1 : bel + 1, st === -1 ? -1 : st + 2].filter((n) => n !== -1)
      i = ends.length > 0 ? Math.min(...ends) : s.length
    } else {
      const cp = s.codePointAt(i + 1) ?? 0
      i = i + 1 + (cp > 0xffff ? 2 : 1)
    }
  }
  return out
}
