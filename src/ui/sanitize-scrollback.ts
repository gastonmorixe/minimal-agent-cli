/**
 * Sanitize untrusted text (for example a plugin's or a worker's output)
 * before it is written to the terminal scrollback.
 *
 * The scanner is a small state machine that follows the DEC/ECMA-48 parser
 * (https://vt100.net/emu/dec_ansi_parser) for where a sequence ends:
 *
 * - CSI is `ESC [` or C1 `0x9B`, then parameter bytes `0x30-0x3F`,
 *   intermediate bytes `0x20-0x2F`, and one final byte `0x40-0x7E`.
 * - OSC (`ESC ]`, `0x9D`), DCS (`ESC P`, `0x90`), SOS (`ESC X`, `0x98`),
 *   PM (`ESC ^`, `0x9E`) and APC (`ESC _`, `0x9F`) are control strings that
 *   end at ST (`ESC \` or `0x9C`). xterm also ends OSC at BEL
 *   (https://invisible-island.net/xterm/ctlseqs/ctlseqs.html).
 * - CAN (`0x18`) and SUB (`0x1A`) cancel a sequence; ESC starts a new one;
 *   a C1 control ends a control string ("anywhere" transitions).
 * - Inside a CSI, DEL is ignored and a C0 control is executed without
 *   ending the sequence (`csi entry` and `csi param` states): here `\n` and
 *   `\r` give a line break and every other C0 control is dropped.
 *
 * The output keeps only text, `\n`, and SGR sequences of the form
 * `ESC [ <digits and ;> m`. Everything else is dropped. Tabs become spaces
 * (stops of 8 from the row start, `expandTabs`). A lone surrogate becomes
 * U+FFFD. A bare `\r` is a line
 * break. Each row closes the SGR style it leaves open and the next row
 * opens it again with one merged SGR (see `SgrStyle`), so a style never
 * leaks past a row end and the reopened prefix stays short.
 *
 * `stripTerminalControls` (startup plugin rows) shares the scanner and
 * drops SGR too.
 *
 * @module ui/sanitize-scrollback
 */

import { expandTabs } from "@minimal-agent/core/plugin-api/utils/term-width"

/** The SGR reset written at the end of a row that leaves a style open. */
export const SCROLLBACK_SGR_RESET = "\x1b[0m"

/** A token from {@link scanTerminalText}. */
export type TerminalToken =
  | { readonly kind: "text"; readonly text: string }
  /** A complete, safe SGR sequence: `ESC [` digits and `;`, then `m`. */
  | { readonly kind: "sgr"; readonly seq: string }
  | { readonly kind: "tab" }
  /** `\n`, `\r\n`, or a bare `\r`. */
  | { readonly kind: "break" }

const ESC = 0x1b
const BEL = 0x07
const CAN = 0x18
const SUB = 0x1a
const C1_ST = 0x9c
const C1_CSI = 0x9b

/** The longest SGR parameter string that is kept. A longer one is dropped. */
const MAX_SGR_PARAMS = 64

/** Parser states. `osc` ends at BEL or ST; `str` (DCS, SOS, PM, APC) only at ST. */
type State = "ground" | "esc" | "csi" | "osc" | "str"

/** True for a C1 control code point (0x80-0x9F). */
function isC1(cp: number): boolean {
  return cp >= 0x80 && cp <= 0x9f
}

/** The string state a C1 introducer starts, or undefined. */
function c1StringState(cp: number): State | undefined {
  if (cp === 0x9d) return "osc"
  if (cp === 0x90 || cp === 0x98 || cp === 0x9e || cp === 0x9f) return "str"
  return undefined
}

/** The string state that `ESC <ch>` starts, or undefined. */
function escStringState(ch: string): State | undefined {
  if (ch === "]") return "osc"
  if (ch === "P" || ch === "X" || ch === "^" || ch === "_") return "str"
  return undefined
}

/** True when a CSI body (after `ESC [`) is a safe SGR: digits and `;`, final `m`. */
function isSafeSgrBody(body: string): boolean {
  if (!body.endsWith("m") || body.length - 1 > MAX_SGR_PARAMS) return false
  for (let i = 0; i < body.length - 1; i += 1) {
    const c = body.charCodeAt(i)
    if (!((c >= 0x30 && c <= 0x39) || c === 0x3b)) return false
  }
  return true
}

/**
 * Scan `text` and report its safe parts in order: text runs, safe SGR
 * sequences, tabs, and line breaks. Every other escape sequence, control
 * string, C0 control, DEL and C1 control is dropped. A sequence that is
 * still open at the end of the input is dropped.
 *
 * @param text - Untrusted text.
 * @param emit - Called once for each token, in order.
 */
