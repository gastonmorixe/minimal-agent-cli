import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

import {
  type CodeHighlighter,
  type CodeHighlightRequest,
  createMdstreamCodeHighlighter,
  lineEndsWithOpenBackground,
} from "../formatter/mdstream-code-highlighter.ts"

import { highlightReadBody, highlightUnifiedDiff } from "./code-highlight-render.ts"
import { formatToolPreview } from "./format.ts"

/**
 * Deterministic stand-in highlighter: one foreground/reset pair per source
 * line. The rendered rows therefore carry a KNOWN escape shape and the test
 * never depends on the real mdstream sidecar binary.
 */
const fakeHighlighter: CodeHighlighter = {
  warmup: async () => true,
  async highlight({ code }: CodeHighlightRequest) {
    return code
      .split("\n")
      .map((line) => `\x1b[38;2;1;2;3m${line}\x1b[0m`)
      .join("\n")
  },
  // No native unified-diff mode: force the local compositor path under test.
  close: async () => {},
}

/**
 * The LAST body row is an addition, which is the shape that showed the bug: an
 * Edit whose final diff row is a `+` left the wash open, so the frame row below
 * it inherited a green background.
 */
const PATCH = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +1,2 @@", "-const a = 1", "+const a = 2"].join(
  "\n",
)

/**
 * The probe's patch: the LAST body row is a CONTEXT row, so a fix that only
 * closes the tail leaves the `+` row open and the closer still inherits its
 * wash. This is the shape that proves the close belongs in every changed row,
 * not just the last one.
 */
const PATCH_ENDING_IN_CONTEXT = [
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -1,2 +1,3 @@",
  "-const a = 1",
  "+const a = 2",
  " const b = 3",
].join("\n")

