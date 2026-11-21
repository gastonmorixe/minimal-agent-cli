import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import {
  DEFAULT_SESSIONS_WIDTH,
  descendantCount,
  formatTokensCell,
  lastPage,
  renderSessionsList,
  resolveSessionsWidth,
  SESSIONS_COLUMNS,
  type SessionListItem,
  type SessionsListView,
  sessionsColumns,
  sessionsFooter,
} from "./sessions-command.ts"

function view(over: Partial<SessionsListView> = {}): SessionsListView {
  return {
    entries: [],
    shown: 0,
    total: 0,
    hiddenCount: 0,
    showAll: false,
    page: 1,
    limit: 30,
    filtered: false,
    sessionsDir: "/tmp/s",
    ...over,
  }
}

describe("resolveSessionsWidth", () => {
  test("TTY columns win", () => {
    expect(resolveSessionsWidth({ isTTY: true, columns: 77 }, { COLUMNS: "200" })).toBe(77)
  })
  test("not a TTY: COLUMNS, else the default", () => {
    expect(resolveSessionsWidth({ isTTY: false, columns: 77 }, { COLUMNS: "120" })).toBe(120)
    expect(resolveSessionsWidth({}, { COLUMNS: "abc" })).toBe(DEFAULT_SESSIONS_WIDTH)
    expect(resolveSessionsWidth({}, { COLUMNS: "0" })).toBe(DEFAULT_SESSIONS_WIDTH)
    expect(resolveSessionsWidth({}, {})).toBe(DEFAULT_SESSIONS_WIDTH)
  })
})

describe("formatTokensCell", () => {
  test("~ before an estimate, — when not known", () => {
    expect(formatTokensCell({ tokens: 4300, estimated: true })).toBe("~4.3k")
    expect(formatTokensCell({ tokens: 4300, estimated: false })).toBe("4.3k")
    expect(formatTokensCell({})).toBe("—")
    // No estimator for the model: the count is not known, not `~0`.
    expect(formatTokensCell({ tokens: 0, estimated: true, tokensUnknown: true })).toBe("—")
    expect(formatTokensCell({ tokens: 120, estimated: true, tokensUnknown: true })).toBe("—")
  })
})

describe("sessionsFooter", () => {
  test("all parts", () => {
    expect(sessionsFooter(view({ shown: 30, total: 17_494, hiddenCount: 23 }))).toBe(
      "30 of 17,494 sessions · 23 hidden · --all · --limit N · --page N · sessions <sid>",
    )
  })
  test("no hidden, one page", () => {
    expect(sessionsFooter(view({ shown: 2, total: 2 }))).toBe("2 of 2 sessions · sessions <sid>")
  })
  test("P4c m6: no visible row: no sessions · N hidden · --all", () => {
    expect(sessionsFooter(view({ hiddenCount: 3 }))).toBe("no sessions · 3 hidden · --all")
    expect(sessionsFooter(view({ hiddenCount: 3, unknownCount: 2 }))).toBe(
      "no sessions · ≥3 hidden · --all",
    )
    // --all: no hidden part (the hidden rows would be in the total).
    expect(sessionsFooter(view({ hiddenCount: 3, showAll: true }))).toBe("no sessions")
    expect(sessionsFooter(view())).toBe("no sessions")
  })
  test("--all drops the --all hint; a later page shows its number", () => {
    expect(
      sessionsFooter(
        view({ shown: 1, total: 3, hiddenCount: 1, showAll: true, page: 3, limit: 1 }),
      ),
    ).toBe("1 of 3 sessions · page 3 · 1 hidden · sessions <sid>")
  })
  test("unknownCount > 0: about M sessions and ≥N hidden", () => {
    expect(
      sessionsFooter(view({ shown: 30, total: 17_414, hiddenCount: 24, unknownCount: 17_359 })),
    ).toBe(
      "30 of about 17,414 sessions · ≥24 hidden · --all · --limit N · --page N · sessions <sid>",
    )
  })
  test("unknownCount > 0 and no known hidden row: no hidden part", () => {
    expect(sessionsFooter(view({ shown: 2, total: 2, unknownCount: 2 }))).toBe(
      "2 of about 2 sessions · sessions <sid>",
    )
  })
  test("unknownCount 0: exact counts", () => {
    expect(sessionsFooter(view({ shown: 2, total: 2, hiddenCount: 1, unknownCount: 0 }))).toBe(
      "2 of 2 sessions · 1 hidden · --all · sessions <sid>",
    )
  })
})

