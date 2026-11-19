import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionCatalogRow } from "@minimal-agent/core/host/session-index"
import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"

import {
  buildSessionsView,
  DEFAULT_SESSIONS_LIMIT,
  MAX_SESSIONS_LIMIT,
  parseSessionsFlags,
  parseSince,
  plainModelLabel,
  presentFlags,
  runSessionsCommand,
  type SessionsFlags,
  sessionModelLabel,
  sessionsErrorLine,
  statusOf,
  subagentLabel,
} from "./sessions.ts"

// ---------------------------------------------------------------------------
// A temp sessions dir per test. Index lines only, plus empty session files:
// the catalog reads a session file only when a row has no index summary.
// ---------------------------------------------------------------------------

// Review M1: HOME does not move the sessions dir; MINIMAL_AGENT_HOME does
// (`resolveAgentHome`). Each run passes `dir` and `writeSummaries: false`;
// this guard also points the default dir to a temp home.
let guardHome: string
const savedHome = process.env.MINIMAL_AGENT_HOME
beforeAll(() => {
  guardHome = mkdtempSync(join(tmpdir(), "ma-cli-sessions-home-"))
  process.env.MINIMAL_AGENT_HOME = guardHome
})
afterAll(() => {
  if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = savedHome
  rmSync(guardHome, { recursive: true, force: true })
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-cli-sessions-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const NOW = Date.UTC(2026, 10, 19, 12, 0)
const ZONE = "UTC"

function sid(n: number, prefix = "aaaaaaaa"): string {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
}

interface Seed {
  sid: string
  /** Minutes after yesterday 12:00 UTC (24 * 60 = now). */
  minute: number
  title?: string
  tokens?: number
  estimated?: boolean
  costUsd?: number
  turns?: number
  status?: "done" | "failed"
  leadSid?: string
  role?: string
  agentId?: string
  model?: string
  cwd?: string
}

/** Write the index (session + summary lines) and an empty file per session. */
function seed(rows: readonly Seed[]): void {
  const lines: string[] = []
  for (const r of rows) {
    const createdAt = new Date(NOW - (24 * 60 - r.minute) * 60_000).toISOString()
    lines.push(
      JSON.stringify({
        sid: r.sid,
        createdAt,
        cwd: r.cwd ?? "/tmp/proj",
        model: r.model ?? "test-model",
        ...(r.leadSid ? { leadSid: r.leadSid } : {}),
        ...(r.role ? { role: r.role } : {}),
        ...(r.agentId ? { agentId: r.agentId } : {}),
      }),
    )
    lines.push(
      JSON.stringify({
        kind: "summary",
        sid: r.sid,
        title: r.title ?? `task ${r.minute}`,
        tokens: r.tokens ?? 1200,
        estimated: r.estimated ?? false,
        ...(r.costUsd === undefined ? {} : { costUsd: r.costUsd }),
        turns: r.turns ?? 1,
        endedAt: new Date(Date.parse(createdAt) + 90_000).toISOString(),
        status: r.status ?? "done",
      }),
    )
    writeFileSync(join(dir, `${r.sid}.jsonl`), "")
  }
  writeFileSync(join(dir, "index.jsonl"), `${lines.join("\n")}\n`)
}

function flags(over: Partial<SessionsFlags> = {}): SessionsFlags {
  return {
    limit: DEFAULT_SESSIONS_LIMIT,
    page: 1,
    all: false,
    subagents: "tree",
    json: false,
    ...over,
  }
}

function run(over: Partial<SessionsFlags> = {}, width = 100): string[] {
  return runSessionsCommand({
    flags: flags(over),
    width,
    color: false,
    dir,
    writeSummaries: false,
    now: NOW,
    timeZone: ZONE,
  }).rows
}

function parse(args: string[], query?: string) {
  const readFlagValue = (name: string): string | undefined => {
    const eq = args.find((a) => a.startsWith(`${name}=`))
    if (eq) return eq.slice(name.length + 1)
    const i = args.indexOf(name)
    return i !== -1 ? args[i + 1] : undefined
  }
  return parseSessionsFlags({
    args,
    ...(query ? { query } : {}),
    readFlagValue,
    cwd: "/work/here",
    now: NOW,
  })
}

describe("parseSince", () => {
  test("reads relative ages", () => {
    expect(parseSince("2d", NOW)).toBe(NOW - 2 * 86_400_000)
    expect(parseSince("12h", NOW)).toBe(NOW - 12 * 3_600_000)
    expect(parseSince("30m", NOW)).toBe(NOW - 30 * 60_000)
    expect(parseSince("1w", NOW)).toBe(NOW - 7 * 86_400_000)
  })
  test("reads a date and rejects junk", () => {
    expect(parseSince("2026-11-18", NOW)).toBe(Date.parse("2026-11-18"))
    expect(parseSince("yesterday", NOW)).toBeUndefined()
    expect(parseSince("2x", NOW)).toBeUndefined()
  })
})

describe("parseSessionsFlags", () => {
  test("defaults", () => {
    expect(parse([])).toEqual({ ok: true, flags: flags() })
  })
  test("reads every flag", () => {
    const r = parse(
      [
        "--limit",
        "5",
        "--page=2",
        "--all",
        "--since",
        "2d",
        "--cwd",
        ".",
        "--model",
        "opus",
        "--subagents",
        "flat",
        "--json",
      ],
      " auth ",
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.flags).toEqual({
      query: "auth",
      limit: 5,
      page: 2,
      all: true,
      sinceMs: NOW - 2 * 86_400_000,
      cwd: "/work/here",
      model: "opus",
      subagents: "flat",
      json: true,
    })
  })
  test("resolves a relative --cwd against the process cwd", () => {
    const r = parse(["--cwd", "../other"])
    expect(r.ok && r.flags.cwd).toBe("/work/other")
  })
  test("rejects bad values with a clear error", () => {
    for (const args of [
      ["--limit", "0"],
      ["--limit", "x"],
      ["--page", "-1"],
      ["--since", "soon"],
      ["--subagents", "deep"],
      ["--cwd"],
      ["--model", "--json"],
    ]) {
      expect(parse(args).ok).toBe(false)
    }
  })
})

describe("runSessionsCommand", () => {
  test("empty store: a hint, no table", () => {
    const text = run().join("\n")
    expect(text).toContain("no saved sessions yet")
    expect(text).toContain(dir)
  })

  test("newest last, day rulers, columns, footer, resume hint", () => {
    seed([
      { sid: sid(1), minute: 60, title: "old task", costUsd: 0.5 },
      { sid: sid(2), minute: 24 * 60 - 30, title: "new task", estimated: true },
    ])
    const text = run().join("\n")
    expect(text).toContain("session")
    expect(text).toContain("prompt")
    expect(text.indexOf("old task")).toBeLessThan(text.indexOf("new task"))
    expect(text).toMatch(/yesterday ─+/)
    expect(text).toMatch(/today ─+/)
    expect(text).toContain("~1.2k")
    expect(text).toContain("$0.50")
    expect(text).not.toContain("[R]")
    expect(text).not.toContain("[E]")
    expect(text).toContain("2 of 2 sessions")
    expect(text).toContain("sessions <sid>")
    expect(text).toContain("ma sessions resume <sid>")
    expect(text).not.toContain("\u001b[")
  })

  test("sub-agents show under the lead, role first", () => {
    const lead = sid(1)
    seed([
      { sid: lead, minute: 24 * 60 - 60, title: "lead task" },
      { sid: sid(2), minute: 24 * 60 - 50, title: "check it", leadSid: lead, role: "reviewer" },
      { sid: sid(3), minute: 24 * 60 - 40, title: "fix it", leadSid: lead, agentId: "A2" },
    ])
    const rows = run()
    const leadRow = rows.findIndex((r) => r.includes("lead task"))
    expect(rows[leadRow + 1]).toMatch(/├ ○ aaaaaaaa.*reviewer · check it/)
    expect(rows[leadRow + 2]).toMatch(/╰ ○ aaaaaaaa.*A2 · fix it/)
    expect(rows.join("\n")).toContain("1 of 1 sessions")
  })

  test("more than 5 children: 4 rows and a +N more row", () => {
    const lead = sid(1)
    const kids = Array.from({ length: 7 }, (_, i) => ({
      sid: sid(10 + i),
      minute: 24 * 60 - 50 + i,
      title: `kid ${i}`,
      leadSid: lead,
      role: "worker",
    }))
    seed([{ sid: lead, minute: 24 * 60 - 60, title: "lead task" }, ...kids])
    const text = run().join("\n")
    expect(text).toContain("kid 3")
    expect(text).not.toContain("kid 4")
    expect(text).toMatch(/╰ … .*\+3 more · sessions aaaaaaaa/)
  })

  test("exactly 5 children: all show, no +N row", () => {
    const lead = sid(1)
    const kids = Array.from({ length: 5 }, (_, i) => ({
      sid: sid(10 + i),
      minute: 24 * 60 - 50 + i,
      title: `kid ${i}`,
      leadSid: lead,
      role: "worker",
    }))
    seed([{ sid: lead, minute: 24 * 60 - 60, title: "lead task" }, ...kids])
    const text = run().join("\n")
    expect(text).toContain("kid 4")
    expect(text).not.toContain("more ·")
  })

  test("--subagents none hides children; flat lists them as top rows", () => {
    const lead = sid(1)
    seed([
      { sid: lead, minute: 24 * 60 - 60, title: "lead task" },
      { sid: sid(2), minute: 24 * 60 - 50, title: "kid task", leadSid: lead, role: "worker" },
    ])
    expect(run({ subagents: "none" }).join("\n")).not.toContain("kid task")
    const flat = run({ subagents: "flat" })
    const kidRow = flat.find((r) => r.includes("kid task")) ?? ""
    expect(kidRow).toMatch(/^ {2}○ aaaaaaaa/)
  })

  test("orphan sub-agents (with --all) group under a (lead <sid8>) row", () => {
    const missing = sid(99, "bbbbbbbb")
    seed([
      { sid: sid(1), minute: 24 * 60 - 60, title: "lead task" },
      { sid: sid(2), minute: 24 * 60 - 50, title: "lost one", leadSid: missing, role: "worker" },
      { sid: sid(3), minute: 24 * 60 - 40, title: "lost two", leadSid: missing, role: "worker" },
    ])
    expect(run().join("\n")).not.toContain("lost one")
    const rows = run({ all: true })
    const group = rows.findIndex((r) => r.includes("(lead bbbbbbbb)"))
    expect(group).toBeGreaterThan(-1)
    expect(rows[group + 1]).toContain("lost one")
    expect(rows[group + 2]).toContain("lost two")
    expect(rows.filter((r) => r.includes("(lead bbbbbbbb)")).length).toBe(1)
  })

  test("hidden rows: count in the footer; --all shows them", () => {
    seed([
      { sid: sid(1), minute: 24 * 60 - 60, title: "real" },
      { sid: sid(2), minute: 24 * 60 - 50, title: "", turns: 0 },
    ])
    expect(run().join("\n")).toContain("1 of 1 sessions · 1 hidden · --all")
    const all = run({ all: true }).join("\n")
    expect(all).toContain("(empty)")
    expect(all).not.toContain("--all ·")
  })

  test("--limit and --page walk from the newest", () => {
    seed(
      Array.from({ length: 5 }, (_, i) => ({ sid: sid(i + 1), minute: 600 + i, title: `t${i}` })),
    )
    const p1 = run({ limit: 2 }).join("\n")
    expect(p1).toContain("t4")
    expect(p1).toContain("t3")
    expect(p1).not.toContain("t2")
    expect(p1).toContain("2 of 5 sessions")
    expect(p1).toContain("--limit N · --page N")
    const p3 = run({ limit: 2, page: 3 }).join("\n")
    expect(p3).toContain("t0")
    expect(p3).not.toContain("t1")
    expect(p3).toContain("page 3")
  })

  test("query is a substring (not a subsequence) on title, cwd, model, sid", () => {
    seed([
      { sid: sid(1), minute: 600, title: "fix the auth flow" },
      { sid: sid(2), minute: 601, title: "a-u-t-h spread out" },
      { sid: sid(3), minute: 602, title: "other", model: "opus-x" },
    ])
    const text = run({ query: "auth" }).join("\n")
    expect(text).toContain("fix the auth flow")
    expect(text).not.toContain("spread out")
    expect(run({ query: "opus" }).join("\n")).toContain("other")
  })

  test("--model and --cwd filter", () => {
    seed([
      { sid: sid(1), minute: 600, title: "in a", cwd: "/a", model: "opus-x" },
      { sid: sid(2), minute: 601, title: "in b", cwd: "/b", model: "sonnet-y" },
    ])
    expect(run({ cwd: "/a" }).join("\n")).not.toContain("in b")
    const m = run({ model: "SONNET" }).join("\n")
    expect(m).toContain("in b")
    expect(m).not.toContain("in a")
  })

  test("no match: a short text and the footer", () => {
    seed([{ sid: sid(1), minute: 600, title: "one" }])
    const text = run({ query: "zzz" }).join("\n")
    expect(text).toContain("no sessions match")
    expect(text).toContain("no sessions")
    expect(text).not.toContain("0 of 0 sessions")
  })

  test("P4c m6: only hidden rows: no sessions · N hidden · --all", () => {
    seed([{ sid: sid(1), minute: 600, title: "", turns: 0 }])
    const text = run().join("\n")
    expect(text).toContain("no sessions · 1 hidden · --all")
    expect(text).not.toContain("0 of 0")
  })

  test("no row is wider than the width, CJK and tree included", () => {
    const lead = sid(1)
    seed([
      { sid: lead, minute: 24 * 60 - 60, title: "日本語 wide chars in a long title ".repeat(4) },
      { sid: sid(2), minute: 24 * 60 - 50, title: "x".repeat(300), leadSid: lead, role: "w" },
      { sid: sid(3), minute: 30, title: "older", costUsd: 1234.5, tokens: 12_345_678 },
    ])
    for (const width of [20, 40, 60, 80, 100, 140]) {
      for (const row of run({}, width)) expect(displayWidth(row)).toBeLessThanOrEqual(width)
      for (const row of run({ all: true }, width)) {
        expect(displayWidth(row)).toBeLessThanOrEqual(width)
      }
    }
  })

  test("--json gives the catalog rows", () => {
    seed([{ sid: sid(1), minute: 600, title: "json me" }])
    const rows = run({ json: true })
    expect(rows.length).toBe(1)
    const parsed = JSON.parse(rows[0] ?? "{}") as { total: number; rows: { sid: string }[] }
    expect(parsed.total).toBe(1)
    expect(parsed.rows[0]?.sid).toBe(sid(1))
  })

  test("P4c m1: --json has unknownCount (rows with no summary line)", () => {
    seed([{ sid: sid(1), minute: 600 }])
    // A second row with no summary line: the catalog cannot know if it is empty.
    const extra = JSON.stringify({
      sid: sid(2),
      createdAt: new Date(NOW - 60_000).toISOString(),
      cwd: "/tmp/proj",
      model: "test-model",
    })
    const index = join(dir, "index.jsonl")
    writeFileSync(index, `${readFileSync(index, "utf-8")}${extra}\n`)
    writeFileSync(join(dir, `${sid(2)}.jsonl`), "")
    const parsed = JSON.parse(run({ json: true })[0] ?? "{}") as { unknownCount: number }
    expect(parsed.unknownCount).toBe(1)
  })
})

describe("buildSessionsView", () => {
  test("reverses the catalog order (newest last); no summary is status unknown", () => {
    const row = (n: number, minute: number) => ({
      sid: sid(n),
      createdAt: new Date(NOW - minute * 60_000).toISOString(),
      cwd: "/",
      model: "m",
      summarySource: "none" as const,
      children: [],
    })
    const view = buildSessionsView({
      result: { rows: [row(1, 1), row(2, 5)], total: 2, hiddenCount: 0, unknownCount: 2 },
      flags: flags(),
      sessionsDir: dir,
      now: NOW,
    })
    expect(view.entries.map((e) => (e.kind === "session" ? e.item.sid : ""))).toEqual([
      sid(2),
      sid(1),
    ])
    const first = view.entries[0]
    expect(first?.kind === "session" ? first.item.status : "").toBe("unknown")
    // The core unknownCount passes to the view (the footer says "about").
    expect(view.unknownCount).toBe(2)
  })
  test("P4b: catalog grandchildren become a nested tree; flat mode lists all levels", () => {
    const node = (
      n: number,
      minute: number,
      children: SessionCatalogRow[] = [],
      turns = 2,
    ): SessionCatalogRow => ({
      sid: sid(n),
      createdAt: new Date(NOW - minute * 60_000).toISOString(),
      cwd: "/",
      model: "m",
      ...(n === 1 ? {} : { leadSid: sid(n - 1), role: "worker" }),
      summary: {
        title: `t${n}`,
        tokens: 1,
        estimated: false,
        turns,
        endedAt: new Date(NOW).toISOString(),
        status: "done",
      },
      summarySource: "index" as const,
      children,
    })
    const grand = node(3, 3, [node(4, 2)])
    const empty = node(5, 2, [], 0)
    const lead = node(1, 10, [node(2, 5, [grand, empty])])
    const result = { rows: [lead], total: 1, hiddenCount: 0, unknownCount: 0 }
    const tree = buildSessionsView({ result, flags: flags(), sessionsDir: dir, now: NOW })
    const entry = tree.entries[0]
    const child = entry?.kind === "session" ? entry.children[0] : undefined
    expect(child?.sid).toBe(sid(2))
    // The empty grandchild is left out without --all.
    expect(child?.children?.map((c) => c.sid)).toEqual([sid(3)])
    expect(child?.children?.[0]?.children?.map((c) => c.sid)).toEqual([sid(4)])
    expect(entry?.kind === "session" ? entry.item.children : "x").toBeUndefined()
    const all = buildSessionsView({
      result,
      flags: flags({ all: true }),
      sessionsDir: dir,
      now: NOW,
    })
    const allEntry = all.entries[0]
    expect(
      allEntry?.kind === "session" ? allEntry.children[0]?.children?.map((c) => c.sid) : [],
    ).toEqual([sid(3), sid(5)])
    const flat = buildSessionsView({
      result,
      flags: flags({ subagents: "flat" }),
      sessionsDir: dir,
      now: NOW,
    })
    expect(flat.subagentRows).toBe(3)
    expect(flat.entries.map((e) => (e.kind === "session" ? e.item.sid : ""))).toEqual([
      sid(1),
      sid(2),
      sid(3),
      sid(4),
    ])
  })
})

// ---------------------------------------------------------------------------
// P3 review findings (P4 fixes)
// ---------------------------------------------------------------------------

describe("P3 review fixes", () => {
  test("m1: --json is version 1, newest last (table order), with children", () => {
    const lead = sid(1)
    seed([
      { sid: lead, minute: 600, title: "older" },
      { sid: sid(2), minute: 700, title: "newer" },
      { sid: sid(3), minute: 610, title: "kid", leadSid: lead, role: "worker" },
    ])
    const parsed = JSON.parse(run({ json: true })[0] ?? "{}") as {
      version: number
      order: string
      rows: { sid: string; children: { sid: string }[] }[]
    }
    expect(parsed.version).toBe(1)
    expect(parsed.order).toBe("newest-last")
    expect(parsed.rows.map((r) => r.sid)).toEqual([lead, sid(2)])
    expect(parsed.rows[0]?.children.map((c) => c.sid)).toEqual([sid(3)])
  })

  test("m2: flat mode counts the sub-agent rows in the footer", () => {
    const lead = sid(1)
    seed([
      { sid: lead, minute: 600, title: "lead" },
      { sid: sid(2), minute: 610, title: "kid a", leadSid: lead, role: "worker" },
      { sid: sid(3), minute: 620, title: "kid b", leadSid: lead, role: "worker" },
    ])
    expect(run({ subagents: "flat" }).join("\n")).toContain("1 of 1 sessions + 2 sub-agents")
    expect(run().join("\n")).toContain("1 of 1 sessions ·")
  })

  test("m2: an orphan group (with --all) counts as a shown row", () => {
    seed([
      { sid: sid(1), minute: 600, title: "lead" },
      { sid: sid(2), minute: 610, title: "lost", leadSid: sid(9, "bbbbbbbb"), role: "w" },
    ])
    expect(run({ all: true }).join("\n")).toContain("2 of 2 sessions")
  })

  test("m3: --page past the end tells the last page", () => {
    seed([1, 2, 3].map((n) => ({ sid: sid(n), minute: 600 + n })))
    const text = run({ limit: 2, page: 5 }).join("\n")
    expect(text).toContain("page 5 is empty · last page is 2")
  })

  test("m4: a flag name that is a flag value is not a flag", () => {
    const r = parse(["--cwd", "--json"])
    expect(r.ok).toBe(false)
    const q = parse(["--since", "2d", "--model", "x", "--subagents", "tree"])
    expect(q.ok && q.flags.json).toBe(false)
    // `--prompt --json`: with the registry arity, the value is skipped.
    const valueFlags = new Set(["--prompt"])
    const args = ["--prompt", "--json", "--all"]
    const r2 = parseSessionsFlags({
      args,
      readFlagValue: () => undefined,
      cwd: "/work/here",
      valueFlags,
    })
    expect(r2.ok && r2.flags.json).toBe(false)
    expect(r2.ok && r2.flags.all).toBe(true)
    expect(presentFlags(["--limit=3", "--json"])).toEqual(new Set(["--limit", "--json"]))
  })

  test("m5: the error line has SGR only with color on", () => {
    expect(sessionsErrorLine("bad", false)).toBe("  error bad")
    expect(sessionsErrorLine("bad", true)).toMatch(/\u001b\[/u)
  })

  test("m6: --limit is clamped; m7: --since 0d is rejected", () => {
    const r = parse(["--limit", "99999999999"])
    expect(r.ok && r.flags.limit).toBe(MAX_SESSIONS_LIMIT)
    expect(parseSince("0d", NOW)).toBeUndefined()
    expect(parse(["--since", "0h"]).ok).toBe(false)
  })

  test("D3: an empty child (0 turns) is hidden unless --all", () => {
    const lead = sid(1)
    seed([
      { sid: lead, minute: 600, title: "lead" },
      { sid: sid(2), minute: 610, title: "", turns: 0, leadSid: lead, role: "worker" },
      { sid: sid(3), minute: 620, title: "real kid", leadSid: lead, role: "worker" },
    ])
    const text = run().join("\n")
    expect(text).toContain("real kid")
    expect(run().filter((r) => r.includes("worker")).length).toBe(1)
    expect(run({ all: true }).filter((r) => r.includes("worker")).length).toBe(2)
    expect(run({ subagents: "flat" }).join("\n")).toContain("+ 1 sub-agent")
  })

  test("s1: a child with an agent id and a role shows both", () => {
    expect(subagentLabel({ agentId: "A6", role: "reviewer" })).toBe("A6 reviewer")
    expect(subagentLabel({ agentId: "A6" })).toBe("A6")
    expect(subagentLabel({})).toBe("sub-agent")
  })

  test("status: unknown status text is unknown (·), not done", () => {
    const sum = (status: string) =>
      ({ summary: { status } }) as unknown as Parameters<typeof statusOf>[0]
    expect(statusOf(sum("done"))).toBe("done")
    expect(statusOf(sum("failed"))).toBe("failed")
    expect(statusOf(sum("ended"))).toBe("unknown")
    expect(statusOf(sum("unknown"))).toBe("unknown")
    expect(statusOf({ live: true })).toBe("live")
    expect(statusOf({})).toBe("unknown")
  })

  test("D4: the model column is a short label; --json and --model keep the full id", () => {
    expect(plainModelLabel("claude-opus-4-7[1m]")).toBe("opus-4-7")
    expect(plainModelLabel("anthropic/claude-opus-5.5")).toBe("opus-5.5")
    expect(plainModelLabel("claude-haiku-4-5-20251001")).toBe("haiku-4-5")
    expect(plainModelLabel("qwen3.7-plus")).toBe("qwen3.7-plus")
    expect(sessionModelLabel("")).toBe("")
    seed([{ sid: sid(1), minute: 600, title: "m", model: "acme/claude-zeta-9[1m]" }])
    const row = run().find((r) => r.includes("aaaaaaaa")) ?? ""
    expect(row).toContain("zeta-9")
    expect(row).not.toContain("acme/")
    expect(run({ model: "acme/claude-zeta" }).join("\n")).toContain("1 of 1 sessions")
    const json = JSON.parse(run({ json: true })[0] ?? "{}") as { rows: { model: string }[] }
    expect(json.rows[0]?.model).toBe("acme/claude-zeta-9[1m]")
  })
})

// ---------------------------------------------------------------------------
// X3a (title SPEC §8, §9.3): the saved title (user > ai > derived) shows in
// the prompt column and in `--json`; with no saved title, the first prompt.
// ---------------------------------------------------------------------------

describe("X3a: saved session titles", () => {
  /** Append title lines to the index sidecar (`index-meta.jsonl`). */
  function titles(lines: readonly { sid: string; title: string; source: string }[]): void {
    const text = lines
      .map((l) => JSON.stringify({ kind: "title", v: 1, at: new Date(NOW).toISOString(), ...l }))
      .join("\n")
    writeFileSync(join(dir, "index-meta.jsonl"), `${text}\n`)
  }
  const rowOf = (rows: string[], n: number): string => rows.find((r) => r.includes(`row${n}`)) ?? ""

  test("the list shows the ai title with a dim ✦; no title shows the first prompt", () => {
    seed([
      { sid: sid(1), minute: 600, title: "row1 first prompt" },
      { sid: sid(2, "bbbbbbbb"), minute: 610, title: "row2 first prompt" },
    ])
    titles([{ sid: sid(1), title: "row1 ai title", source: "ai" }])
    const rows = run()
    expect(rowOf(rows, 1)).toContain("✦ row1 ai title")
    expect(rows.join("\n")).not.toContain("row1 first prompt")
    expect(rowOf(rows, 2)).toContain("row2 first prompt")
    expect(rowOf(rows, 2)).not.toContain("✦")
    const colored = runSessionsCommand({
      flags: flags(),
      width: 100,
      color: true,
      dir,
      writeSummaries: false,
      now: NOW,
      timeZone: ZONE,
    }).rows.join("\n")
    // The mark is dim (SGR 2), the title is plain.
    expect(colored).toMatch(/\u001b\[2m✦ /u)
  })

  test("a user title wins over the ai title and has no mark", () => {
    seed([{ sid: sid(1), minute: 600, title: "row1 first prompt" }])
    titles([
      { sid: sid(1), title: "row1 ai title", source: "ai" },
      { sid: sid(1), title: "row1 user title", source: "user" },
    ])
    const text = run().join("\n")
    expect(text).toContain("row1 user title")
    expect(text).not.toContain("ai title")
    expect(text).not.toContain("✦")
  })

  test("the query matches the saved title", () => {
    seed([
      { sid: sid(1), minute: 600, title: "row1 first prompt" },
      { sid: sid(2), minute: 610, title: "row2 first prompt" },
    ])
    titles([{ sid: sid(1), title: "row1 zebra", source: "ai" }])
    const text = run({ query: "zebra" }).join("\n")
    expect(text).toContain("row1 zebra")
    expect(text).not.toContain("row2")
  })

  test("--json rows get title, titleSource, and prompt (children too)", () => {
    const lead = sid(1)
    seed([
      { sid: lead, minute: 600, title: "lead prompt" },
      { sid: sid(2), minute: 610, title: "kid prompt", leadSid: lead, role: "worker" },
      { sid: sid(3), minute: 620, title: "plain prompt" },
    ])
    titles([
      { sid: lead, title: "Lead AI title", source: "ai" },
      { sid: sid(2), title: "Kid user title", source: "user" },
    ])
    type Row = { sid: string; title: string; titleSource?: string; prompt?: string }
    const parsed = JSON.parse(run({ json: true })[0] ?? "{}") as {
      rows: (Row & { summary?: { title: string }; children: Row[] })[]
    }
    const leadRow = parsed.rows.find((r) => r.sid === lead)
    expect(leadRow?.title).toBe("Lead AI title")
    expect(leadRow?.titleSource).toBe("ai")
    expect(leadRow?.prompt).toBe("lead prompt")
    // The summary keeps the first prompt.
    expect(leadRow?.summary?.title).toBe("lead prompt")
    const kid = leadRow?.children[0]
    expect(kid).toMatchObject({
      title: "Kid user title",
      titleSource: "user",
      prompt: "kid prompt",
    })
    const plain = parsed.rows.find((r) => r.sid === sid(3))
    expect(plain?.title).toBe("plain prompt")
    expect(plain?.prompt).toBe("plain prompt")
    expect(plain && "titleSource" in plain).toBe(false)
  })

  test("a long ai title keeps each row inside the width", () => {
    seed([{ sid: sid(1), minute: 600, title: "p" }])
    titles([{ sid: sid(1), title: "日本語 wide AI title ".repeat(4).slice(0, 80), source: "ai" }])
    for (const width of [20, 40, 60, 80, 100, 140]) {
      for (const row of run({}, width)) expect(displayWidth(row)).toBeLessThanOrEqual(width)
    }
  })
})
