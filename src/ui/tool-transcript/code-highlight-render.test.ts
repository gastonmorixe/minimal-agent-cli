import { describe, expect, it } from "bun:test"

import type {
  CodeHighlighter,
  CodeHighlightRequest,
} from "../formatter/mdstream-code-highlighter.ts"

import { highlightReadBody, highlightUnifiedDiff } from "./code-highlight-render.ts"

const highlighter: CodeHighlighter = {
  warmup: async () => true,
  async highlight({ code }: CodeHighlightRequest) {
    return code
      .split("\n")
      .map((line) => `\x1b[38;2;10;20;30m${line}\x1b[0m`)
      .join("\n")
  },
  close: async () => {},
}

describe("tool code highlight composition", () => {
  it("preserves Read line numbers outside syntax foregrounds", async () => {
    const out = await highlightReadBody("41\tconst x = 1\n42\treturn x", "typescript", highlighter)
    expect(out).toContain("\x1b[2m41\x1b[22m\t\x1b[38;2;10;20;30mconst x = 1")
    expect(out).toContain("\x1b[2m42\x1b[22m\t\x1b[38;2;10;20;30mreturn x")
  })

  it("preserves a final empty Read row for files ending in a newline", async () => {
    const out = await highlightReadBody("1\tconst x = 1\n2\t", "typescript", highlighter)
    expect(out).not.toBeNull()
    expect(out).toContain("\x1b[2m1\x1b[22m\t\x1b[38;2;10;20;30mconst x = 1")
    expect(out).toEndWith("\x1b[2m2\x1b[22m\t\x1b[38;2;10;20;30m\x1b[0m")
  })

  it("prefers native unified-diff mode and forwards palette colors", async () => {
    let request: unknown
    const native: CodeHighlighter = {
      warmup: async () => true,
      highlight: async () => null,
      async highlightUnifiedDiff(value) {
        request = value
        return "NATIVE-DIFF"
      },
      close: async () => {},
    }
    const previous = process.env.MINIMAL_AGENT_PALETTE
    process.env.MINIMAL_AGENT_PALETTE = JSON.stringify({
      addition: "\x1b[38;5;118m",
      removal: "\x1b[38;5;199m",
    })
    try {
      const out = await highlightUnifiedDiff("-old\n+new", "typescript", native, "Edit")
      expect(out).toContain("NATIVE-DIFF")
      expect(request).toEqual({
        language: "typescript",
        code: "-old\n+new",
        diffStyle: "bg-wash",
        colors: { inserted: "#87ff00", deleted: "#ff00af" },
      })
    } finally {
      if (previous === undefined) delete process.env.MINIMAL_AGENT_PALETTE
      else process.env.MINIMAL_AGENT_PALETTE = previous
    }
  })

  it("sends bright native marker colors and keeps syntax foregrounds over soft fallback washes", async () => {
    const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n const x = 1\n-old()\n+newCall()"
    const out = await highlightUnifiedDiff(patch, "typescript", highlighter)
    expect(out).toContain("\x1b[48;2;56;0;38m\x1b[38;5;199m-")
    expect(out).toContain("\x1b[48;2;29;56;0m\x1b[38;5;118m+")
    expect(out).toContain("\x1b[38;2;10;20;30mold()")
    expect(out).toContain("\x1b[38;2;10;20;30mnewCall()")
    expect(out).toContain(" \x1b[38;2;10;20;30mconst x = 1")
  })

  it("fails closed when row counts do not match", async () => {
    const broken: CodeHighlighter = {
      warmup: async () => true,
      highlight: async () => "one-line",
      close: async () => {},
    }
    expect(await highlightReadBody("1\ta\n2\tb", "text", broken)).toBeNull()
  })
})

/**
 * A highlighter that records the language of every request it receives.
 * Syntect's `php` grammar starts in HTML mode, so a mid-file slice needs the
 * inner `php-source` grammar; these tests pin the choice, not the colors.
 */
function recordingHighlighter(): { highlighter: CodeHighlighter; languages: string[] } {
  const languages: string[] = []
  return {
    languages,
    highlighter: {
      warmup: async () => true,
      async highlight({ language, code }) {
        languages.push(language)
        return code
          .split("\n")
          .map((line) => `\x1b[38;2;10;20;30m${line}\x1b[0m`)
          .join("\n")
      },
      close: async () => {},
    },
  }
}

