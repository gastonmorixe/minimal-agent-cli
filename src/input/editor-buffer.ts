/**
 * Pure model of a multiline text buffer with a single cursor.
 *
 * Extracted from {@link RawInput} so the editor state can live independently
 * of the raw-mode keystroke pump and the terminal renderer. Used by the
 * Compositor-driven persistent editor: the controller mutates the buffer
 * and asks the renderer to repaint the live area.
 *
 * All position units are unicode code points (matching `Array.from(line)`),
 * so emoji and other multi-code-unit characters count as one column.
 *
 * Atomic spans (paste plugin v3, D2): an injected span source gives the chip
 * spans of a line (`paste/chip-registry.ts`). A span moves, deletes and counts
 * as one unit, and the cursor never stops inside a span.
 *
 * @module editor-buffer
 */

import type { ChipSpan } from "../paste/chip-registry.ts"

/** The atomic spans of one line, in code points. A source must be pure. */
export type SpanSource = (line: string) => readonly ChipSpan[]

const NO_SPANS: readonly ChipSpan[] = []

/**
 * Multiline text buffer plus cursor, with all mutation methods (insert,
 * delete, cursor movement) operating in code-point columns. Holds no terminal
 * or rendering state, which keeps it unit-testable and lets the controller
 * and renderer evolve independently.
 */
export class EditorBuffer {
  private linesValue: string[] = [""]
  private rowValue = 0
  private colValue = 0
  private spanSource: SpanSource | null = null
  /** The spans of each row, with the line text they were computed for. */
  private spanCache: ({ text: string; spans: readonly ChipSpan[] } | undefined)[] = []

  /**
   * Make an empty buffer.
   *
   * @param spanSource - The atomic span source. Omitted: no spans (each code
   *   point is one unit, the old behavior).
   */
  constructor(spanSource?: SpanSource) {
    this.spanSource = spanSource ?? null
  }

  /**
   * Install (or with `null`, remove) the span source. Drops the span cache and
   * moves the cursor out of a span.
   */
  setSpanSource(source: SpanSource | null): void {
    this.spanSource = source
    this.invalidateSpans()
  }

  /**
   * Compute the spans of each line again, for example after a chip label
   * change. The cursor moves back out of a span.
   */
  invalidateSpans(): void {
    this.spanCache = []
    this.snapCursor("back")
  }

  /**
   * The atomic spans of `row`, sorted, not overlapping and inside the line.
   * The buffer computes them again when the line text changes.
   */
  spansOfRow(row: number): readonly ChipSpan[] {
    const text = this.linesValue[row]
    if (this.spanSource === null || text === undefined || text.length === 0) return NO_SPANS
    const hit = this.spanCache[row]
    if (hit !== undefined && hit.text === text) return hit.spans
    const spans = this.computeSpans(text)
    this.spanCache[row] = { text, spans }
    return spans
  }

  get lines(): readonly string[] {
    return this.linesValue
  }

  get row(): number {
    return this.rowValue
  }

  // W-1: the named writers at input.ts ~:855-875 write a LineBuffer (the plain
  // REPL), not an EditorBuffer, so these snapping setters do not cover them.

  /** Clamps to the buffer, then moves the cursor back out of a span (W-1). */
  set row(value: number) {
    this.rowValue = Math.max(0, Math.min(value, this.linesValue.length - 1))
    this.colValue = Math.min(this.colValue, this.lineLength(this.rowValue))
    this.snapCursor("back")
  }

  get col(): number {
    return this.colValue
  }

  /**
   * Clamps to the line, then moves the cursor out of a span (W-1): to its end
   * when the cursor moves right, else to its start.
   */
  set col(value: number) {
    const previous = this.colValue
    this.colValue = Math.max(0, Math.min(value, this.lineLength(this.rowValue)))
    this.snapCursor(this.colValue > previous ? "forward" : "back")
  }

  toString(): string {
    return this.linesValue.join("\n")
  }

  /**
   * `true` only for the brand-new empty single-line buffer. A multi-line
   * buffer made of whitespace is *real content* the user composed and must
   * not be silently wiped by Ctrl+C / Enter heuristics. See the matching
   * `RawInput.isBlankBuffer` for the same rationale.
   */
  isBlank(): boolean {
    return this.linesValue.length === 1 && this.linesValue[0].length === 0
  }

  clear(): void {
    this.linesValue = [""]
    this.rowValue = 0
    this.colValue = 0
    this.spanCache = []
  }

  insert(text: string): boolean {
    if (text.length === 0) return false
    const [before, after] = this.splitAt(this.linesValue[this.rowValue], this.colValue)
    this.linesValue[this.rowValue] = before + text + after
    this.colValue += this.charLength(text)
    this.snapCursor("forward")
    return true
  }

  newline(): boolean {
    const [before, after] = this.splitAt(this.linesValue[this.rowValue], this.colValue)
    this.linesValue.splice(this.rowValue, 1, before, after)
    this.rowValue += 1
    this.colValue = 0
    return true
  }

