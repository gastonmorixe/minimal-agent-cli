/**
 * Width rules of the dump block: no output line is wider than the terminal,
 * and each body line starts with the frame gutter. Verbose rows word-wrap
 * and are never cut with `…`.
 */
import { describe, expect, it } from "bun:test"
import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"
import { dumpView } from "../../logging/request-dump-model.ts"
import { snapOf } from "./debug-dump.fixtures.ts"
import { renderDumpBlock } from "./debug-dump.ts"
import { hardWrap, wrapType } from "./debug-dump-verbose.ts"

const ANSI = /\x1b\[[0-9;]*m/g
const plain = (s: string): string => s.replace(ANSI, "")
const LONG = "Do not use Bash to find, read or count code: use Grep, Glob or Read. ".repeat(4)
const ENUM = ["window", "meta", "list", "search", "tool_calls", "blob", "dump"]
const DESC =
  "A new interval between the starts, for example `30s`, `5m` or `2h`. Give this or `nextAtMs` to move a one-time task to a different time."

function view(lines: boolean) {
  const snap = snapOf({
    model: "claude-test",
    tools: [
      {
        name: "Bash",
        description: `${LONG}\nshort\n${LONG}`,
        input_schema: {
          type: "object",
          properties: { command: { type: "string", description: LONG } },
          required: ["command"],
        },
      },
    ],
    system: [{ type: "text", text: LONG }],
    messages: [{ role: "user", content: [{ type: "text", text: `${LONG}\n${LONG}` }] }],
  })
  return dumpView(
    {
      ...snap,
      headers: { "x-long-header": LONG },
      body: { metadata: { user_id: LONG, nested: { k: LONG } } },
    },
    { lines },
  )
}

/** A tool with a long enum type and long parameter descriptions. */
function enumView() {
  return dumpView(
    snapOf({
      model: "claude-test",
      tools: [
        {
          name: "SessionHistory",
          description: `Read a saved session. ${DESC}`,
          input_schema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ENUM, description: DESC },
              every: { type: "string", description: DESC },
              maxBytes: { type: "integer", description: `${DESC} ${DESC}` },
            },
            required: ["action"],
          },
        },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: DESC }] }],
    }),
    { lines: true },
  )
}

function check(rows: string[], width: number): void {
  const body = rows.slice(2, -1)
  for (const r of rows) expect(displayWidth(plain(r))).toBeLessThanOrEqual(width)
  for (const r of body) expect(plain(r).startsWith("  │")).toBe(true)
}

/** The text of a gutter row after its `│ ` or `┆ ` column, else undefined. */
function textOf(row: string): string | undefined {
  const m = /^ {2}│ +(?:\d+ +)?[│┆] (.*)$/.exec(plain(row))
  return m?.[1]
}

describe("dump block width", () => {
  for (const w of [60, 100]) {
    it(`verbose at w${w} keeps each line in the width and the gutter`, () => {
      check(renderDumpBlock(view(true), undefined, { enabled: true, wrapWidth: w }), w)
    })
  }
  it("compact at w60 keeps each line in the width and the gutter", () => {
    check(renderDumpBlock(view(false), 60), 60)
  })
})

describe("verbose params table with a long enum", () => {
  for (const w of [60, 100, 180]) {
    it(`w${w}: no cut, each line in the width, no word split`, () => {
      const rows = renderDumpBlock(enumView(), undefined, { enabled: true, wrapWidth: w })
      check(rows, w)
      const text = rows.map(plain).join("\n")
      // Nothing is cut in the description or the params.
      const bodyRows = rows.map(textOf).filter((t): t is string => t !== undefined)
      for (const t of bodyRows) expect(t.includes("…")).toBe(false)
      // Each word of the description and each enum value is whole on some line.
      for (const word of DESC.split(" ")) expect(text).toContain(word)
      for (const e of ENUM) expect(text).toContain(`"${e}"`)
      // The full description is there after the wrap joins it again.
      const joined = bodyRows.join(" ").replace(/\s+/g, " ")
      expect(joined).toContain(DESC)
    })
  }

  it("w100 keeps the table form with the type column capped", () => {
    const rows = renderDumpBlock(enumView(), undefined, { enabled: true, wrapWidth: 100 }).map(
      plain,
    )
    const action = rows.find((r) => r.includes("action*")) ?? ""
    expect(action).toContain("required")
    expect(action).toContain("A new interval")
  })

  it("w60 uses the stacked form: head line, then the indented description", () => {
    const rows = renderDumpBlock(enumView(), undefined, { enabled: true, wrapWidth: 60 }).map(plain)
    const i = rows.findIndex((r) => r.includes("every?"))
    expect(rows[i]).toMatch(/┆ every\? {2}string {2}optional$/)
    expect(rows[i + 1]).toMatch(/┆ {5}A new interval/)
  })
})

describe("hardWrap word mode", () => {
  it("breaks at spaces and drops the space at the break", () => {
    expect(hardWrap("to move a one-time task", 10, "word")).toEqual([
      "to move a",
      "one-time",
      "task",
    ])
  })
  it("keeps short text whole", () => {
    expect(hardWrap("short", 10, "word")).toEqual(["short"])
  })
  it("cuts only a word that is wider than the line", () => {
    expect(hardWrap("ab supercalifragilistic cd", 8, "word")).toEqual([
      "ab",
      "supercal",
      "ifragili",
      "stic cd",
    ])
  })
  it("keeps the lead indent of the first line", () => {
    expect(hardWrap("    indented text here", 12, "word")).toEqual(["    indented", "text here"])
  })
  it("counts wide characters in cells", () => {
    for (const l of hardWrap("日本語 テキスト 表示幅表示幅", 8, "word"))
      expect(displayWidth(l)).toBeLessThanOrEqual(8)
  })
  it("gives the bare gutter when there is no room", () => {
    expect(hardWrap("abc def", 0, "word")).toEqual([""])
  })
  it("hard mode (the default) still cuts in the middle of a word", () => {
    expect(hardWrap("abc def", 5)).toEqual(["abc d", "ef"])
  })
})

describe("wrapType", () => {
  it("breaks an enum after a `|`", () => {
    expect(wrapType('"window"|"meta"|"list"', 16)).toEqual(['"window"|"meta"|', '"list"'])
  })
  it("cuts one value that is wider than the line", () => {
    expect(wrapType('"abcdefghij"', 6)).toEqual(['"abcde', 'fghij"'])
  })
})
