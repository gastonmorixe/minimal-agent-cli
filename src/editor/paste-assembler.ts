/**
 * Whole-paste assembly for a bracketed paste (paste plugin v3, D5).
 *
 * A large paste arrives as many stdin chunks. The dispatcher pushes each chunk
 * here after the `ESC[200~` start marker. The assembler collects the text until
 * the `ESC[201~` end marker, so the paste hook chain runs ONE time, with the
 * whole text.
 *
 * - The end marker can be split across two chunks. The assembler keeps the
 *   partial marker tail (at most 5 code units) and joins it to the next chunk.
 *   It never scans the collected text again.
 * - The text after the end marker in the same chunk is given back as `rest`.
 * - A nested start marker (`ESC[200~`) in the paste text is removed (some
 *   terminals and the PTY driver repeat it in each chunk). Hooks never see a
 *   raw marker. A start marker split across chunks is held like the end tail.
 * - Over the size cap (default 32 MB), the assembler stops the collect step.
 *   It sends one warning and gives the text back as `spill`, to insert as
 *   literal text. The paste is never dropped, and the chain does not run.
 *
 * @module editor/paste-assembler
 */

import { trailingPrefixLength } from "../input/key-codec.ts"
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from "./types.ts"

/** The default collect cap: 32 MB of UTF-8. */
export const PASTE_ASSEMBLY_CAP_BYTES = 32 * 1024 * 1024

/** The result of one {@link PasteAssembler.push}. */
export interface PastePush {
  /** True when this chunk had the end marker. Then call {@link PasteAssembler.finish}. */
  done: boolean
  /** The text after the end marker in this chunk (empty when not done). */
  rest: string
  /** Over the cap only: text to insert as literal text now. Else empty. */
  spill: string
}

/** Options for {@link PasteAssembler}. */
export interface PasteAssemblerOptions {
  /** The collect cap in UTF-8 bytes. Default {@link PASTE_ASSEMBLY_CAP_BYTES}. */
  capBytes?: number
  /** Called one time for each paste that goes over the cap. */
  onCap?: (capBytes: number) => void
}

/** Collects one bracketed paste at a time. */
export class PasteAssembler {
  private parts: string[] = []
  private tail = ""
  private count = 0
  private over = false
  /** Over the cap: a CR held back, so a CRLF split across chunks stays one newline. */
  private heldCr = ""
  private readonly capBytes: number
  private readonly onCap: ((capBytes: number) => void) | undefined

  constructor(opts: PasteAssemblerOptions = {}) {
    this.capBytes = opts.capBytes ?? PASTE_ASSEMBLY_CAP_BYTES
    this.onCap = opts.onCap
  }

  /** The UTF-8 bytes of paste text seen so far (the marker tail not included). */
  get bytes(): number {
    return this.count
  }

  /** True when the current paste went over the cap (the chain must not run). */
  get overflowed(): boolean {
    return this.over
  }

  /** Add one chunk of paste text (the start marker already removed). */
  push(chunk: string): PastePush {
    const s = this.tail + chunk
    this.tail = ""
    const idx = s.indexOf(BRACKETED_PASTE_END)
    let body: string
    let rest = ""
    if (idx !== -1) {
      body = s.slice(0, idx)
      rest = s.slice(idx + BRACKETED_PASTE_END.length)
    } else {
      const keep = Math.max(
        trailingPrefixLength(s, BRACKETED_PASTE_END),
        trailingPrefixLength(s, BRACKETED_PASTE_START),
      )
      body = s.slice(0, s.length - keep)
      this.tail = s.slice(s.length - keep)
    }
    const done = idx !== -1
    if (body.includes(BRACKETED_PASTE_START)) body = body.replaceAll(BRACKETED_PASTE_START, "")
    if (body.length > 0) {
      this.count += Buffer.byteLength(body, "utf8")
      if (!this.over) this.parts.push(body)
    }
    let spill = ""
    if (!this.over && this.count > this.capBytes) {
      this.over = true
      this.onCap?.(this.capBytes)
      spill = this.parts.join("")
      this.parts = []
    } else if (this.over) {
      spill = body
    }
    if (this.over) {
      spill = this.heldCr + spill
      this.heldCr = ""
      if (!done && spill.endsWith("\r")) {
        this.heldCr = "\r"
        spill = spill.slice(0, -1)
      }
    }
    return { done, rest, spill }
  }

  /**
   * Take the whole paste text and reset for the next paste. Over the cap the
   * text went out as `spill`, so this gives "".
   */
  finish(): string {
    const text = this.over ? this.heldCr : this.parts.join("")
    this.reset()
    return text
  }

  /**
   * Take the text of a paste that has no end marker (the idle timeout), with
   * the held marker tail, and reset. Over the cap, only the held part is left.
   */
  abandon(): string {
    const text = (this.over ? this.heldCr : this.parts.join("")) + this.tail
    this.reset()
    return text
  }

  /** Drop the paste in progress (stop or dispose). */
  abort(): void {
    this.reset()
  }

  private reset(): void {
    this.parts = []
    this.tail = ""
    this.count = 0
    this.over = false
    this.heldCr = ""
  }
}