  deleteBackward(): boolean {
    if (this.colValue > 0) {
      const start = this.spanEndingAt(this.rowValue, this.colValue)?.start ?? this.colValue - 1
      this.linesValue[this.rowValue] = this.removeRange(
        this.linesValue[this.rowValue],
        start,
        this.colValue,
      )
      this.colValue = start
      this.snapCursor("back")
      return true
    }
    if (this.rowValue === 0) return false
    const previous = this.linesValue[this.rowValue - 1]
    const current = this.linesValue[this.rowValue]
    const previousLength = this.charLength(previous)
    this.linesValue.splice(this.rowValue - 1, 2, previous + current)
    this.rowValue -= 1
    this.colValue = previousLength
    this.snapCursor("back")
    return true
  }

  deleteForward(): boolean {
    const line = this.linesValue[this.rowValue]
    const lineLength = this.charLength(line)
    if (this.colValue < lineLength) {
      const end = this.spanStartingAt(this.rowValue, this.colValue)?.end ?? this.colValue + 1
      this.linesValue[this.rowValue] = this.removeRange(line, this.colValue, end)
      this.snapCursor("back")
      return true
    }
    if (this.rowValue >= this.linesValue.length - 1) return false
    this.linesValue.splice(this.rowValue, 2, line + this.linesValue[this.rowValue + 1])
    this.snapCursor("back")
    return true
  }

  moveLeft(): boolean {
    if (this.colValue > 0) {
      this.colValue = this.spanEndingAt(this.rowValue, this.colValue)?.start ?? this.colValue - 1
      return true
    }
    if (this.rowValue === 0) return false
    this.rowValue -= 1
    this.colValue = this.lineLength(this.rowValue)
    return true
  }

  moveRight(): boolean {
    const lineLength = this.lineLength(this.rowValue)
    if (this.colValue < lineLength) {
      this.colValue = this.spanStartingAt(this.rowValue, this.colValue)?.end ?? this.colValue + 1
      return true
    }
    if (this.rowValue >= this.linesValue.length - 1) return false
    this.rowValue += 1
    this.colValue = 0
    return true
  }

  moveUp(): boolean {
    if (this.rowValue === 0) return false
    this.rowValue -= 1
    this.colValue = Math.min(this.colValue, this.lineLength(this.rowValue))
    this.snapCursor("back")
    return true
  }

  moveDown(): boolean {
    if (this.rowValue >= this.linesValue.length - 1) return false
    this.rowValue += 1
    this.colValue = Math.min(this.colValue, this.lineLength(this.rowValue))
    this.snapCursor("back")
    return true
  }

  moveLineStart(): boolean {
    if (this.colValue === 0) return false
    this.colValue = 0
    return true
  }

  moveLineEnd(): boolean {
    const next = this.lineLength(this.rowValue)
    if (this.colValue === next) return false
    this.colValue = next
    return true
  }

  moveWordLeft(): boolean {
    const [row, col] = this.scanWordLeft(this.rowValue, this.colValue)
    if (row === this.rowValue && col === this.colValue) return false
    this.rowValue = row
    this.colValue = col
    return true
  }

  moveWordRight(): boolean {
    const [row, col] = this.scanWordRight(this.rowValue, this.colValue)
    if (row === this.rowValue && col === this.colValue) return false
    this.rowValue = row
    this.colValue = col
    return true
  }

  killToLineEnd(): boolean {
    const lineLength = this.lineLength(this.rowValue)
    if (this.colValue < lineLength) {
      this.linesValue[this.rowValue] = this.sliceChars(
        this.linesValue[this.rowValue],
        0,
        this.colValue,
      )
      return true
    }
    if (this.rowValue >= this.linesValue.length - 1) return false
    this.linesValue.splice(
      this.rowValue,
      2,
      this.linesValue[this.rowValue] + this.linesValue[this.rowValue + 1],
    )
    this.snapCursor("back")
    return true
  }

  killToLineStart(): boolean {
    if (this.colValue === 0) return false
    this.linesValue[this.rowValue] = this.sliceChars(this.linesValue[this.rowValue], this.colValue)
    this.colValue = 0
    this.snapCursor("back")
    return true
  }

  deleteWordBackward(): boolean {
    const endRow = this.rowValue
    const endCol = this.colValue
    const [startRow, startCol] = this.scanWordLeft(endRow, endCol)
    if (startRow === endRow && startCol === endCol) return false
    if (startRow === endRow) {
      const chars = this.lineChars(endRow)
      this.linesValue[endRow] = chars.slice(0, startCol).join("") + chars.slice(endCol).join("")
    } else {
      const startChars = this.lineChars(startRow)
      const endChars = this.lineChars(endRow)
      const merged = startChars.slice(0, startCol).join("") + endChars.slice(endCol).join("")
      this.linesValue.splice(startRow, endRow - startRow + 1, merged)
    }
    this.rowValue = startRow
    this.colValue = startCol
    this.snapCursor("back")
    return true
  }

  lineLength(row: number): number {
    return this.charLength(this.linesValue[row])
  }