describe("renderSessionsList", () => {
  test("empty store hint with color off has no SGR and fits the width", () => {
    const rows = renderSessionsList(view({ sessionsDir: "/a/very/long/path/to/sessions" }), {
      width: 20,
      color: false,
    })
    expect(rows.join("\n")).not.toContain("\u001b[")
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(20)
  })
  test("color on paints the hint", () => {
    const rows = renderSessionsList(view(), { width: 80, color: true })
    expect(rows.join("\n")).toContain("\u001b[")
  })
})

describe("P3 review fixes (chrome)", () => {
  test("m3: an empty page past the end names the last page", () => {
    const text = renderSessionsList(view({ total: 45, page: 9, limit: 10 }), {
      width: 80,
      color: false,
    }).join("\n")
    expect(text).toContain("page 9 is empty · last page is 5")
    expect(lastPage({ total: 0, limit: 30 })).toBe(1)
  })
  test("m2: flat-mode footer names the sub-agent rows", () => {
    expect(sessionsFooter(view({ shown: 2, total: 2, subagentRows: 3 }))).toContain(
      "2 of 2 sessions + 3 sub-agents",
    )
  })
  test("D4: the model column is at most 12 cells", () => {
    const model = SESSIONS_COLUMNS.find((col) => col.key === "model")
    expect(model?.maxWidth).toBe(12)
  })
})

// ---------------------------------------------------------------------------
// P4b item 2: grandchildren. The list shows depth 1 and 2 with tree arms;
// deeper levels collapse into one `… +N deeper · sessions <sid8>` row.

describe("P4b: sub-agent tree depth in the list", () => {
  const T = Date.UTC(2026, 10, 19, 11, 0)
  const item = (
    n: number,
    title: string,
    over: Partial<SessionListItem> = {},
  ): SessionListItem => ({
    sid: `${String(n).repeat(8)}-1111-4000-8000-000000000000`,
    createdAtMs: T + n * 60_000,
    durationMs: 60_000,
    title,
    tokens: 1200,
    model: "opus-4.7",
    status: "done",
    subagent: true,
    role: `A${n} worker`,
    ...over,
  })
  const deep = item(4, "depth 3", { children: [item(5, "depth 4")] })
  const tree: SessionsListView = view({
    shown: 1,
    total: 1,
    entries: [
      {
        kind: "session",
        item: item(1, "lead task", { subagent: false, role: undefined }),
        children: [
          item(2, "child 1", {
            children: [item(3, "grandchild 1", { children: [deep] }), item(6, "grandchild 2")],
          }),
          item(7, "child 2"),
        ],
      },
    ],
  })
  const render = (width: number): string[] =>
    renderSessionsList(tree, { width, color: false, now: T + 3_600_000, timeZone: "UTC" })

  test("descendantCount counts all levels", () => {
    expect(descendantCount(deep)).toBe(1)
    const first = tree.entries[0]
    expect(first?.kind === "session" ? first.children.map(descendantCount) : []).toEqual([4, 0])
  })

  test("golden w100: depth 1 and 2 rows, deeper levels collapse", async () => {
    const rows = render(100)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(100)
    const golden = await Bun.file(
      join(import.meta.dir, "__golden__", "sessions-list-tree-w100.txt"),
    ).text()
    expect(`${rows.join("\n")}\n`).toBe(golden)
  })

  test("arms: ├ ╰ and │ continuation; no depth-3 session row", () => {
    const text = render(100).join("\n")
    expect(text).toContain("├ ○ 22222222")
    expect(text).toContain("│ ├ ○ 33333333")
    expect(text).toContain("│ │ ╰ …")
    expect(text).toContain("+2 deeper · sessions 33333333")
    expect(text).toContain("│ ╰ ○ 66666666")
    expect(text).toContain("╰ ○ 77777777")
    expect(text).not.toContain("44444444")
    expect(text).not.toContain("55555555")
  })

  test("P4c: depth 3+ collapses into one +N deeper row that counts all descendants", () => {
    const chain = item(13, "depth 3", {
      children: [item(14, "depth 4", { children: [item(15, "depth 5")] }), item(16, "depth 4b")],
    })
    const v = view({
      shown: 1,
      total: 1,
      entries: [
        {
          kind: "session",
          item: item(11, "lead", { subagent: false, role: undefined }),
          children: [
            item(12, "depth 1", { children: [item(17, "depth 2", { children: [chain] })] }),
          ],
        },
      ],
    })
    const text = renderSessionsList(v, {
      width: 100,
      color: false,
      now: T + 3_600_000,
      timeZone: "UTC",
    }).join("\n")
    expect(text).toContain("depth 2")
    // depth 3, 4, 4b and 5: 4 sessions in one row under the depth-2 row.
    expect(text).toContain(`+4 deeper · sessions ${"17".repeat(4)}`)
    for (const hidden of ["depth 3", "depth 4", "depth 5"]) expect(text).not.toContain(hidden)
    expect(text.match(/deeper/gu)?.length).toBe(1)
  })

  test("P4c: sessionsColumns widens the id column 2 cells per level past 1", () => {
    const base = SESSIONS_COLUMNS.find((c) => c.key === "id")?.width ?? 0
    const idWidth = (depths: (number | undefined)[], withStart = true) =>
      sessionsColumns([
        {
          rows: depths.map((depth) => ({
            cells: withStart ? { id: "x", start: "10:00" } : { id: "…" },
            ...(depth === undefined ? {} : { depth }),
          })),
        },
      ] as Parameters<typeof sessionsColumns>[0]).find((c) => c.key === "id")?.width
    expect(idWidth([undefined, 0])).toBe(base)
    expect(idWidth([0, 1])).toBe(base)
    expect(idWidth([0, 1, 2])).toBe(base + 2)
    expect(idWidth([3])).toBe(base + 4)
    // A `…` row (no start cell) does not widen the column.
    expect(idWidth([5], false)).toBe(base)
    // The other columns do not change.
    const keys = (cols: readonly { key: string }[]) => cols.map((c) => c.key)
    expect(keys(sessionsColumns([]))).toEqual(keys(SESSIONS_COLUMNS))
  })

  test("narrow widths keep each row inside the width", () => {
    for (const width of [40, 60, 80]) {
      for (const row of render(width)) expect(row.length).toBeLessThanOrEqual(width)
    }
  })
})

