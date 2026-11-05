/**
 * `DiffViewerShowDiff` gets the same host highlight treatment as Edit.
 *
 * The diff-view plugin sends `content: patch` (the raw unified diff) and
 * `display: renderUnifiedDiff(patch, title)` (`handlers/show_diff.ts`), and that
 * display colors by FIRST CHARACTER only: `+`/`-`/`@@`/`+++`, no token colors,
 * no wash. The tool carries no `file_path` and its outcome carries no `diff`,
 * so before this fix the host highlight block never ran and the call rendered
 * flat: one color per line.
 *
 * The path lives on the patch's `+++ b/<path>` line, so the host now resolves a
 * language from it and renders with `highlightUnifiedDiff`, keeping the plugin
 * display as the fallback. These tests prove that against the REAL mdstream
 * binary, and prove the fallback still renders flat without throwing.
 */

import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { ToolFeedbackTracker } from "@minimal-agent/core/host-kit/feedback-tracker"
import { ToolExecutorAdapter } from "@minimal-agent/core/host-kit/tool-executor-adapter"
import { renderUnifiedDiff } from "../../terminal-kit/unified-diff.ts"
import {
  type CodeHighlighter,
  createMdstreamCodeHighlighter,
} from "../formatter/mdstream-code-highlighter.ts"

import { createReplToolView } from "./tool-view.ts"

/**
 * mdstream is optional. Resolve it from the environment first so CI or another
 * machine can point at its own build, then fall back to the standard local
 * install. The native tests skip (with a stated reason) when neither exists.
 */
function resolveMdstreamBin(): string | null {
  const configured = process.env.MINIMAL_AGENT_MDSTREAM_BIN
  const candidates =
    configured === undefined
      ? [join(process.env.HOME ?? "", ".minimal-agent", "bin", "mdstream")]
      : [configured]
  for (const candidate of candidates) {
    if (candidate.length > 0 && existsSync(candidate)) return candidate
  }
  return null
}

const MDSTREAM_BIN = resolveMdstreamBin()
const MDSTREAM_MISSING = MDSTREAM_BIN === null
/** The stated reason a skipped native test carries, so the skip is never silent. */
const SKIP_REASON = [
  `SKIPPED: no mdstream binary. Set MINIMAL_AGENT_MDSTREAM_BIN or install ${join(
    process.env.HOME ?? "~",
    ".minimal-agent/bin/mdstream",
  )}. The native token colors and wash cannot be exercised without the real highlighter.`,
].join(" :: ")

/** The intent when the binary is present, plus the skip reason when it is not. */
function nativeTitle(intent: string): string {
  return MDSTREAM_MISSING ? `${intent} :: ${SKIP_REASON}` : intent
}

/** The patch the real user reported on: a `.ts` file, one removal, one addition. */
const PATCH = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +1,2 @@", "-const a = 1", "+const a = 2"].join(
  "\n",
)