  /**
   * Walk left from (row, col) over one "word", treating line breaks as
   * whitespace so cursor / delete motions cross line boundaries the same
   * way they would in any normal multi-line editor (VS Code, micro, nano,
   * macOS Terminal's word-left, etc.).
   *
   * Phase 1 eats whitespace to the left, hopping to the end of the
   * previous line when col reaches 0. Phase 2 then eats non-whitespace
   * until the next whitespace or buffer start. Stays put when there is
   * nothing to the left.
   */
  private scanWordLeft(row: number, col: number): [number, number] {
    let r = row
    let c = col
    let chars = this.lineChars(r)
    while (true) {
      if (c === 0) {
        if (r === 0) break
        r -= 1
        chars = this.lineChars(r)
        c = chars.length
        continue
      }
      if (this.spanEndingAt(r, c)) break
      if (!this.isWhitespace(chars[c - 1])) break
      c -= 1
    }
    // A span is one word of its own: the scan stops at its edges.
    const span = this.spanEndingAt(r, c)
    if (span) return [r, span.start]
    while (c > 0) {
      if (this.isWhitespace(chars[c - 1]) || this.spanEndingAt(r, c)) break
      c -= 1
    }
    return [r, c]
  }

  /**
   * Mirror of {@link scanWordLeft} going forward. Treats newlines as
   * whitespace so the scan hops to the start of the next line when col
   * reaches the line's end.
   */
  private scanWordRight(row: number, col: number): [number, number] {
    let r = row
    let c = col
    let chars = this.lineChars(r)
    while (true) {
      if (c === chars.length) {
        if (r === this.linesValue.length - 1) break
        r += 1
        chars = this.lineChars(r)
        c = 0
        continue
      }
      if (this.spanStartingAt(r, c)) break
      if (!this.isWhitespace(chars[c])) break
      c += 1
    }
    const span = this.spanStartingAt(r, c)
    if (span) return [r, span.end]
    while (c < chars.length) {
      if (this.isWhitespace(chars[c]) || this.spanStartingAt(r, c)) break
      c += 1
    }
    return [r, c]
  }

  /** The span of `row` that ends at `col`, if any (binary search). */
  private spanEndingAt(row: number, col: number): ChipSpan | undefined {
    const spans = this.spansOfRow(row)
    if (spans.length === 0) return undefined
    const s = spans[firstSpanEndingAtOrAfter(spans, col)]
    return s !== undefined && s.end === col ? s : undefined
  }

  /** The span of `row` that starts at `col`, if any (binary search). */
  private spanStartingAt(row: number, col: number): ChipSpan | undefined {
    const spans = this.spansOfRow(row)
    if (spans.length === 0) return undefined
    const s = spans[firstSpanEndingAtOrAfter(spans, col + 1)]
    return s !== undefined && s.start === col ? s : undefined
  }

  /**
   * Move the cursor out of a span that holds it: to the span end
   * (`forward`) or to its start (`back`). No span: no change.
   */
  private snapCursor(direction: "forward" | "back"): void {
    const spans = this.spansOfRow(this.rowValue)
    if (spans.length === 0) return
    const s = spans[firstSpanEndingAtOrAfter(spans, this.colValue + 1)]
    if (s !== undefined && this.colValue > s.start && this.colValue < s.end) {
      this.colValue = direction === "forward" ? s.end : s.start
    }
  }

  /** The valid spans of `text` from the source: sorted, inside the line, no overlap. */
  private computeSpans(text: string): readonly ChipSpan[] {
    let raw: readonly ChipSpan[]
    try {
      raw = this.spanSource?.(text) ?? NO_SPANS
    } catch {
      return NO_SPANS
    }
    if (raw.length === 0) return NO_SPANS
    const length = this.charLength(text)
    const sorted = [...raw].sort((a, b) => a.start - b.start)
    const out: ChipSpan[] = []
    let last = 0
    for (const s of sorted) {
      if (!Number.isInteger(s.start) || !Number.isInteger(s.end)) continue
      if (s.start < last || s.end <= s.start || s.end > length) continue
      out.push(s)
      last = s.end
    }
    return out.length === 0 ? NO_SPANS : out
  }

  private lineChars(row: number): string[] {
    return Array.from(this.linesValue[row])
  }

  private charLength(text: string): number {
    return Array.from(text).length
  }

  private splitAt(text: string, index: number): [string, string] {
    const chars = Array.from(text)
    return [chars.slice(0, index).join(""), chars.slice(index).join("")]
  }

  private sliceChars(text: string, start: number, end?: number): string {
    return Array.from(text).slice(start, end).join("")
  }

  private removeRange(text: string, start: number, end: number): string {
    const chars = Array.from(text)
    return chars.slice(0, start).join("") + chars.slice(end).join("")
  }

  private isWhitespace(char: string): boolean {
    return /\s/u.test(char)
  }
}

/**
 * The index of the first span with `end >= col`, or `spans.length`. The spans
 * are sorted and do not overlap, so their ends are sorted too.
 */
function firstSpanEndingAtOrAfter(spans: readonly ChipSpan[], col: number): number {
  let lo = 0
  let hi = spans.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (spans[mid]!.end < col) lo = mid + 1
    else hi = mid
  }
  return lo
}
