import { afterEach, describe, expect, it } from "bun:test"

import type {
  CodeHighlighter,
  CodeHighlightRequest,
  UnifiedDiffHighlightRequest,
} from "../formatter/mdstream-code-highlighter.ts"
import { c } from "../style/ansi.ts"

import { highlightReadBody, highlightUnifiedDiff } from "./code-highlight-render.ts"
import {
  _resetDiffWrapLinesForTest,
  newFileDisplay,
  newFileNumberedBody,
  renderDiffRows,
  setDiffWrapLines,
} from "./diff-rows.ts"
import { formatToolPreview } from "./format.ts"

/**
 * Regression tests for the diff background wash after the numbered,
 * wrapping diff row layout (`diff-rows.ts`). Every check replays SGR state
 * cell by cell, the way a terminal does, instead of guessing from substrings.
 */

const RESET = "\x1b[0m"
/** `cols` for formatToolPreview: body width = 45 - 4 (gutter) - 1 (safety) = 40. */
const COLS = 45
const BODY_WIDTH = 40
/** Width of the transcript frame gutter (`  │ `) before the body. */
const FRAME_W = 4

afterEach(() => {
  _resetDiffWrapLinesForTest()
})

/** One visible cell with the SGR state that paints it. */
interface Cell {
  ch: string
  bg: string
  dim: boolean
}

interface RowCells {
  cells: Cell[]
  bgAtStart: string
  bgAtEnd: string
}

interface SgrState {
  bg: string
  dim: boolean
}

/**
 * Apply one SGR parameter list (ECMA-48, with xterm 38/48 extended colors).
 * Handles `;` and `:` separators. Only background and dim are tracked.
 */
function applySgrParams(state: SgrState, raw: string): void {
  if (raw === "") {
    state.bg = "default"
    state.dim = false
    return
  }
  // Colon sub-parameters belong to their 38/48 parent: fold them into one token.
  const tokens = raw.split(";")
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.includes(":")) {
      const parts = token.split(":")
      if (parts[0] === "48") state.bg = token
      continue
    }
    const n = token === "" ? 0 : Number(token)
    if (n === 0) {
      state.bg = "default"
      state.dim = false
    } else if (n === 2) state.dim = true
    else if (n === 22) state.dim = false
    else if (n === 49) state.bg = "default"
    else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) state.bg = String(n)
    else if (n === 38 || n === 48) {
      const mode = tokens[i + 1]
      const take = mode === "2" ? 4 : mode === "5" ? 2 : 0
      const args = tokens.slice(i + 1, i + 1 + take)
      if (n === 48 && take > 0) state.bg = `48;${args.join(";")}`
      i += take
    }
  }
}

/** Replay rows top to bottom. A newline does not reset SGR, so state carries. */
function replay(rows: string[]): RowCells[] {
  const state: SgrState = { bg: "default", dim: false }
  const out: RowCells[] = []
  for (const row of rows) {
    const bgAtStart = state.bg
    const cells: Cell[] = []
    for (let i = 0; i < row.length; ) {
      if (row.charCodeAt(i) === 0x1b && row[i + 1] === "[") {
        let j = i + 2
        while (j < row.length && !/[\x40-\x7e]/.test(row[j]!)) j++
        if (row[j] === "m") applySgrParams(state, row.slice(i + 2, j))
        i = j + 1
        continue
      }
      const cp = row.codePointAt(i)!
      const ch = String.fromCodePoint(cp)
      cells.push({ ch, bg: state.bg, dim: state.dim })
      i += ch.length
    }
    out.push({ cells, bgAtStart, bgAtEnd: state.bg })
  }
  return out
}

function plain(cells: Cell[]): string {
  return cells.map((cell) => cell.ch).join("")
}

/** Fallback stand-in: one foreground plus full reset per token, as in the wash tests. */
const tokenHighlighter: CodeHighlighter = {
  warmup: async () => true,
  async highlight({ code }: CodeHighlightRequest) {
    return code
      .split("\n")
      .map((line) =>
        line
          .split(/(\s+)/)
          .filter((part) => part.length > 0)
          .map((part) => `\x1b[38;2;123;167;255m${part}${RESET}`)
          .join(""),
      )
      .join("\n")
  },
  close: async () => {},
}

function hexTriple(hex: string | undefined, fallback: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? "")
  if (!m) return fallback
  return [m[1]!, m[2]!, m[3]!].map((part) => Number.parseInt(part, 16)).join(";")
}

/**
 * Native stand-in in the mdstream v0.3.6 bg-wash shape: bright marker
 * foreground, full reset, the raw accent as row background, then only
 * foreground switches with the background left open at end of row.
 */
