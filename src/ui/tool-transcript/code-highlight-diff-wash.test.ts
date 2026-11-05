import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Subprocess } from "bun"

import {
  type CodeHighlighter,
  type CodeHighlightRequest,
  createMdstreamCodeHighlighter,
  lineEndsWithOpenBackground,
  MdstreamCodeHighlighter,
  type MdstreamHighlightSpawn,
} from "../formatter/mdstream-code-highlighter.ts"

import { highlightUnifiedDiff } from "./code-highlight-render.ts"

/**
 * The real sidecar is optional. Resolve it from `MINIMAL_AGENT_MDSTREAM_BIN`
 * first so CI or another machine can point at its own build, then fall back to
 * the standard local install. The native test skips with a stated reason when
 * neither exists, so a box without mdstream stays green.
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
const NATIVE_TEST_TITLE = MDSTREAM_MISSING
  ? [
      "keeps the real mdstream token highlight for a washed diff line",
      `SKIPPED: no mdstream binary. Set MINIMAL_AGENT_MDSTREAM_BIN or install ${join(
        process.env.HOME ?? "~",
        ".minimal-agent/bin/mdstream",
      )}.`,
    ].join(" :: ")
  : "keeps the real mdstream token highlight for a washed diff line"

const PATCH = [
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -1,2 +1,2 @@",
  " const a: number = 1",
  "-const a: number = 1",
  "+const a: number = 2",
].join("\n")

const BG = /\x1b\[48;2;\d+;\d+;\d+m/g
const RESET = "\x1b[0m"
/** Any SGR escape. */
const ANY_SGR = /\x1b\[[0-9;]*m/g
/** One or more leading SGR escapes, stripped to reach the visible text. */
const LEADING_SGR = /^(?:\x1b\[[0-9;]*m)+/

/**
 * WASH-SPANS-ROW RULE (the one precise rule this file asserts):
 *
 * A changed line must still have its background wash ACTIVE at the end of the
 * line, so that any padding the renderer appends after the text still inherits
 * the wash. In practice: inside the changed line, the last background escape
 * must come AFTER the last full reset.
 *
 * mdstream's native bg-wash output satisfies this: it sets one background after
 * the marker reset and then only switches foregrounds until the end of the row.
 * The local compositor fallback does not: it closes the payload with a final
 * reset, which kills the background before the row padding.
 */
function lastIndexOfReset(line: string): number {
  return line.lastIndexOf(RESET)
}

function lastIndexOfBackground(line: string): number {
  let last = -1
  for (const match of line.matchAll(BG)) last = match.index ?? -1
  return last
}

/** Changed body line = leading SGR escapes, then `-` or `+`, then a payload. */
function changedLines(rendered: string): string[] {
  return rendered.split("\n").filter((line) => {
    const rest = line.replace(LEADING_SGR, "")
    if (!rest.startsWith("-") && !rest.startsWith("+")) return false
    // Diff file headers are `--- a/x` / `+++ b/x`, not changed rows.
    if (rest.startsWith("---") || rest.startsWith("+++")) return false
    return true
  })
}

/** Deterministic stand-in highlighter: one foreground-reset pair per token. */
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
  // No native unified-diff mode: force the local compositor fallback path.
  close: async () => {},
}

/** An inline highlight-server stub that answers every request with FAKE_ANSI. */
const FAKE_SERVER = `
const ansi = process.env.FAKE_ANSI ?? ""
process.stdout.write(JSON.stringify({ ready: 1, protocol: 2, modes: ["raw", "unified-diff"] }) + "\\n")
const decoder = new TextDecoder()
let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true })
  while (true) {
    const newline = buffer.indexOf("\\n")
    if (newline === -1) break
    const request = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    process.stdout.write(JSON.stringify({ id: request.id, ansi }) + "\\n")
  }
}
`

function fakeSpawn(ansi: string): MdstreamHighlightSpawn {
  return () =>
    Bun.spawn([process.execPath, "-e", FAKE_SERVER], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FAKE_ANSI: ansi },
    }) as Subprocess<"pipe", "pipe", "pipe">
}