export function scanTerminalText(text: string, emit: (token: TerminalToken) => void): void {
  let state: State = "ground"
  let run = ""
  /**
   * The CSI body so far (parameter and intermediate bytes, without the DEL
   * and C0 controls that the CSI ignores or executes). It stops growing
   * past `MAX_SGR_PARAMS + 1` characters: such a body is never kept.
   */
  let csiBody = ""
  /** True for a C1 CSI (`0x9B`): never kept, only 7-bit SGR is. */
  let csiC1 = false
  const flush = (): void => {
    if (run.length > 0) emit({ kind: "text", text: run })
    run = ""
  }
  let i = 0
  while (i < text.length) {
    const cp = text.codePointAt(i) ?? 0
    const ch = String.fromCodePoint(cp)
    const next = i + ch.length
    switch (state) {
      case "ground": {
        if (cp === ESC) {
          state = "esc"
        } else if (cp === C1_CSI) {
          state = "csi"
          csiC1 = true
          csiBody = ""
        } else if (isC1(cp)) {
          state = c1StringState(cp) ?? "ground"
        } else if (cp === 0x0a) {
          flush()
          emit({ kind: "break" })
        } else if (cp === 0x0d) {
          flush()
          emit({ kind: "break" })
          if (text.charCodeAt(next) === 0x0a) {
            i = next + 1
            continue
          }
        } else if (cp === 0x09) {
          flush()
          emit({ kind: "tab" })
        } else if (cp >= 0xd800 && cp <= 0xdfff) {
          // A lone surrogate becomes U+FFFD, as a UTF-8 encode would write it
          // (https://infra.spec.whatwg.org/#javascript-string-convert). Kept
          // as is, two halves split by a dropped sequence would join into a
          // code point that was not in the input.
          run += "\ufffd"
        } else if (cp >= 0x20 && cp !== 0x7f) {
          run += ch
        }
        // Every other C0 control (BEL included) and DEL: dropped.
        i = next
        continue
      }
      case "esc": {
        if (ch === "[") {
          state = "csi"
          csiC1 = false
          csiBody = ""
          i = next
          continue
        }
        const str = escStringState(ch)
        if (str !== undefined) {
          state = str
          i = next
          continue
        }
        if (cp >= 0x20 && cp <= 0x2f) {
          // Intermediate byte: stay in the escape until its final byte.
          i = next
          continue
        }
        if (cp >= 0x30 && cp <= 0x7e) {
          // Final byte of a two-byte (or intermediate) escape, ST included: dropped.
          state = "ground"
          i = next
          continue
        }
        // ESC restarts; anything else cancels the escape and is read again as text.
        if (cp !== ESC) state = "ground"
        if (cp === ESC || cp === CAN || cp === SUB) i = next
        continue
      }
      case "csi": {
        if (cp >= 0x20 && cp <= 0x3f) {
          if (csiBody.length <= MAX_SGR_PARAMS) csiBody += ch
          i = next
          continue
        }
        if (cp >= 0x40 && cp <= 0x7e) {
          if (!csiC1) {
            const body = csiBody + ch
            if (isSafeSgrBody(body)) {
              flush()
              emit({ kind: "sgr", seq: `\x1b[${body}` })
            }
          }
          state = "ground"
          i = next
          continue
        }
        if (cp === 0x7f) {
          // DEL inside a CSI is ignored (https://vt100.net/emu/dec_ansi_parser).
          i = next
          continue
        }
        if (cp < 0x20 && cp !== ESC && cp !== CAN && cp !== SUB) {
          // A C0 control inside a CSI is executed and the CSI goes on
          // (https://vt100.net/emu/dec_ansi_parser): a line break for `\n`,
          // `\r` and `\r\n`; every other C0 control is dropped.
          if (cp === 0x0a || cp === 0x0d) {
            flush()
            emit({ kind: "break" })
            if (cp === 0x0d && text.charCodeAt(next) === 0x0a) {
              i = next + 1
              continue
            }
          }
          i = next
          continue
        }
        // Not a CSI byte: cancel the sequence and read this code point again.
        state = cp === ESC ? "esc" : "ground"
        if (cp === ESC || cp === CAN || cp === SUB) i = next
        continue
      }
      case "osc":
      case "str": {
        if (cp === ESC) {
          // ESC ends the string; `ESC \` (ST) is then dropped by the escape state.
          state = "esc"
        } else if (cp === C1_ST || cp === CAN || cp === SUB || (state === "osc" && cp === BEL)) {
          state = "ground"
        } else if (isC1(cp)) {
          // Any other C1 control ends the string and is read again.
          state = "ground"
          continue
        }
        i = next
        continue
      }
    }
  }
  // A sequence still open here is dropped; only the text run is kept.
  flush()
}