describe("embedded-language refinement for PHP slices", () => {
  it("sends the PHP-source grammar for a mid-file slice with no open tag", async () => {
    const rec = recordingHighlighter()
    await highlightReadBody(
      "41\t    public function foo($x) {\n42\t        return $x;\n43\t    }",
      "php",
      rec.highlighter,
    )
    expect(rec.languages).toEqual(["PHP Source"])
  })

  it("keeps the HTML-embedding grammar when the slice opens with a tag", async () => {
    const rec = recordingHighlighter()
    await highlightReadBody("1\t<?php\n2\techo 1;", "php", rec.highlighter)
    expect(rec.languages).toEqual(["php"])
  })

  it("sends PHP-source when a close tag precedes any open tag", async () => {
    const rec = recordingHighlighter()
    await highlightReadBody("9\t?>text<?php echo 1;", "php", rec.highlighter)
    expect(rec.languages).toEqual(["PHP Source"])
  })

  it("never changes the code it forwards, whatever the refinement picks", async () => {
    // The row-count guard blocked a prelude-based fix; asserting the payload is
    // byte-identical rules out any prelude, not just ones that shift rows.
    let seen = ""
    const rec: CodeHighlighter = {
      warmup: async () => true,
      async highlight({ code }) {
        seen = code
        return code
          .split("\n")
          .map((line) => `\x1b[38;2;10;20;30m${line}\x1b[0m`)
          .join("\n")
      },
      close: async () => {},
    }
    await highlightReadBody("7\tclass Foo {\n8\t    public int $x = 1;\n9\t}", "php", rec)
    expect(seen).toBe("class Foo {\n    public int $x = 1;\n}")
  })

  it("leaves every other language untouched", async () => {
    const rec = recordingHighlighter()
    await highlightReadBody("1\tconst x = 1", "typescript", rec.highlighter)
    expect(rec.languages).toEqual(["typescript"])
  })
})

describe("embedded-language refinement for diffs", () => {
  function nativeRecorder(): { highlighter: CodeHighlighter; languages: string[] } {
    const languages: string[] = []
    return {
      languages,
      highlighter: {
        warmup: async () => true,
        highlight: async () => null,
        async highlightUnifiedDiff({ language, code }) {
          languages.push(language)
          return code
        },
        close: async () => {},
      },
    }
  }

  it("ignores an open tag that lives only on a context line", async () => {
    // mdstream lexes only the +/- bodies, so a `<?php` on a context row cannot
    // put the added stream into PHP mode. The decision must come from the
    // changed lines alone.
    const rec = nativeRecorder()
    const patch = [
      "--- a/x.php",
      "+++ b/x.php",
      "@@ -1,2 +1,3 @@",
      " <?php",
      '+$x = "s" . 1;',
      " echo $x;",
    ].join("\n")
    await highlightUnifiedDiff(patch, "php", rec.highlighter)
    expect(rec.languages).toEqual(["PHP Source"])
  })

  it("keeps the HTML grammar when a changed line opens with a tag", async () => {
    const rec = nativeRecorder()
    const patch = ["--- a/x.php", "+++ b/x.php", "@@ -1 +1 @@", '-<?php echo 1;', "+<?php echo 2;"].join(
      "\n",
    )
    await highlightUnifiedDiff(patch, "php", rec.highlighter)
    expect(rec.languages).toEqual(["php"])
  })

  it("refines each fallback stream independently", async () => {
    // No native mode: the local compositor lexes old and new payloads
    // separately, so each side may choose differently for the same patch.
    const rec = recordingHighlighter()
    const patch = ["--- a/x.php", "+++ b/x.php", "@@ -1 +1 @@", "-<?php echo 1;", "+class Foo {}"].join(
      "\n",
    )
    const out = await highlightUnifiedDiff(patch, "php", rec.highlighter)
    expect(out).not.toBeNull()
    expect(rec.languages).toEqual(["php", "PHP Source"])
  })
})

describe("PHP open-tag detection", () => {
  it("ignores an XML declaration inside a PHP string", async () => {
    // Legacy PHP builds XML by hand. A bare `<?` here is not an open tag, and
    // treating it as one makes the grammar leave PHP mode for the rest of the
    // slice, mis-styling everything after it.
    const rec = recordingHighlighter()
    await highlightReadBody(
      '1\t    $doc = "<?xml version=\\"1.0\\"?>";\n2\t    return $doc;',
      "php",
      rec.highlighter,
    )
    expect(rec.languages).toEqual(["PHP Source"])
  })

  it("accepts the short echo and short open tag forms", async () => {
    for (const source of ["1\t<?= $x ?>", "1\t<? echo 1;", "1\t<?php echo 1;"]) {
      const rec = recordingHighlighter()
      await highlightReadBody(source, "php", rec.highlighter)
      expect(rec.languages).toEqual(["php"])
    }
  })
})