/** Run one native diff request against a stub that returns `ansi`. */
async function requestWith(ansi: string): Promise<string | null> {
  const highlighter = new MdstreamCodeHighlighter(["mdstream"], {
    spawn: fakeSpawn(ansi),
    timeoutMs: 1_000,
  })
  try {
    return await highlighter.highlightUnifiedDiff({ language: "rust", code: "-old\n+new" })
  } finally {
    await highlighter.close()
  }
}

describe("native diff background guard", () => {
  /**
   * The leaking shape, exactly as mdstream v0.3.6 emits it: the row resets after
   * the marker, then opens the row wash and ends on a foreground colour with the
   * background still set. This is ACCEPTED on purpose: the renderer closes the
   * row-scoped wash with SGR 49 at end of line. Treating it as unsafe is what
   * discarded the native output and produced the gutter tint in the first place.
   */
  it("accepts a row-scoped wash that carries its own reset", async () => {
    const ansi = "\x1b[38;2;135;255;0m+\x1b[0m\x1b[48;2;135;255;0m\x1b[38;2;123;167;255mconst"
    expect(await requestWith(ansi)).toBe(ansi)
  })

  it("rejects a background opened with nothing on the line to bound it", async () => {
    expect(await requestWith("\x1b[48;2;1;2;3mconst x")).toBeNull()
  })

  /** Colon-form SGR washes a terminal, so a parser that skips them sees nothing. */
  it("rejects a colon-form background that never closes", async () => {
    expect(await requestWith("\x1b[48:2::255:95:215mconst x")).toBeNull()
  })

  /**
   * ISOLATES the colon-aware parsing change. The case above does NOT: the old
   * guard rule was `content.endsWith("\x1b[0m")`, which rejects
   * `ESC[48:2::255:95:215mconst x` too, so it passed before the parser changed
   * and proves nothing about colon tokenizing.
   *
   * This shape fails on a colon-blind tokenizer and is caught on the colon-aware
   * one. `ESC[48:5:17m` split on `;` alone yields `["48:5:17"]`, which is not the
   * parameter 48, so the wash is invisible and the row looks clean. Split on both
   * separators it yields `[48, 5, 17]`, a real indexed background that never
   * closes, so the guard rejects it.
   *
   * NOTE ON THE OBVIOUS VARIANT: `ESC[0m` + `ESC[48:2::255:95:215m` + `x` is NOT
   * a valid isolating case. It is ACCEPTED by the shipped guard on purpose: the
   * leading full reset sets `sawReset`, and a row that carries its own reset is
   * accepted because the renderer closes the row-scoped wash at end of line.
   * Asserting rejection there would contradict the accept contract.
   */
  it("rejects a colon-form indexed background that never closes", async () => {
    expect(await requestWith("\x1b[48:5:17mconst x")).toBeNull()
  })

  /** Positive control: the same colon form closed properly must still pass. */
  it("accepts a colon-form indexed background that closes", async () => {
    const ansi = "\x1b[48:5:17mconst x\x1b[49m"
    expect(await requestWith(ansi)).toBe(ansi)
  })

  it("accepts a colon-form background that closes", async () => {
    const ansi = "\x1b[48:2::255:95:215mconst x\x1b[49m"
    expect(await requestWith(ansi)).toBe(ansi)
  })
})

describe("lineEndsWithOpenBackground", () => {
  it("reports an open truecolor wash at end of line", () => {
    expect(lineEndsWithOpenBackground("\x1b[48;2;135;255;0mabc")).toBe(true)
  })

  it("reports a closed wash as closed", () => {
    expect(lineEndsWithOpenBackground("\x1b[48;2;135;255;0mabc\x1b[49m")).toBe(false)
    expect(lineEndsWithOpenBackground("\x1b[48;2;135;255;0mabc\x1b[0m")).toBe(false)
  })

  /** A bare 48 has no mode. Terminals ignore it, so it opens no background. */
  it("does not treat a bare 48 as an open background", () => {
    expect(lineEndsWithOpenBackground("\x1b[48mabc")).toBe(false)
  })

  it("reports plain rows as closed", () => {
    expect(lineEndsWithOpenBackground("--- a/x.ts")).toBe(false)
    expect(lineEndsWithOpenBackground("")).toBe(false)
  })
})