/** True when an SGR has only `0` or empty parameters (`ESC[m`, `ESC[00m`, `ESC[;m`). */
function isPureSgrReset(seq: string): boolean {
  for (let i = 2; i < seq.length - 1; i += 1) if (seq[i] !== "0" && seq[i] !== ";") return false
  return true
}

/**
 * The longest SGR that opens a carried style at a row start: every flag
 * (`1;2;3;21;6;7;8;9;53`) and a direct-colour foreground and background
 * (`38;2;255;255;255`, `48;2;255;255;255`). 53 parameter characters, so it
 * is also short enough to be kept by {@link isSafeSgrBody} (idempotence).
 */
export const MAX_REOPEN_SGR_LENGTH = 56

/** A colour SGR value (`38;5;N`, `38;2;R;G;B`) is valid only up to 255 (xterm). */
const MAX_COLOR_VALUE = 255

/**
 * Read a colour in extended form (`38`, `48` or `58` then `5;N` or
 * `2;R;G;B`) at `params[at]`.
 *
 * @returns The canonical parameters (or undefined when the colour is not
 *   valid) and the number of parameters it uses, the introducer included.
 */
function readExtendedColor(
  params: readonly number[],
  at: number,
): { readonly value: string | undefined; readonly used: number } {
  const kind = params[at]
  const mode = params[at + 1]
  const count = mode === 5 ? 1 : mode === 2 ? 3 : 0
  if (count === 0) return { value: undefined, used: Math.min(2, params.length - at) }
  const values = params.slice(at + 2, at + 2 + count)
  const used = 2 + values.length
  if (values.length < count || values.some((v) => v > MAX_COLOR_VALUE)) {
    return { value: undefined, used }
  }
  return { value: [kind, mode, ...values].join(";"), used }
}

/**
 * The open SGR style, folded into one last value per attribute class.
 *
 * Attributes from https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
 * (`CSI Pm m`): `0` (and an empty parameter, its default) resets all;
 * `1` bold and `2` faint, both ended by `22`; `3`/`23` italic; `4` and `21`
 * (double) underline, ended by `24`; `5` (and `6`, rapid blink, ECMA-48) blink,
 * ended by `25`; `7`/`27` inverse; `8`/`28` hidden; `9`/`29` crossed out;
 * `30-37`, `90-97`, `38;5;N`, `38;2;R;G;B` foreground, `39` default;
 * `40-47`, `100-107`, `48;...` background, `49` default. `6` (rapid
 * blink) and `53`/`55` (overlined, not overlined) are from ECMA-48 5th
 * edition. `58` is reserved there; it is read in the `38`/`48` form and
 * skipped with its values, so they are not taken as attributes, and it is
 * not carried. Unknown parameters (`59` included) are ignored. Only the carried prefix uses this fold: the SGR bytes in a row
 * are kept as they are.
 */
class SgrStyle {
  private bold = false
  private faint = false
  private italic = false
  private underline: "4" | "21" | undefined
  private blink: "5" | "6" | undefined
  private inverse = false
  private hidden = false
  private strike = false
  private overline = false
  private fg: string | undefined
  private bg: string | undefined

  /** Reset every attribute. */
  private reset(): void {
    this.bold = false
    this.faint = false
    this.italic = false
    this.underline = undefined
    this.blink = undefined
    this.inverse = false
    this.hidden = false
    this.strike = false
    this.overline = false
    this.fg = undefined
    this.bg = undefined
  }

  /** Fold one safe SGR sequence (`ESC [` digits and `;`, then `m`). */
  apply(seq: string): void {
    const params = seq
      .slice(2, -1)
      .split(";")
      .map((p) => (p === "" ? 0 : Number.parseInt(p, 10)))
    let i = 0
    while (i < params.length) {
      const p = params[i] ?? 0
      if (p === 38 || p === 48 || p === 58) {
        const { value, used } = readExtendedColor(params, i)
        if (value !== undefined && p === 38) this.fg = value
        if (value !== undefined && p === 48) this.bg = value
        i += used
        continue
      }
      this.applyOne(p)
      i += 1
    }
  }