const BG = /\x1b\[48;2;\d+;\d+;\d+m/g
const RESET = "\x1b[0m"
/** Any SGR escape with its parameter body captured. */
const SGR = /\x1b\[([0-9;:]*)m/g
/** One or more leading SGR escapes, stripped to reach the visible text. */
const LEADING_SGR = /^(?:\x1b\[[0-9;:]*m)+/
/** Any SGR escape, stripped to reach the visible text with its gutter. */
const ANY_SGR = /\x1b\[[0-9;:]*m/g
const GUTTER_GLYPHS = ["\u2502", "\u2570"]

/**
 * mdstream is optional. Resolve it from the environment first so CI or another
 * machine can point at its own build, then fall back to the standard local
 * install. The native test skips (with a stated reason) when neither exists.
 */
function resolveMdstreamBin(): string | null {
  const configured = process.env.MINIMAL_AGENT_MDSTREAM_BIN
  const candidates = configured
    ? [configured]
    : [join(process.env.HOME ?? "", ".minimal-agent", "bin", "mdstream")]
  for (const candidate of candidates) {
    if (candidate.length > 0 && existsSync(candidate)) return candidate
  }
  return null
}

const MDSTREAM_BIN = resolveMdstreamBin()
const MDSTREAM_MISSING = MDSTREAM_BIN === null
const NATIVE_TEST_TITLE = MDSTREAM_MISSING
  ? [
      "keeps every frame gutter on the default background on the native mdstream path",
      `SKIPPED: no mdstream binary. Set MINIMAL_AGENT_MDSTREAM_BIN or install ${join(
        process.env.HOME ?? "~",
        ".minimal-agent/bin/mdstream",
      )}. The native wash cannot be exercised without the real highlighter.`,
    ].join(" :: ")
  : "keeps every frame gutter on the default background on the native mdstream path"

function lastIndexOfBackground(line: string): number {
  let last = -1
  for (const match of line.matchAll(BG)) last = match.index ?? -1
  return last
}

function lastIndexOfReset(line: string): number {
  return line.lastIndexOf(RESET)
}

/**
 * THE PROPERTY THAT ACTUALLY MATTERS: the background ACTIVE at a byte offset,
 * replaying every row from the top. A newline does not reset SGR and
 * `formatToolPreview` starts no row with a reset, so the only honest way to ask
 * "is this row's gutter tinted?" is to walk the bytes a terminal would walk.
 *
 * Asserting this is stronger than "the last background escape is a clear". The
 * old check passed even while every `╰` closer was painted with the previous
 * row's wash, because what leaked was a background SET with no later clear,
 * which a whole-string comparison of first-versus-last escape never sees at the
 * gutter position.
 */
function backgroundAt(rows: string[], rowIndex: number, offsetInRow: number): string {
  let background = "default"
  for (let index = 0; index <= rowIndex; index++) {
    const slice = index === rowIndex ? rows[index]!.slice(0, offsetInRow) : rows[index]!
    for (const match of slice.matchAll(SGR)) {
      const params = match[1]!
      // Full reset and background-only reset both return the default background.
      if (params === "" || params === "0" || params === "49") background = "default"
      else if (/^48;2;\d+;\d+;\d+$/.test(params)) background = params
      else if (/^4[0-7]$/.test(params) || /^10[0-7]$/.test(params)) background = params
    }
  }
  return background
}

function gutterIndex(row: string): number {
  const found = GUTTER_GLYPHS.map((glyph) => row.indexOf(glyph)).filter((index) => index >= 0)
  return found.length === 0 ? -1 : Math.min(...found)
}

/**
 * Core assertion: render the diff as the host renders it, then replay the rows
 * and require the default background at the gutter of EVERY frame row. The
 * gutter sits at the start of the row, so it is painted with whatever SGR state
 * the previous row left behind.
 */
function expectDefaultGutters(rendered: string): void {
  const rows = formatToolPreview(rendered, false, undefined, {
    tool: "Edit",
    cols: 60,
    ansiContent: true,
  })
  expect(rows.length).toBeGreaterThan(1)
  for (const [index, row] of rows.entries()) {
    const gutter = gutterIndex(row)
    expect(gutter).toBeGreaterThanOrEqual(0)
    expect(
      backgroundAt(rows, index, 0),
      [
        "SYMPTOM: this frame row is drawn on the previous row's diff wash instead of",
        "the default background, so the gutter spaces and glyph are tinted.",
        `Row ${index}: ${JSON.stringify(row)}`,
      ].join("\n"),
    ).toBe("default")
    expect(
      backgroundAt(rows, index, gutter),
      [
        "SYMPTOM: this frame row's gutter glyph is drawn on the previous row's diff wash",
        "instead of the default background, so the glyph is tinted.",
        `Row ${index}: ${JSON.stringify(row)}`,
      ].join("\n"),
    ).toBe("default")
  }
}

describe("washed diff rows and the frame gutter", () => {
  it("keeps every frame gutter on the default background when the diff ends in an addition", async () => {
    const rendered = await highlightUnifiedDiff(PATCH, "typescript", fakeHighlighter)
    expect(rendered).not.toBeNull()

    // Guard rail on the earlier fix: closing the row must not flatten the wash
    // INSIDE a changed row. Such a row re-opens its background after the marker
    // reset, so a washed row keeps a background escape after its last reset.
    const washedRows = rendered!.split("\n").filter((row) => {
      const rest = row.replace(LEADING_SGR, "")
      if (!rest.startsWith("-") || rest.startsWith("---")) return false
      return lastIndexOfBackground(row) > lastIndexOfReset(row)
    })
    expect(
      washedRows.length,
      "the changed rows lost their internal wash: no changed row keeps a background escape after its last reset",
    ).toBeGreaterThanOrEqual(1)

    // The bug: the trailing wash leaked into the next frame row's gutter.
    expectDefaultGutters(rendered!)
  })

  it("keeps every frame gutter on the default background when the diff ends in a context row", async () => {
    const rendered = await highlightUnifiedDiff(
      PATCH_ENDING_IN_CONTEXT,
      "typescript",
      fakeHighlighter,
    )
    expect(rendered).not.toBeNull()

    // The `+` row is the second-to-last body row. Before the fix, the closer
    // below it was painted with that row's addition wash.
    expectDefaultGutters(rendered!)
  })

  it.skipIf(MDSTREAM_MISSING)(NATIVE_TEST_TITLE, async () => {
    const highlighter = createMdstreamCodeHighlighter([MDSTREAM_BIN!])
    expect(highlighter).not.toBeNull()
    if (!highlighter) return
    try {
      expect(await highlighter.warmup()).toBe(true)
      const rendered = await highlightUnifiedDiff(PATCH, "typescript", highlighter)
      expect(
        rendered,
        [
          "SYMPTOM: the native mdstream bg-wash output was rejected or unavailable, so this",
          "test proved nothing about the native path. The guard accepts a row that resets",
          "anywhere on it, and the renderer closes the row-scoped wash at end of line.",
        ].join("\n"),
      ).not.toBeNull()
      // The native wash must really be present, or the assertion below is vacuous.
      expect(rendered).toContain("\x1b[48;2;")
      expectDefaultGutters(rendered!)
    } finally {
      await highlighter.close()
    }
  })

  it("keeps the wash running to the last glyph of a changed row before closing it", async () => {
    const rendered = await highlightUnifiedDiff(PATCH, "typescript", fakeHighlighter)
    expect(rendered).not.toBeNull()

    // Over-fix guard: the close must come AFTER the wash covers the payload, not
    // before it. Closing at the marker would shrink the wash to the `-`/`+` cell
    // and undo the wash-spans-the-row fix. So a changed row must still carry a
    // background escape after its last full reset, with the close behind it.
    const rows = formatToolPreview(rendered!, false, rendered!, {
      tool: "Edit",
      cols: 100,
      ansiContent: true,
    })
    const removalRow = rows.find((row) => row.replace(ANY_SGR, "").includes("-const a = 1"))
    expect(removalRow).toBeDefined()
    expect(
      lastIndexOfBackground(removalRow!) > lastIndexOfReset(removalRow!),
      [
        "SYMPTOM: the wash was closed before the payload, so a changed row no longer",
        "runs its background wash to the last glyph.",
        `Row: ${JSON.stringify(removalRow)}`,
      ].join("\n"),
    ).toBe(true)
  })
})

/**
 * A highlighter that leaves a background OPEN at the end of every token, which is
 * the shape the local compositor fallback receives from a sloppy highlighter.
 * The context and pass-through branches only PREFIX their row with a full RESET,
 * so that reset reaches the terminal after the caller has already painted the
 * row's own gutter. The gutter of the row BELOW therefore inherits the wash.
 */
const openBackgroundHighlighter: CodeHighlighter = {
  warmup: async () => true,
  async highlight({ code }: CodeHighlightRequest) {
    return code
      .split("\n")
      .map((line) => `\x1b[38;2;1;2;3m${line}\x1b[48;2;1;2;3m`)
      .join("\n")
  },
  close: async () => {},
}

/** The fallback shape: a context row in the MIDDLE, so a row follows it. */
const PATCH_CONTEXT_MIDDLE = [
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -1,3 +1,3 @@",
  "-const a = 1",
  "+const a = 2",
  " const b = 3",
  " const c = 4",
].join("\n")

/** A `+` row whose payload is empty: adding a blank line. */
const PATCH_EMPTY_ADDITION = [
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -1,1 +1,2 @@",
  " const a = 1",
  "+",
].join("\n")

describe("fallback rows that end on an open background", () => {
  it("closes a context row's payload before the next frame row's gutter", async () => {
    const rendered = await highlightUnifiedDiff(
      PATCH_CONTEXT_MIDDLE,
      "typescript",
      openBackgroundHighlighter,
    )
    expect(rendered).not.toBeNull()
    // Precondition: the payload really does end on an open wash, or the
    // assertion below proves nothing about the close.
    const contextRow = rendered!.split("\n").find((row) => row.includes("const b = 3"))
    expect(contextRow).toBeDefined()
    expect(lineEndsWithOpenBackground(contextRow!)).toBe(false)
    expectDefaultGutters(rendered!)
  })

  it("closes a pass-through row before the next frame row's gutter", async () => {
    // A bare prose row after a context row takes the pass-through branch.
    const patch = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,2 @@",
      " const b = 3",
      "trailing note that is not a diff row",
    ].join("\n")
    const rendered = await highlightUnifiedDiff(patch, "typescript", openBackgroundHighlighter)
    expect(rendered).not.toBeNull()
    expectDefaultGutters(rendered!)
  })

  it("closes an empty + payload row before the closer", async () => {
    const rendered = await highlightUnifiedDiff(
      PATCH_EMPTY_ADDITION,
      "typescript",
      openBackgroundHighlighter,
    )
    expect(rendered).not.toBeNull()
    expectDefaultGutters(rendered!)
  })

  it("leaves a row that already ends closed byte-identical", async () => {
    // The close is CONDITIONAL. A row whose payload is reset-terminated must not
    // gain an SGR 49, because those branches also carry rows the highlighter
    // never touched and an appended reset would rewrite bytes that are not ours.
    const rendered = await highlightUnifiedDiff(PATCH_CONTEXT_MIDDLE, "typescript", fakeHighlighter)
    expect(rendered).not.toBeNull()
    for (const row of rendered!.split("\n")) {
      if (!row.includes("const b = 3") && !row.includes("const c = 4")) continue
      expect(row).not.toContain("\x1b[49m")
      expect(row.endsWith("\x1b[0m")).toBe(true)
    }
  })
})

describe("Read rows that end on an open background", () => {
  it("closes a Read payload before the next frame row's gutter", async () => {
    const rendered = await highlightReadBody(
      "1\tconst a = 1\n2\tconst b = 2",
      "typescript",
      openBackgroundHighlighter,
    )
    expect(rendered).not.toBeNull()
    for (const row of rendered!.split("\n")) {
      expect(
        lineEndsWithOpenBackground(row),
        [
          "SYMPTOM: a Read row ends on an open wash. Raw highlight mode carries no",
          "bleeding-background guard, so the next frame row's gutter inherits it.",
          `Row: ${JSON.stringify(row)}`,
        ].join("\n"),
      ).toBe(false)
    }
    expectDefaultGutters(rendered!)
  })

  it("leaves Read rows that already end closed byte-identical", async () => {
    const rendered = await highlightReadBody(
      "1\tconst a = 1\n2\tconst b = 2",
      "typescript",
      fakeHighlighter,
    )
    expect(rendered).not.toBeNull()
    expect(rendered).not.toContain("\x1b[49m")
    expect(rendered!.split("\n").every((row) => row.endsWith("\x1b[0m"))).toBe(true)
  })
})