const nativeHighlighter: CodeHighlighter = {
  warmup: async () => true,
  highlight: async () => null,
  async highlightUnifiedDiff({ code, colors }: UnifiedDiffHighlightRequest) {
    const ins = hexTriple(colors?.inserted, "135;255;0")
    const del = hexTriple(colors?.deleted, "255;0;175")
    const tokens = (text: string): string =>
      text
        .split(/(\s+)/)
        .filter((part) => part.length > 0)
        .map((part) => `\x1b[38;2;232;238;250m${part}`)
        .join("")
    return code
      .split("\n")
      .map((line) => {
        if (line.startsWith("@@")) return `\x1b[38;2;0;255;255m${line}${RESET}`
        const rest = line.slice(1)
        if (line.startsWith("+"))
          return `\x1b[38;2;${ins}m+${RESET}\x1b[48;2;${ins}m${tokens(rest)}`
        if (line.startsWith("-"))
          return `\x1b[38;2;${del}m-${RESET}\x1b[48;2;${del}m${tokens(rest)}`
        return ` ${tokens(rest)}${RESET}`
      })
      .join("\n")
  },
  close: async () => {},
}

const PATHS: Array<[string, CodeHighlighter]> = [
  ["fallback", tokenHighlighter],
  ["native", nativeHighlighter],
]

const LONG_ADD = "+const added = computeSomething(alpha, beta, gamma) + anotherCall(delta, epsilon)"
const LONG_DEL =
  "-const removed = computeOther(alpha, beta, gamma) - anotherCall(delta, epsilon, zeta)"

/** One hunk, a long - row and a long + row that both wrap at BODY_WIDTH. */
const WRAP_PATCH = ["@@ -1,3 +1,3 @@", " const keep = 1", LONG_DEL, LONG_ADD].join("\n")

/** Two hunks, so the second `@@` becomes a `⋯` row. Ends on a + row. */
const TWO_HUNK_PATCH = [
  "@@ -1,2 +1,2 @@",
  LONG_DEL,
  LONG_ADD,
  " const keep = 1",
  "@@ -20,2 +20,2 @@",
  " const other = 2",
  "-const z = 3",
  LONG_ADD,
].join("\n")

async function renderEdit(patch: string, highlighter: CodeHighlighter): Promise<string[]> {
  const display = await highlightUnifiedDiff(patch, "typescript", highlighter)
  expect(display).not.toBeNull()
  return formatToolPreview(patch, false, display!, { tool: "Edit", cols: COLS })
}

/** Body cells of a frame row (the ` │ ` gutter removed). */
function body(row: RowCells): Cell[] {
  return row.cells.slice(FRAME_W)
}

/**
 * Group the transcript rows into logical diff rows: a row whose number
 * column holds a digit opens a group, and blank-number rows continue it.
 */
function groups(rows: RowCells[], numW: number): RowCells[][] {
  const out: RowCells[][] = []
  for (const row of rows) {
    const cells = body(row)
    const num = plain(cells.slice(0, numW))
    if (/\d/.test(num)) out.push([row])
    else if (num.trim() === "" && cells.length > numW + 2 && out.length > 0) out.at(-1)!.push(row)
  }
  return out
}

/** The group whose first row carries `marker` in the marker column. */
function groupFor(all: RowCells[][], numW: number, marker: string): RowCells[] {
  const found = all.find((g) => body(g[0]!)[numW + 1]?.ch === marker && g.length > 1)
  expect(found, `expected a wrapped ${marker} row`).toBeDefined()
  return found!
}

/** Payload cells of a fragment: after the number column, space, and marker column. */
function payload(row: RowCells, numW: number): Cell[] {
  return body(row).slice(numW + 2)
}