  /** Fold one plain parameter (not `38`, `48` or `58`). */
  private applyOne(p: number): void {
    if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) this.fg = String(p)
    else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) this.bg = String(p)
    switch (p) {
      case 0:
        this.reset()
        return
      case 1:
        this.bold = true
        return
      case 2:
        this.faint = true
        return
      case 22:
        this.bold = false
        this.faint = false
        return
      case 3:
      case 23:
        this.italic = p === 3
        return
      case 4:
      case 21:
        this.underline = p === 4 ? "4" : "21"
        return
      case 24:
        this.underline = undefined
        return
      case 5:
      case 6:
        this.blink = p === 5 ? "5" : "6"
        return
      case 25:
        this.blink = undefined
        return
      case 7:
      case 27:
        this.inverse = p === 7
        return
      case 8:
      case 28:
        this.hidden = p === 8
        return
      case 9:
      case 29:
        this.strike = p === 9
        return
      case 53:
      case 55:
        this.overline = p === 53
        return
      case 39:
        this.fg = undefined
        return
      case 49:
        this.bg = undefined
        return
    }
  }

  /** One SGR that opens this style, or "" for the default style. */
  reopen(): string {
    const parts: string[] = []
    if (this.bold) parts.push("1")
    if (this.faint) parts.push("2")
    if (this.italic) parts.push("3")
    if (this.underline !== undefined) parts.push(this.underline)
    if (this.blink !== undefined) parts.push(this.blink)
    if (this.inverse) parts.push("7")
    if (this.hidden) parts.push("8")
    if (this.strike) parts.push("9")
    if (this.overline) parts.push("53")
    if (this.fg !== undefined) parts.push(this.fg)
    if (this.bg !== undefined) parts.push(this.bg)
    return parts.length === 0 ? "" : `\x1b[${parts.join(";")}m`
  }
}

/**
 * Sanitize untrusted text into scrollback rows.
 *
 * Each row has only text, spaces and SGR sequences (`ESC [` digits and `;`,
 * then `m`). Tabs are expanded with stops of 8 from the row start. A row
 * that leaves a style open ends with {@link SCROLLBACK_SGR_RESET}, and the
 * next non-empty row starts with the open style again, as ONE merged SGR
 * (at most {@link MAX_REOPEN_SGR_LENGTH} code units). The SGR bytes inside a
 * row are kept as they are. A bare `\r` and
 * `\r\n` are line breaks, like `\n`. The result has one row more than the
 * number of line breaks (`"a\n"` gives `["a", ""]`).
 *
 * @param text - Untrusted text.
 * @returns The rows, without `\n`.
 */
export function sanitizeScrollbackLines(text: string): string[] {
  const rows: string[] = []
  const style = new SgrStyle()
  let row = ""
  let hasTab = false
  let hasContent = false
  /**
   * True when the row may leave a style open: it reopens a carried style,
   * or its last SGR is not a pure reset (only `0` or empty parameters).
   * An attribute that is not carried (an unknown parameter, `58`) still
   * gets the closing reset.
   */
  let rowOpen = false
  const startRow = (): void => {
    row = style.reopen()
    rowOpen = row !== ""
    hasTab = false
    hasContent = false
  }
  const endRow = (): void => {
    let out = hasContent ? row : ""
    if (hasContent && hasTab) out = expandTabs(out, 0)
    if (hasContent && rowOpen) out += SCROLLBACK_SGR_RESET
    rows.push(out)
  }
  startRow()
  scanTerminalText(text, (token) => {
    switch (token.kind) {
      case "text":
        row += token.text
        hasContent = true
        return
      case "tab":
        row += "\t"
        hasTab = true
        hasContent = true
        return
      case "sgr":
        row += token.seq
        hasContent = true
        style.apply(token.seq)
        rowOpen = !isPureSgrReset(token.seq)
        return
      case "break":
        endRow()
        startRow()
        return
    }
  })
  endRow()
  return rows
}

/**
 * Sanitize untrusted text for the terminal scrollback. The result is
 * {@link sanitizeScrollbackLines} joined with `\n`: it holds no control
 * code point except `\n` and the ESC of a kept SGR sequence, and no row
 * leaves a style open.
 *
 * @param text - Untrusted text.
 * @returns The safe text.
 */
export function sanitizeScrollbackText(text: string): string {
  return sanitizeScrollbackLines(text).join("\n")
}

/**
 * Strip all terminal control content from a short label: every escape
 * sequence and control string (SGR too), every C0 control, DEL and C1
 * control. A tab or a line break (`\n`, `\r\n`, bare `\r`) becomes one
 * space so words stay apart. A lone surrogate becomes U+FFFD.
 *
 * @param text - Untrusted text.
 * @returns Plain text on one line.
 */
export function stripAllTerminalControls(text: string): string {
  let out = ""
  scanTerminalText(text, (token) => {
    if (token.kind === "text") out += token.text
    else if (token.kind !== "sgr") out += " "
  })
  return out
}