// ---------------------------------------------------------------------------
// X3a (title SPEC §8, §9.4): the prompt column shows the saved title. An AI
// title gets a dim `✦`; a user title and the first-prompt fallback get no mark.

describe("X3a: saved titles in the list", () => {
  const T = Date.UTC(2026, 10, 19, 11, 0)
  const item = (n: number, over: Partial<SessionListItem>): SessionListItem => ({
    sid: `${String(n).repeat(8)}-1111-4000-8000-000000000000`,
    createdAtMs: T + n * 60_000,
    durationMs: 60_000,
    title: "",
    tokens: 1200,
    costUsd: 0.12,
    model: "opus-5.5",
    status: "done",
    ...over,
  })
  const titled: SessionsListView = view({
    shown: 4,
    total: 4,
    entries: [
      // user title, ai title, no saved title (first prompt), fork + ai title
      item(1, { title: "My own name", titleSource: "user", prompt: "first one" }),
      item(2, { title: "Session title plugin spec", titleSource: "ai", prompt: "write" }),
      item(3, { title: "Fix the flaky catalog test in session-catalog.test.ts now" }),
      item(4, { title: "Resumed AI title", titleSource: "ai", fork: true }),
    ].map((it) => ({ kind: "session" as const, item: it, children: [] })),
  })
  const render = (width: number, color = false): string[] =>
    renderSessionsList(titled, { width, color, now: T + 3_600_000, timeZone: "UTC" })

  test("golden w100: user, ai, and no-title rows", async () => {
    const rows = render(100)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(100)
    const golden = await Bun.file(
      join(import.meta.dir, "__golden__", "sessions-list-titles-w100.txt"),
    ).text()
    expect(`${rows.join("\n")}\n`).toBe(golden)
  })

  test("only ai rows get ✦; the fork mark comes first; the mark is dim", () => {
    const rows = render(100)
    const line = (text: string) => rows.find((r) => r.includes(text)) ?? ""
    expect(line("Session title plugin spec")).toContain("✦ Session title plugin spec")
    expect(line("My own name")).not.toContain("✦")
    expect(line("Fix the flaky")).not.toContain("✦")
    expect(line("Resumed AI title")).toContain("↻ ✦ Resumed AI title")
    expect(render(100, true).join("\n")).toMatch(/\u001b\[2m✦ /u)
  })

  test("an ai sub-agent row keeps the role first", () => {
    const v = view({
      shown: 1,
      total: 1,
      entries: [
        {
          kind: "session",
          item: item(1, { title: "lead" }),
          children: [
            item(2, {
              title: "Kid AI title",
              titleSource: "ai",
              subagent: true,
              role: "A2 worker",
            }),
          ],
        },
      ],
    })
    const text = renderSessionsList(v, { width: 100, color: false, now: T, timeZone: "UTC" })
    expect(text.join("\n")).toContain("A2 worker · ✦ Kid AI title")
  })

  test("narrow widths keep each row inside the width", () => {
    for (const width of [20, 40, 60, 80, 140]) {
      for (const row of render(width)) expect(row.length).toBeLessThanOrEqual(width)
    }
  })
})
