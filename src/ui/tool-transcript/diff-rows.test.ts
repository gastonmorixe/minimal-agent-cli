import { afterEach, describe, expect, it } from "bun:test"

import { buildFileDiff } from "@minimal-agent/core/host/diff"
import { displayWidth, stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { renderUnifiedDiff } from "../../terminal-kit/unified-diff.ts"
import {
  _resetDiffWrapLinesForTest,
  DIFF_WRAP_LINES_DEFAULT,
  isNewFileDisplay,
  newFileDisplay,
  newFileNumberedBody,
  parseDiffWrapLines,
  renderDiffRows,
  renderNewFileRows,
  setDiffWrapLines,
  wrapDiffRow,
  wrapPreserving,
} from "./diff-rows.ts"
import { formatToolPreview } from "./format.ts"

afterEach(() => _resetDiffWrapLinesForTest())

const plain = (rows: string[]) => rows.map((r) => stripAnsi(r))

describe("renderDiffRows — line numbers", () => {
  it("numbers removed rows by old line and added/context rows by new line", () => {
    const patch = "--- a/f\n+++ b/f\n@@ -29,4 +29,5 @@\n ctx\n-old\n+new\n+more\n tail\n tail2"
    const rows = plain(renderDiffRows(patch.split("\n"), undefined))
    expect(rows).toEqual([
      "   --- a/f",
      "   +++ b/f",
      "   @@ -29,4 +29,5 @@",
      "29  ctx",
      "30 -old",
      "30 +new",
      "31 +more",
      "32  tail",
      "33  tail2",
    ])
  })

  it("does not take a removed `--x` row inside a hunk for a file header", () => {
    const patch = "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n--- removed\n+++ added"
    const rows = plain(renderDiffRows(patch.split("\n"), undefined))
    expect(rows.slice(3)).toEqual(["1 --- removed", "1 +++ added"])
  })

  it("leaves a title row above the diff without a number column", () => {
    const lines = ["New file: /x", "────", "--- a/x", "+++ b/x", "@@ -0,0 +1,1 @@", "+hi"]
    const rows = plain(renderDiffRows(lines, undefined))
    expect(rows[0]).toBe("New file: /x")
    expect(rows[5]).toBe("1 +hi")
  })

  it("dims the line number", () => {
    const rows = renderDiffRows(["@@ -7,1 +7,1 @@", " x"], undefined)
    expect(rows[1]).toContain("\x1b[2m7")
  })
})

describe("wrapPreserving", () => {
  it("keeps every character and the inner spacing", () => {
    const row = "    a  b  " + "word ".repeat(20)
    const frags = wrapPreserving(row, 20)
    expect(frags.join("")).toBe(row)
    for (const f of frags) expect(displayWidth(f)).toBeLessThanOrEqual(20)
  })

  it("carries the open style onto each continuation and closes each fragment", () => {
    const row = `\x1b[48;2;29;56;0m${"x ".repeat(30)}\x1b[49m`
    const frags = wrapPreserving(row, 10)
    expect(frags.length).toBeGreaterThan(1)
    for (const f of frags.slice(1)) expect(f.startsWith("\x1b[48;2;29;56;0m")).toBe(true)
    for (const f of frags.slice(0, -1)) expect(f.endsWith("\x1b[0m")).toBe(true)
  })
})

describe("wrapDiffRow — cap and cut", () => {
  it("wraps up to the cap without a hint", () => {
    const frags = wrapDiffRow("y".repeat(50), 10, 5)
    expect(frags.length).toBe(5)
    expect(plain(frags).join("")).toBe("y".repeat(50))
  })

  it("cuts past the cap with a DIM `...(+Nch)` hint that counts every cut char", () => {
    const frags = wrapDiffRow(`\x1b[32m+${"z".repeat(99)}\x1b[39m`, 20, 2)
    expect(frags.length).toBe(2)
    const last = frags[1]!
    // Full reset, then the hint inside a dim run, so it never inherits color.
    expect(last).toMatch(/\x1b\[0m\x1b\[2m\.\.\.\(\+\d+ch\)\x1b\[22m$/)
    const shown = plain(frags)
      .join("")
      .replace(/\.\.\.\(\+\d+ch\)$/, "")
    const cut = Number(/\(\+(\d+)ch\)/.exec(stripAnsi(last))![1])
    expect(shown.length + cut).toBe(100)
    for (const f of frags) expect(displayWidth(f)).toBeLessThanOrEqual(20)
  })
})

describe("diff wrap cap config", () => {
  it("defaults to 5", () => {
    expect(DIFF_WRAP_LINES_DEFAULT).toBe(5)
  })

  it("parses only positive integers", () => {
    expect(parseDiffWrapLines("3")).toBe(3)
    expect(parseDiffWrapLines(8)).toBe(8)
    for (const bad of ["0", "-1", "2.5", "abc", "", undefined, 0, null]) {
      expect(parseDiffWrapLines(bad)).toBeUndefined()
    }
  })

  it("setDiffWrapLines changes how many rows formatToolPreview gives one diff line", () => {
    const patch = `@@ -1,1 +1,1 @@\n+${"q".repeat(400)}`
    const display = renderUnifiedDiff(patch)
    // Edit hides the `@@` row, so the count is the wrapped row only.
    const count = () => formatToolPreview("m", false, display, { tool: "Edit", cols: 60 }).length
    expect(count()).toBe(5)
    setDiffWrapLines(2)
    expect(count()).toBe(2)
    setDiffWrapLines(0) // ignored
    expect(count()).toBe(2)
  })
})

describe("renderDiffRows — wrapped rows align under the payload", () => {
  it("puts continuation rows under the text, not under the +/- marker", () => {
    const row = `+${"word ".repeat(20)}`
    const rows = plain(renderDiffRows(["@@ -1,0 +1,1 @@", row], 30))
    const body = rows.slice(1)
    expect(body.length).toBeGreaterThan(1)
    expect(body[0]!.startsWith("1 +word")).toBe(true)
    // Number column (1) + space + marker column (1) = text starts at col 3.
    for (const r of body.slice(1)) expect(r.startsWith("   word")).toBe(true)
    for (const r of body) expect(displayWidth(r)).toBeLessThanOrEqual(30)
  })
})

describe("Read and diff rows share one line-number gutter", () => {
  it("right-aligns Read numbers so the code column never jumps a tab stop", () => {
    const lines = formatToolPreview("999\ty\n1000\tz", false, undefined, { tool: "Read", cols: 80 })
    expect(plain(lines)).toEqual(["  │  999  y", "  ╰ 1000  z"])
  })

  it("puts Read code in the same column as diff context rows", () => {
    const read = plain(
      formatToolPreview("9\tx\n10\ty", false, undefined, { tool: "Read", cols: 80 }),
    )
    // Edit hides the `@@` row, so the rows compare one to one.
    const diff = plain(
      formatToolPreview("m", false, renderUnifiedDiff("@@ -9,2 +9,2 @@\n x\n y"), {
        tool: "Edit",
        cols: 80,
      }),
    )
    expect(diff).toEqual(read)
  })

  it("puts a new-file Write row in the same column as a Read row", () => {
    const read = plain(
      formatToolPreview("9\tx\n10\ty", false, undefined, { tool: "Read", cols: 80 }),
    )
    const content = Array.from({ length: 10 }, (_, i) => `r${i + 1}`).join("\n")
    const { display } = newFileDisplay(buildFileDiff("/a.txt", "", content, 0))
    const rows = plain(formatToolPreview("m", false, display, { tool: "Write", cols: 80 }))
    // Same code column as Read: `  │  9  x` / `  ╰ 10  y`.
    expect(read).toEqual(["  │  9  x", "  ╰ 10  y"])
    expect(rows.slice(-2)).toEqual(["  │  9  r9", "  ╰ 10  r10"])
  })
})

describe("renderDiffRows — hidden hunk headers (Edit, Write)", () => {
  const twoHunks = "@@ -2,2 +2,2 @@\n-a\n+A\n b\n@@ -40,2 +40,3 @@\n c\n-d\n+D\n+E"

  it("drops a single hunk header and keeps the numbers", () => {
    const rows = plain(
      renderDiffRows(["@@ -29,2 +29,2 @@", " ctx", "-old", "+new"], undefined, 5, {
        hideHunkHeaders: true,
      }),
    )
    expect(rows).toEqual(["29  ctx", "30 -old", "30 +new"])
  })

  it("puts one dim ⋯ row in the number column for each later hunk", () => {
    const raw = renderDiffRows(twoHunks.split("\n"), undefined, 5, { hideHunkHeaders: true })
    expect(plain(raw)).toEqual([
      " 2 -a",
      " 2 +A",
      " 3  b",
      " ⋯",
      "40  c",
      "41 -d",
      "41 +D",
      "42 +E",
    ])
    expect(raw[3]).toBe("\x1b[2m ⋯\x1b[22m")
  })

  it("keeps the @@ rows without the flag (ShowDiff)", () => {
    const rows = plain(renderDiffRows(twoHunks.split("\n"), undefined))
    expect(rows.filter((r) => r.includes("@@"))).toHaveLength(2)
    const shown = plain(
      formatToolPreview("m", false, renderUnifiedDiff(twoHunks), { tool: "ShowDiff" }),
    )
    expect(shown.filter((r) => r.includes("@@"))).toHaveLength(2)
  })

  it("hides @@ rows for Edit and Write in formatToolPreview", () => {
    for (const tool of ["Edit", "Write"]) {
      const shown = plain(formatToolPreview("m", false, renderUnifiedDiff(twoHunks), { tool }))
      expect(shown.some((r) => r.includes("@@"))).toBe(false)
      expect(shown.filter((r) => r.trim().endsWith("⋯"))).toHaveLength(1)
    }
  })
})

describe("new-file Write preview", () => {
  const file = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")
  const render = (n: number, cols = 80) => {
    const preview = newFileDisplay(buildFileDiff("/a.txt", "", file(n), 0))
    return {
      preview,
      rows: plain(
        formatToolPreview("m", false, preview.display, {
          tool: "Write",
          cols,
          footer: preview.footer,
        }),
      ),
    }
  }

  it("shows no + marker and no footer at 10 lines or fewer", () => {
    const { preview, rows } = render(10)
    expect(preview.footer).toBeUndefined()
    expect(rows[0]).toBe("  │ new file · 10 lines")
    expect(rows[1]).toBe("  │  1  line 1")
    expect(rows.at(-1)).toBe("  ╰ 10  line 10")
    expect(rows.some((r) => /^\s+│\s+\d+ \+/.test(r))).toBe(false)
    expect(rows.some((r) => r.includes("┊"))).toBe(false)
  })

  it("caps at 10 rows and ends with ┊ and a dim shown 10/N L footer", () => {
    const { preview, rows } = render(12)
    expect(preview.footer).toBe("\x1b[2mshown 10/12 L\x1b[22m")
    expect(rows).toHaveLength(1 + 10 + 2)
    expect(rows.at(-3)).toBe("  │ 10  line 10")
    expect(rows.at(-2)).toBe("  ┊")
    expect(rows.at(-1)).toBe("  ╰ shown 10/12 L")
  })

  it("has no addition color on the code", () => {
    const { display } = newFileDisplay(buildFileDiff("/a.txt", "", "x", 0))
    const rows = renderNewFileRows(display.split("\n"), undefined)
    expect(rows[1]).toBe("\x1b[2m1\x1b[22m  x")
  })

  it("wraps a long row under the code column", () => {
    const { display } = newFileDisplay(buildFileDiff("/a.txt", "", "word ".repeat(20), 0))
    const rows = plain(renderNewFileRows(display.split("\n"), 30))
    expect(rows[1]!.startsWith("1  word")).toBe(true)
    for (const r of rows.slice(2)) expect(r.startsWith("   word")).toBe(true)
    for (const r of rows) expect(displayWidth(r)).toBeLessThanOrEqual(30)
  })

  it("numbers the head of the file for highlightReadBody", () => {
    const patch = buildFileDiff("/a.txt", "", file(12), 0)
    expect(newFileNumberedBody(patch).split("\n")).toHaveLength(10)
    expect(newFileNumberedBody(patch).split("\n")[9]).toBe("10\tline 10")
  })
})

describe("wrapPreserving: width invariant", () => {
  it("breaks again when the tail kept after a space break leaves no room for a wide char", () => {
    const frags = wrapPreserving(" bcdefghij界xyz", 10)
    for (const f of frags) expect(displayWidth(f)).toBeLessThanOrEqual(10)
    expect(frags.join("")).toBe(" bcdefghij界xyz")
  })

  it("keeps an Edit row with a wide char inside the body width", () => {
    const display = renderUnifiedDiff("@@ -1,0 +1,1 @@\n+ " + "a".repeat(31) + "界zz")
    const rows = formatToolPreview("m", false, display, { tool: "Edit", cols: 40 })
    // Each row is the 4-cell gutter plus a body of at most cols - 5 = 35 cells.
    for (const r of rows) expect(displayWidth(r) - 4).toBeLessThanOrEqual(35)
  })

  it("keeps every fragment within width and every char, for random ASCII/CJK/emoji mixes", () => {
    // Deterministic LCG, so a failure replays the same case.
    let seed = 12345
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const pool = ["a", "b", " ", " ", "界", "字", "😀", "\x1b[32m", "\x1b[0m", "\x1b[48;2;1;2;3m"]
    for (let n = 0; n < 500; n++) {
      const width = 1 + rand(20)
      let text = ""
      const len = rand(60)
      for (let i = 0; i < len; i++) text += pool[rand(pool.length)]
      const frags = wrapPreserving(text, width)
      for (const f of frags) {
        // A single 2-cell char cannot fit a 1-cell width.
        expect(displayWidth(f)).toBeLessThanOrEqual(Math.max(width, 2))
      }
      expect(stripAnsi(frags.join(""))).toBe(stripAnsi(text))
    }
  })
})

describe("tabs in diff and new-file payloads", () => {
  it("expands tabs in a diff row so it fits the body width", () => {
    const rows = renderDiffRows(["@@ -1,0 +1,1 @@", "+\t\t\t\tfoo bar baz qux"], 30)
    expect(rows.length).toBeGreaterThan(1)
    for (const r of rows) {
      expect(r).not.toContain("\t")
      expect(displayWidth(r)).toBeLessThanOrEqual(30)
    }
  })

  it("puts diff payload tab stops on the terminal tab stops", () => {
    // Gutter 4 + number column 1 + space 1 + marker 1: payload starts at col 7.
    const rows = plain(renderDiffRows(["@@ -1,0 +1,1 @@", "+\tx"], 40))
    expect(rows[1]).toBe("1 + x")
  })

  it("expands tabs in a new-file row so it fits the body width", () => {
    const { display } = newFileDisplay(buildFileDiff("/a.txt", "", "\t\t\t\tfoo bar baz", 0))
    const rows = renderNewFileRows(display.split("\n"), 30)
    for (const r of rows) {
      expect(r).not.toContain("\t")
      expect(displayWidth(r)).toBeLessThanOrEqual(30)
    }
  })
})

describe("isNewFileDisplay", () => {
  it("accepts a newFileDisplay body", () => {
    const { display } = newFileDisplay(buildFileDiff("/a.txt", "", "x", 0))
    expect(isNewFileDisplay(display)).toBe(true)
  })

  it("rejects a display whose 2nd row is numbered but whose 1st row is not the summary", () => {
    expect(isNewFileDisplay("Wrote /a.txt\n1\tx")).toBe(false)
    expect(isNewFileDisplay("\x1b[2mnew file\x1b[22m\n1\tx")).toBe(false)
  })
})