describe("washed unified diff rows", () => {
  it.skipIf(MDSTREAM_MISSING)(NATIVE_TEST_TITLE, async () => {
    const highlighter = createMdstreamCodeHighlighter([MDSTREAM_BIN!])
    expect(highlighter).not.toBeNull()
    if (!highlighter) return
    const highlightDiff = highlighter.highlightUnifiedDiff?.bind(highlighter)
    expect(typeof highlightDiff, "highlighter must expose unified-diff mode").toBe("function")
    if (!highlightDiff) return

    const native = await highlightDiff({
      language: "typescript",
      code: PATCH,
      diffStyle: "bg-wash",
      colors: { deleted: "#ff5fd7", inserted: "#87ff00" },
    })
    await highlighter.close()

    expect(
      native,
      [
        "SYMPTOM: mdstream DID produce a washed unified-diff highlight, but the CLI threw it away.",
        "createMdstreamCodeHighlighter().highlightUnifiedDiff() returned null.",
        "Cause: the guard `hasNoBleedingBackground` (mdstream-code-highlighter.ts, called from",
        "`highlightSerialized`) rejected every line. Real mdstream v0.3.6 bg-wash rows reset after",
        "the marker and then leave the row background set, e.g.",
        "...\\x1b[0m\x1b[48;2;135;255;0m...\\x1b[38;2;232;238;250m . The guard accepts that shape",
        "because the renderer closes the row-scoped wash at end of line.",
      ].join("\n"),
    ).not.toBeNull()
  })

  it("keeps the background wash alive at the end of a changed diff line", async () => {
    const rendered = await highlightUnifiedDiff(PATCH, "typescript", tokenHighlighter)
    expect(rendered).not.toBeNull()

    const rows = changedLines(rendered!)
    expect(
      rows.length,
      "expected the rendered diff to contain one removed and one added changed line",
    ).toBe(2)

    for (const row of rows) {
      const marker = row.replace(LEADING_SGR, "").slice(0, 1)
      const lastReset = lastIndexOfReset(row)
      const lastBackground = lastIndexOfBackground(row)
      const visible = row.replace(ANY_SGR, "").trimEnd()

      expect(
        lastBackground > lastReset,
        [
          `SYMPTOM: the "${marker}" diff row loses its background wash before the end of the line,`,
          "so the wash stops at the last text character instead of spanning the whole row.",
          `Row: ${JSON.stringify(row)}`,
          `Visible text: ${JSON.stringify(visible)}`,
          `last background escape at index ${lastBackground}, last ESC[0m at index ${lastReset}.`,
          "Rule: the last background escape must come after the last full reset.",
          "The local compositor closes the marker with ESC[0m, re-opens the wash, appends the",
          "payload, then emits a final ESC[0m. That final reset kills the wash before the row",
          "padding, so the row is not fully washed.",
        ].join("\n"),
      ).toBe(true)
    }
  })
})

/**
 * NATIVE WASH OPACITY.
 *
 * mdstream's bg-wash mode reuses the raw accent colour as the ROW BACKGROUND, so
 * the default palette sends `#87ff00` / `#ff00af` and the native output paints
 * `48;2;135;255;0` / `48;2;255;0;175` behind every glyph of a changed row. The
 * user's report was literal: "now I see a green background so green that it
 * blinds me." The local compositor fallback never did this: it darkens the same
 * accents by 0.22 (`darkenHex`) into a dark tint. The renderer now rewrites the
 * native wash with that SAME tint, so the two paths converge.
 *
 * The marker foregrounds are the unchanged half of the contract: `+`/`-` and the
 * syntax tokens must stay bright, or the diff becomes unreadable the other way.
 */
