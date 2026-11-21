/**
 * Verbose dump: one reference line for each annotation at the end of a
 * `tool_result` (for example the output preview, the raw output footer and
 * the active-mode stamp).
 *
 * The tag bytes come from the real codec (`testSideband.render`), so this
 * file holds no wire form. The labels come from `testSideband.name`.
 *
 * @module ui/status/debug-dump-annotations.test
 */
import { describe, expect, it } from "bun:test"
import type { SidebandAttrValue } from "@minimal-agent/core/host/sideband"
import { dumpView } from "../../logging/request-dump-model.ts"
import { stripSizeLabels } from "../../logging/request-dump-size.fixtures.ts"
import { sidebandFixturePresent, testSideband } from "../../test-utils/sideband-fixture.ts"
import { snapOf } from "./debug-dump.fixtures.ts"
import { renderDumpBlock } from "./debug-dump.ts"

const strip = (s: string): string => stripSizeLabels(s.replace(/\x1b\[[0-9;]*m/g, ""))

const sb = testSideband

/** One annotation to append: kind, attrs and an optional body. */
interface Ann {
  readonly kind: string
  readonly attrs?: Record<string, SidebandAttrValue>
  readonly body?: string
}

/**
 * The model text of one tool result, and its persisted outcome record.
 * Each annotation joins with a blank line, as core does.
 */
function result(body: string, anns: readonly Ann[]) {
  let text = body
  const spans: Array<{ kind: string; attrs?: Ann["attrs"]; start: number; end: number }> = []
  for (const a of anns) {
    text += "\n\n"
    const tag = sb.render(a.kind, {
      ...(a.attrs ? { attrs: a.attrs } : {}),
      ...(a.body ? { body: a.body } : {}),
    })
    spans.push({
      kind: a.kind,
      ...(a.attrs ? { attrs: a.attrs } : {}),
      start: text.length,
      end: text.length + tag.length,
    })
    text += tag
  }
  return { text, outcome: { v: 1, bodyEnd: body.length, annotations: spans } }
}

/** Render a request with one Bash call and its result, in verbose form. */
function render(content: string, outcome?: unknown): string[] {
  const view = dumpView(
    snapOf({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "seq 14" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content,
              ...(outcome === undefined ? {} : { outcome }),
            },
          ],
        },
      ],
    }),
    { lines: true, sideband: sb },
  )
  return renderDumpBlock(view, undefined, { sideband: sb, enabled: true }).map(strip)
}

const REF = "  │          ↳ "
const PREVIEW = {
  kind: "output-preview",
  attrs: { shown: 10, total: 14, tool: "Bash" },
  body: "the user saw only a part of this output.",
}
const MODE = { kind: "mode-active", attrs: { id: "ask", since: "2026-11-21T00:00:00.000Z" } }

/** The index of the first gutter line whose text starts with `prefix`. */
const lineStarting = (out: readonly string[], prefix: string): number =>
  out.findIndex((l) => /│ /.test(l) && l.slice(l.indexOf("│ ", 3) + 2).startsWith(prefix))

describe.skipIf(!sidebandFixturePresent())("verbose dump: tool_result annotations", () => {
  it("names each annotation of the persisted outcome before its first line", () => {
    const { text, outcome } = result("1\n2\n3", [PREVIEW, MODE])
    const out = render(text, outcome)
    const previewRef = `${REF}annotation · <${sb.name("output-preview")}> · shown 10 · total 14 · tool Bash`
    const modeRef = `${REF}annotation · <${sb.name("mode-active")}> · id ask · since 2026-11-21T00:00:00.000Z`
    const iPreview = out.indexOf(previewRef)
    const iMode = out.indexOf(modeRef)
    expect(iPreview).toBeGreaterThan(-1)
    expect(iMode).toBeGreaterThan(iPreview)
    // Each ref sits right before the first line of its tag.
    expect(out[iPreview + 1]).toBe(out[lineStarting(out, `<${sb.name("output-preview")}`)])
    expect(out[iMode + 1]).toBe(out[lineStarting(out, `<${sb.name("mode-active")}`)])
    // The body lines come before the first annotation ref.
    expect(lineStarting(out, "3")).toBeLessThan(iPreview)
  })

  it("reads the tags from the text when the block has no outcome record", () => {
    const { text } = result("1\n2\n3", [PREVIEW])
    const out = render(text)
    expect(out).toContain(
      `${REF}annotation · <${sb.name("output-preview")}> · shown 10 · total 14 · tool Bash · from text`,
    )
  })

  const RAW = { kind: "raw-output", attrs: { path: "/tmp/x.raw", size: "8.6kB", sha256: "c286" } }

  it("from text: finds a raw-output footer before the preview (the codec hint misses it)", () => {
    const { text } = result("1\n2\n3", [RAW, PREVIEW, MODE])
    const refs = render(text).filter((l) => l.includes("↳ annotation"))
    expect(refs.map((l) => l.split(" · ")[1])).toEqual([
      `<${sb.name("raw-output")}>`,
      `<${sb.name("output-preview")}>`,
      `<${sb.name("mode-active")}>`,
    ])
  })

  it("from record: the same three annotations, with no 'from text' mark", () => {
    const { text, outcome } = result("1\n2\n3", [RAW, PREVIEW, MODE])
    const refs = render(text, outcome).filter((l) => l.includes("↳ annotation"))
    expect(refs).toHaveLength(3)
    expect(refs.some((l) => l.endsWith("from text"))).toBe(false)
  })

  it("trusts the record: no annotation ref when the record has no span", () => {
    // The body itself ends with a tag-like text (for example a Read of a
    // log). The record says that all of it is body.
    const { text } = result("1\n2\n3", [PREVIEW])
    const out = render(text, { v: 1, bodyEnd: text.length, annotations: [] })
    expect(out.some((l) => l.includes("↳ annotation"))).toBe(false)
  })

  it("falls back to the text when the record does not match the text", () => {
    const { text } = result("1\n2\n3", [PREVIEW])
    const out = render(text, { v: 1, bodyEnd: text.length + 50, annotations: [] })
    expect(out.some((l) => l.includes("↳ annotation") && l.endsWith("from text"))).toBe(true)
  })

  it("adds no annotation ref to a plain tool result", () => {
    const out = render("1\n2\n3")
    expect(out.some((l) => l.includes("↳ annotation"))).toBe(false)
  })

  it("puts the ref of an annotation that the line cap hid at the end of the block", () => {
    const body = Array.from({ length: 260 }, (_, i) => String(i)).join("\n")
    const { text, outcome } = result(body, [PREVIEW])
    const out = render(text, outcome)
    const i = out.findIndex((l) => l.includes("↳ annotation"))
    expect(i).toBeGreaterThan(-1)
    expect(out[i]).toContain("not shown")
  })
})