describe.each(PATHS)("diff row wash (%s path)", (_name, highlighter) => {
  for (const marker of ["+", "-"]) {
    it(`1. re-opens the same wash on every continuation of a wrapped ${marker} row`, async () => {
      const rows = replay(await renderEdit(WRAP_PATCH, highlighter))
      const numW = 1
      const group = groupFor(groups(rows, numW), numW, marker)
      const wash = payload(group[0]!, numW)[0]!.bg
      expect(wash, "the first payload cell must be washed").not.toBe("default")
      for (const frag of group.slice(1)) {
        const first = payload(frag, numW)[0]
        expect(first, "a continuation fragment must carry payload").toBeDefined()
        expect(first!.bg, `continuation ${JSON.stringify(plain(frag.cells))}`).toBe(wash)
      }
    })

    it(`2. washes the payload to its last glyph on every fragment of a ${marker} row`, async () => {
      const rows = replay(await renderEdit(WRAP_PATCH, highlighter))
      const numW = 1
      const group = groupFor(groups(rows, numW), numW, marker)
      const wash = payload(group[0]!, numW)[0]!.bg
      for (const frag of group) {
        const cells = payload(frag, numW)
        expect(cells.length).toBeGreaterThan(0)
        const unwashed = cells.findIndex((cell) => cell.bg !== wash)
        expect(unwashed, `plain cell inside ${JSON.stringify(plain(frag.cells))}`).toBe(-1)
      }
    })

    it(`5. leaves the number cell and the continuation marker column of a ${marker} row unwashed`, async () => {
      const rows = replay(await renderEdit(WRAP_PATCH, highlighter))
      const numW = 1
      const group = groupFor(groups(rows, numW), numW, marker)
      for (const [i, frag] of group.entries()) {
        const cells = body(frag)
        const gutterW = i === 0 ? numW + 1 : numW + 2
        for (const cell of cells.slice(0, gutterW)) expect(cell.bg).toBe("default")
        for (const cell of frag.cells.slice(0, FRAME_W)) expect(cell.bg).toBe("default")
      }
    })
  }

  it("3. closes the background on every row, so no frame gutter inherits a wash", async () => {
    const raw = await renderEdit(TWO_HUNK_PATCH, highlighter)
    const rows = replay(raw)
    const plains = rows.map((row) => plain(row.cells))
    expect(
      plains.some((p) => p.includes("⋯")),
      "the two-hunk Edit must show a ⋯ row",
    ).toBe(true)
    expect(plains.at(-1)!.startsWith("  ╰"), "the last row must be the ╰ closer").toBe(true)
    expect(
      rows.some((row) => row.cells.some((cell) => cell.bg !== "default")),
      "precondition: some row must carry a wash",
    ).toBe(true)
    for (const [i, row] of rows.entries()) {
      const where = `row ${i}: ${JSON.stringify(raw[i])}`
      expect(row.bgAtStart, where).toBe("default")
      expect(row.bgAtEnd, where).toBe("default")
      for (const cell of row.cells.slice(0, FRAME_W)) expect(cell.bg, where).toBe("default")
    }
  })

  it("4. draws the cut hint with no wash active", async () => {
    setDiffWrapLines(2)
    const rows = replay(await renderEdit(WRAP_PATCH, highlighter))
    const hintRows = rows.filter((row) => /\.\.\.\(\+\d+ch\)/.test(plain(row.cells)))
    expect(hintRows.length, "both long rows must be cut").toBe(2)
    for (const row of hintRows) {
      const text = plain(row.cells)
      const start = text.search(/\.\.\.\(\+\d+ch\)/)
      const hint = row.cells.slice(start)
      expect(hint.length).toBeGreaterThan(0)
      for (const cell of hint) {
        expect(cell.bg, `hint in ${JSON.stringify(text)}`).toBe("default")
        expect(cell.dim, `hint must be dim in ${JSON.stringify(text)}`).toBe(true)
      }
      // The kept payload before the hint stays washed.
      expect(row.cells[start - 1]!.bg).not.toBe("default")
    }
  })

  it("7. keeps a row that fits byte-identical after the number gutter", async () => {
    const patch = ["@@ -1,2 +1,2 @@", "-const a = 1", "+const a = 2"].join("\n")
    const display = await highlightUnifiedDiff(patch, "typescript", highlighter)
    expect(display).not.toBeNull()
    const lines = display!.split("\n")
    const out = renderDiffRows(lines, BODY_WIDTH, 5, { hideHunkHeaders: true })
    expect(out).toEqual([`${c.dim("1")} ${lines[1]}`, `${c.dim("1")} ${lines[2]}`])
  })
})

describe("new-file Write preview", () => {
  const patch = [
    "@@ -0,0 +1,3 @@",
    "+const first = 1",
    "+const second = computeSomething(alpha, beta, gamma) + anotherCall(delta)",
    "+const third = 3",
  ].join("\n")

  async function displays(): Promise<Array<[string, string]>> {
    const highlighted = await highlightReadBody(
      newFileNumberedBody(patch),
      "typescript",
      tokenHighlighter,
    )
    expect(highlighted).not.toBeNull()
    return [
      ["plain", newFileDisplay(patch).display],
      ["highlighted", newFileDisplay(patch, highlighted).display],
    ]
  }

  it("6. has no addition wash on any row, with or without a highlighter", async () => {
    for (const [name, display] of await displays()) {
      const raw = formatToolPreview(patch, false, display, { tool: "Write", cols: COLS })
      const rows = replay(raw)
      expect(rows.length, name).toBeGreaterThan(3)
      expect(
        raw.some((row) => row.includes("\x1b[48")),
        name,
      ).toBe(false)
      for (const [i, row] of rows.entries()) {
        const where = `${name} row ${i}: ${JSON.stringify(raw[i])}`
        expect(row.bgAtStart, where).toBe("default")
        for (const cell of row.cells) expect(cell.bg, where).toBe("default")
        expect(plain(row.cells).includes("+const"), where).toBe(false)
      }
    }
  })
})