describe("native diff wash opacity", () => {
  /** Render PATCH through the REAL binary at the default palette accents. */
  async function renderNative(): Promise<string> {
    const highlighter = createMdstreamCodeHighlighter([MDSTREAM_BIN!])
    expect(highlighter).not.toBeNull()
    if (!highlighter) return ""
    try {
      const rendered = await highlightUnifiedDiff(PATCH, "typescript", highlighter)
      expect(rendered, "the real mdstream must produce a native washed diff").not.toBeNull()
      return rendered!
    } finally {
      await highlighter.close()
    }
  }

  const NATIVE_SKIP = MDSTREAM_MISSING
    ? ` :: SKIPPED: no mdstream binary. Set MINIMAL_AGENT_MDSTREAM_BIN or install ${join(
        process.env.HOME ?? "~",
        ".minimal-agent/bin/mdstream",
      )}.`
    : ""

  it.skipIf(MDSTREAM_MISSING)(
    `does not paint the full-opacity accent behind a native diff row${NATIVE_SKIP}`,
    async () => {
      const rendered = await renderNative()
      // Both bright accents as BACKGROUNDS: the blinding wash this bug fixed.
      expect(
        rendered,
        [
          "SYMPTOM: a native diff row is washed with the FULL-OPACITY accent, so a lime",
          "addition row is a solid #87ff00 block that blinds the reader.",
          "Root cause: mdstream's bg-wash mode reuses the raw accent colour as the row",
          "background, and the renderer passed it through unmodified.",
          "Fix: darkenNativeWash() rewrites only the wash background to the fallback tint.",
        ].join("\n"),
      ).not.toContain("48;2;135;255;0")
      expect(rendered, "the pink wash must be darkened too").not.toContain("48;2;255;0;175")
    },
  )

  it.skipIf(MDSTREAM_MISSING)(
    `keeps the bright accent on the native +/- marker${NATIVE_SKIP}`,
    async () => {
      const rendered = await renderNative()
      // FOREGROUNDS: the marker glyphs. These must NOT be darkened with the wash.
      expect(
        rendered,
        "the added-row `+` marker must keep the bright lime FOREGROUND (38;2), not a wash",
      ).toContain("38;2;135;255;0")
      expect(
        rendered,
        "the removed-row `-` marker must keep the bright pink FOREGROUND (38;2), not a wash",
      ).toContain("38;2;255;0;175")
    },
  )

  it.skipIf(MDSTREAM_MISSING)(
    `paints the native diff row wash with the fallback tint${NATIVE_SKIP}`,
    async () => {
      const rendered = await renderNative()
      // Math.floor(channel * 0.22) per channel, the exact darkenHex math:
      //   #87ff00 -> 29;56;0   (lime addition)
      //   #ff00af -> 56;0;38   (pink removal, the DEFAULT palette accent)
      expect(rendered, "the addition wash must be the fallback lime tint #1d3800").toContain(
        "48;2;29;56;0",
      )
      expect(rendered, "the removal wash must be the fallback pink tint").toContain("48;2;56;0;38")
    },
  )

  /**
   * The task names `48;2;56;20;47` for the pink wash, which is `#ff5fd7` at 0.22.
   * That is NOT the default palette accent (`#ff00af` darkens to `56;0;38`), it is
   * the truecolor pink a themed palette injects. Both go through the same
   * `darkenHex` math, so pin the themed case explicitly instead of leaving the
   * stated triple unverified.
   */
  it.skipIf(MDSTREAM_MISSING)(
    `darkens a themed truecolor pink wash with the same 0.22 math${NATIVE_SKIP}`,
    async () => {
      const previous = process.env.MINIMAL_AGENT_PALETTE
      process.env.MINIMAL_AGENT_PALETTE = JSON.stringify({ removal: "\x1b[38;2;255;95;215m" })
      try {
        const rendered = await renderNative()
        expect(rendered, "#ff5fd7 at 0.22 must be #38142f").toContain("48;2;56;20;47")
        expect(rendered, "the themed pink wash must not stay at full opacity").not.toContain(
          "48;2;255;95;215",
        )
        expect(rendered, "the themed pink marker keeps its bright foreground").toContain(
          "38;2;255;95;215",
        )
      } finally {
        if (previous === undefined) delete process.env.MINIMAL_AGENT_PALETTE
        else process.env.MINIMAL_AGENT_PALETTE = previous
      }
    },
  )
})