const ANY_SGR = /\x1b\[[0-9;:]*m/g
/** Truecolor foreground escapes with their r;g;b body captured. */
const TRUE_COLOR_FOREGROUND = /\x1b\[38;2;(\d+;\d+;\d+)m/g
/** Any SGR escape with its parameter body captured. */
const SGR = /\x1b\[([0-9;:]*)m/g
const GUTTER_GLYPHS = ["\u2502", "\u2570"]

/**
 * The plugin's tool names: `DiffViewerShowDiff` is the model-facing name,
 * `ShowDiff` the manifest canonical and `show_diff` its alias. The view must
 * accept all three, so the stub loader claims all three.
 */
const SHOW_DIFF_NAMES = new Set(["DiffViewerShowDiff", "ShowDiff", "show_diff"])

/**
 * A loader stub that behaves like ma-diff-view-plugin's `show_diff` handler:
 * `content` is the raw patch it was given and `display` is the flat
 * `renderUnifiedDiff` render. Reading the handler confirms this contract
 * (`content: input.patch`, `display: rendered`).
 */
function showDiffLoader(patch: string, title?: string) {
  return {
    hasTool: (name: string) => SHOW_DIFF_NAMES.has(name),
    dispatch: async () => ({
      kind: "tool_result" as const,
      content: patch,
      display: renderUnifiedDiff(patch, title),
    }),
  }
}

function adapter(
  transcript: string[],
  codeHighlighter: CodeHighlighter | null,
  loader: unknown,
): ToolExecutorAdapter {
  return new ToolExecutorAdapter({
    toolView: createReplToolView({
      writeTranscript: (line) => transcript.push(line),
      presentation: new Map(),
      codeHighlighter,
    }),
    loader: loader as never,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    model: "test-model",
  })
}

/** Render one ShowDiff call and return the transcript rows plus the result. */
async function renderShowDiff(options: {
  codeHighlighter: CodeHighlighter | null
  patch?: string
  title?: string
  name?: string
}): Promise<{ rows: string[]; rendered: string; content: string }> {
  const patch = options.patch ?? PATCH
  const rows: string[] = []
  const executor = adapter(rows, options.codeHighlighter, showDiffLoader(patch, options.title))
  const result = await executor.execute({
    type: "tool_use",
    id: "showdiff-1",
    name: options.name ?? "DiffViewerShowDiff",
    input: { patch, ...(options.title === undefined ? {} : { title: options.title }) },
  })
  return { rows, rendered: rows.join("\n"), content: String(result.content) }
}

/**
 * Body rows only: the header row carries `╭`, not a gutter glyph, and the row
 * replay below needs a real gutter column to inspect.
 */
function bodyRows(rows: string[]): string[] {
  return rows.filter((row) => GUTTER_GLYPHS.some((glyph) => row.includes(glyph)))
}

function visible(row: string): string {
  return row.replace(ANY_SGR, "")
}

/** Distinct truecolor foreground triples on one rendered row. */
function distinctForegrounds(row: string): Set<string> {
  const found = new Set<string>()
  for (const match of row.matchAll(TRUE_COLOR_FOREGROUND)) found.add(match[1]!)
  return found
}

/**
 * The background ACTIVE at a byte offset, replaying every row from the top. A
 * newline does not reset SGR and the host never starts a row with a reset, so
 * this is the only honest way to ask "is this row's gutter tinted?".
 */
function backgroundAt(rows: string[], rowIndex: number, offsetInRow: number): string {
  let background = "default"
  for (let index = 0; index <= rowIndex; index++) {
    const slice = index === rowIndex ? rows[index]!.slice(0, offsetInRow) : rows[index]!
    for (const match of slice.matchAll(SGR)) {
      const params = match[1]!
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

describe("DiffViewerShowDiff highlight in the CLI tool view", () => {
  it.skipIf(MDSTREAM_MISSING)(
    nativeTitle("colors a ShowDiff patch with real token colors"),
    async () => {
      const highlighter = createMdstreamCodeHighlighter([MDSTREAM_BIN!])
      expect(highlighter).not.toBeNull()
      if (!highlighter) return
      try {
        expect(await highlighter.warmup()).toBe(true)
        const { rows, content } = await renderShowDiff({ codeHighlighter: highlighter })

        // The host guard skips the highlighter when the model-facing content
        // carries ANSI. The real handler returns the raw patch, so it must not.
        expect(content).toBe(PATCH)
        expect(content).not.toContain("\x1b")

        const changedRows = bodyRows(rows).filter((row) => {
          const text = visible(row)
          return text.includes("-const a = 1") || text.includes("+const a = 2")
        })
        expect(changedRows.length).toBe(2)

        // One flat color per line yields exactly one triple. Token colors yield
        // several (keyword, identifier, operator, number).
        for (const row of changedRows) {
          expect(
            distinctForegrounds(row).size,
            [
              "SYMPTOM: this ShowDiff row renders in one flat color instead of real token",
              "colors, so the host highlight branch did not run for this call.",
              `Row: ${JSON.stringify(row)}`,
            ].join("\n"),
          ).toBeGreaterThanOrEqual(3)
        }
      } finally {
        await highlighter.close()
      }
    },
  )

  it.skipIf(MDSTREAM_MISSING)(
    nativeTitle("paints the ShowDiff addition row with the soft wash"),
    async () => {
      const highlighter = createMdstreamCodeHighlighter([MDSTREAM_BIN!])
      expect(highlighter).not.toBeNull()
      if (!highlighter) return
      try {
        expect(await highlighter.warmup()).toBe(true)
        const { rendered } = await renderShowDiff({ codeHighlighter: highlighter })

        expect(rendered, "the addition row lost its soft green wash").toContain("48;2;29;56;0")
        expect(rendered, "the removal row lost its soft pink wash").toContain("48;2;56;0;38")
        // Full-opacity accents are the blinding wash the host darkens away.
        expect(rendered, "the raw lime accent reached the row background").not.toContain(
          "48;2;135;255;0",
        )
        expect(rendered, "the raw pink accent reached the row background").not.toContain(
          "48;2;255;0;175",
        )
      } finally {
        await highlighter.close()
      }
    },
  )

  it.skipIf(MDSTREAM_MISSING)(
    nativeTitle("keeps the ShowDiff gutter on the default background"),
    async () => {
      const highlighter = createMdstreamCodeHighlighter([MDSTREAM_BIN!])
      expect(highlighter).not.toBeNull()
      if (!highlighter) return
      try {
        expect(await highlighter.warmup()).toBe(true)
        const { rows } = await renderShowDiff({ codeHighlighter: highlighter })
        const body = bodyRows(rows)
        expect(body.length).toBeGreaterThan(1)
        for (const [index, row] of body.entries()) {
          const gutter = gutterIndex(row)
          expect(gutter).toBeGreaterThanOrEqual(0)
          expect(
            backgroundAt(body, index, 0),
            [
              "SYMPTOM: this frame row is drawn on the previous ShowDiff row's wash",
              "instead of the default background, so the gutter spaces are tinted.",
              `Row ${index}: ${JSON.stringify(row)}`,
            ].join("\n"),
          ).toBe("default")
          expect(
            backgroundAt(body, index, gutter),
            [
              "SYMPTOM: this frame row's gutter glyph is drawn on the previous ShowDiff",
              "row's wash instead of the default background, so the glyph is tinted.",
              `Row ${index}: ${JSON.stringify(row)}`,
            ].join("\n"),
          ).toBe("default")
        }
      } finally {
        await highlighter.close()
      }
    },
  )

  it("renders the plugin's flat diff when no highlighter is available", async () => {
    const { rows, rendered, content } = await renderShowDiff({ codeHighlighter: null })

    expect(content).toBe(PATCH)
    expect(rendered, "the plugin's flat removal render is the fallback").toContain(
      "\x1b[38;5;199m-const a = 1",
    )
    expect(rendered, "the plugin's flat addition render is the fallback").toContain(
      "\x1b[38;5;118m+const a = 2",
    )
    // No token colors and no wash: the fallback did not invent a render.
    expect(rendered).not.toContain("48;2;29;56;0")
    expect(rendered).not.toContain("48;2;56;0;38")
    expect(rows.length).toBeGreaterThan(1)
  })

  it("keeps the plugin's flat diff when the highlighter returns null", async () => {
    const nullHighlighter: CodeHighlighter = {
      warmup: async () => true,
      highlight: async () => null,
      highlightUnifiedDiff: async () => null,
      close: async () => {},
    }
    const { rendered } = await renderShowDiff({ codeHighlighter: nullHighlighter })

    expect(rendered).toContain("\x1b[38;5;199m-const a = 1")
    expect(rendered).toContain("\x1b[38;5;118m+const a = 2")
    expect(rendered).not.toContain("48;2;29;56;0")
    expect(rendered).not.toContain("48;2;56;0;38")
  })

  it("accepts the legacy ShowDiff and show_diff names and still highlights", async () => {
    const tokenHighlighter: CodeHighlighter = {
      warmup: async () => true,
      async highlight({ code }) {
        return code
          .split("\n")
          .map((line) => `\x1b[38;2;10;20;30m${line}\x1b[0m`)
          .join("\n")
      },
      close: async () => {},
    }

    for (const name of ["ShowDiff", "show_diff"]) {
      const { rendered } = await renderShowDiff({
        codeHighlighter: tokenHighlighter,
        name,
      })
      expect(rendered, `${name} did not reach the highlight branch`).toContain(
        "\x1b[38;2;10;20;30mconst",
      )
    }
  })

  it("falls through to the flat display when the patch carries no resolvable path", async () => {
    const tokenHighlighter: CodeHighlighter = {
      warmup: async () => true,
      async highlight({ code }) {
        return `\x1b[38;2;10;20;30m${code}\x1b[0m`
      },
      close: async () => {},
    }
    // No `+++`/`---` header: no language resolves, so the flat render stays.
    const patch = ["@@ -1,2 +1,2 @@", "-const a = 1", "+const a = 2"].join("\n")
    const { rendered } = await renderShowDiff({ codeHighlighter: tokenHighlighter, patch })

    expect(rendered).toContain("\x1b[38;5;199m-const a = 1")
    expect(rendered).toContain("\x1b[38;5;118m+const a = 2")
    expect(rendered).not.toContain("\x1b[38;2;10;20;30m")
  })
})
