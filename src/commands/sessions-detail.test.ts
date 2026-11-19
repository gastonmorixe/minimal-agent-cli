import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionCatalogRow } from "@minimal-agent/core/host/session-index"
import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"

import { renderSessionDetail } from "../ui/chrome/sessions-detail.ts"

import { DEFAULT_SESSIONS_LIMIT, type SessionsFlags } from "./sessions.ts"
import {
  addDeepChildren,
  buildSessionDetailView,
  findSessionRow,
  lastSessionSid,
  looksLikeSidPrefix,
  readIndexSnapshot,
  resolveSessionsArg,
  runSessionDetail,
  runSessionsEntry,
} from "./sessions-detail.ts"

// ---------------------------------------------------------------------------
// Isolation (review M1): every run gets `dir` (a temp sessions dir) and
// `writeSummaries: false`. As a second guard, MINIMAL_AGENT_HOME (the real
// sessions-dir override: `resolveAgentHome`, not HOME) points to a temp dir,
// so a run that forgets `dir` cannot touch the real ~/.minimal-agent.
// ---------------------------------------------------------------------------

let guardHome: string
const savedHome = process.env.MINIMAL_AGENT_HOME
beforeAll(() => {
  guardHome = mkdtempSync(join(tmpdir(), "ma-cli-detail-home-"))
  process.env.MINIMAL_AGENT_HOME = guardHome
})
afterAll(() => {
  if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = savedHome
  rmSync(guardHome, { recursive: true, force: true })
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-cli-detail-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const NOW = Date.UTC(2026, 10, 19, 12, 0)
const ZONE = "UTC"
const HOME = "/Users/x"
const GOLDEN_DIR = join(import.meta.dir, "..", "ui", "chrome", "__golden__")

const LEAD = "e0f2d3d3-1111-4000-8000-000000000001"
const WORKER = "ecb565ab-1111-4000-8000-000000000002"
const REVIEWER = "4ba189cc-1111-4000-8000-000000000003"
const INTEGRATOR = "217a4f68-1111-4000-8000-000000000004"
const EXPLORER = "aa11bb22-1111-4000-8000-000000000005"
const ALONE = "c0ffee00-2222-4000-8000-000000000006"

interface Seed {
  sid: string
  /** Seconds after NOW - 1h. */
  start: number
  /** Seconds after NOW - 1h. No summary line when undefined. */
  end?: number
  title?: string
  tokens?: number
  costUsd?: number
  turns?: number
  status?: string
  leadSid?: string
  role?: string
  agentId?: string
  model?: string
  cwd?: string
}

const at = (s: number): string => new Date(NOW - 3_600_000 + s * 1000).toISOString()

function seed(rows: readonly Seed[]): void {
  const lines: string[] = []
  for (const r of rows) {
    lines.push(
      JSON.stringify({
        sid: r.sid,
        createdAt: at(r.start),
        cwd: r.cwd ?? "/Users/x/vairix/arcana/code",
        // An id that no provider plugin knows: the label does not depend on
        // the plugins that other tests register (plain label: zeta-model-2).
        model: r.model ?? "acme/zeta-model-2[1m]",
        ...(r.leadSid ? { leadSid: r.leadSid } : {}),
        ...(r.role ? { role: r.role } : {}),
        ...(r.agentId ? { agentId: r.agentId } : {}),
      }),
    )
    if (r.end !== undefined) {
      lines.push(
        JSON.stringify({
          kind: "summary",
          sid: r.sid,
          title: r.title ?? "",
          tokens: r.tokens ?? 1000,
          estimated: false,
          ...(r.costUsd === undefined ? {} : { costUsd: r.costUsd }),
          turns: r.turns ?? 3,
          endedAt: at(r.end),
          status: r.status ?? "done",
        }),
      )
    }
    writeFileSync(join(dir, `${r.sid}.jsonl`), "")
  }
  writeFileSync(join(dir, "index.jsonl"), `${lines.join("\n")}\n`)
}

/** Mockup D data: a lead, three sub-agents (one failed), one depth-2 child. */
const TREE: Seed[] = [
  {
    sid: LEAD,
    start: 0,
    end: 542,
    title: "fix flaky checkout e2e test",
    tokens: 10_700_000,
    costUsd: 6.12,
    turns: 63,
  },
  {
    sid: WORKER,
    start: 60,
    end: 280,
    leadSid: LEAD,
    role: "worker",
    agentId: "A1",
    title: "patch retry logic in cart.ts",
    tokens: 4_500_000,
  },
  {
    sid: REVIEWER,
    start: 290,
    end: 420,
    leadSid: LEAD,
    role: "reviewer",
    agentId: "A2",
    title: "review the diff for races",
    tokens: 2_700_000,
  },
  {
    sid: INTEGRATOR,
    start: 430,
    end: 478,
    leadSid: LEAD,
    role: "integrator",
    agentId: "A3",
    title: "run suite and commit",
    tokens: 351_000,
    status: "failed",
  },
  {
    sid: EXPLORER,
    start: 300,
    end: 380,
    leadSid: REVIEWER,
    role: "explorer",
    agentId: "B1",
    title: "read the cart module",
    tokens: 90_000,
    // A status text that this CLI does not know: shows as unknown (·).
    status: "ended",
  },
]

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

function run(query: string | undefined, width = 100, over: Partial<SessionsFlags> = {}) {
  return runSessionsEntry({
    flags: flags({ ...(query === undefined ? {} : { query }), ...over }),
    width,
    color: false,
    dir,
    writeSummaries: false,
    now: NOW,
    timeZone: ZONE,
    home: HOME,
  })
}

describe("sessions <sid>: detail view goldens", () => {
  for (const width of [60, 80, 100, 140]) {
    test(`width ${width}`, async () => {
      seed(TREE)
      const { rows, exitCode } = run("e0f2", width)
      expect(exitCode).toBeUndefined()
      for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(width)
      const golden = await Bun.file(join(GOLDEN_DIR, `sessions-detail-w${width}.txt`)).text()
      expect(`${rows.join("\n")}\n`).toBe(golden)
    })
  }
})

describe("sessions <sid>: detail view", () => {
  test("header: title, model label, cwd, start, duration, turns, tokens, cost, status", () => {
    seed(TREE)
    const text = run(LEAD).rows.join("\n")
    expect(text).toContain("e0f2d3d3  fix flaky checkout e2e test")
    for (const part of [
      "zeta-model-2",
      "~/vairix/arcana/code",
      "today 11:00",
      "9m02s",
      "63 turns",
      "10.7M tok",
      "$6.12",
      "○ done",
    ]) {
      expect(text).toContain(part)
    }
    expect(text).not.toContain("acme/")
  })

  test("tree: lead row, all depths, prompt on the next line, hints", () => {
    seed(TREE)
    const rows = run("e0f2").rows
    const text = rows.join("\n")
    expect(text).toContain("○ lead")
    expect(text).toMatch(/├─ ○ A1 worker +ecb565ab/u)
    expect(text).toMatch(/│ {2}╰─ · B1 explorer +aa11bb22/u)
    expect(text).toMatch(/╰─ ✗ A3 integrator +217a4f68/u)
    const i = rows.findIndex((r) => r.includes("ecb565ab"))
    expect(rows[i + 1]).toContain("patch retry logic in cart.ts")
    expect(text).toContain("failed: A3 integrator 217a4f68 → ma sessions dump 217a4f68")
    expect(text).toContain("resume: ma sessions resume e0f2d3d3")
  })

  test("timeline bars line up with the lead span", () => {
    seed(TREE)
    const rows = run("e0f2", 140).rows
    const lead = rows.find((r) => r.includes("○ lead")) ?? ""
    const worker = rows.find((r) => r.includes("ecb565ab")) ?? ""
    expect(lead.indexOf("▕")).toBe(worker.indexOf("▕"))
    expect(lead.indexOf("▏")).toBe(worker.indexOf("▏"))
    // The lead bar is full; the worker bar starts later.
    const leadBar = lead.slice(lead.indexOf("▕") + 1, lead.indexOf("▏"))
    expect(leadBar).toMatch(/^▬+$/u)
    const workerBar = worker.slice(worker.indexOf("▕") + 1, worker.indexOf("▏"))
    expect(workerBar.startsWith(" ")).toBe(true)
  })

  test("narrow width: the bars drop, no row is wider than the width", () => {
    seed(TREE)
    for (const width of [20, 30, 40, 50]) {
      const rows = run("e0f2", width).rows
      for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(width)
    }
    expect(run("e0f2", 40).rows.join("\n")).not.toContain("▕")
  })

  test("no children: the header and a short line", () => {
    seed([{ sid: ALONE, start: 0, end: 60, title: "just me" }])
    const text = run("c0ffee").rows.join("\n")
    expect(text).toContain("just me")
    expect(text).toContain("no sub-agent sessions")
    expect(text).toContain("resume: ma sessions resume c0ffee00")
  })

  test("a sub-agent sid shows its own subtree and its lead", () => {
    seed(TREE)
    const text = run(REVIEWER.slice(0, 6)).rows.join("\n")
    expect(text).toContain("4ba189cc  review the diff for races")
    expect(text).toContain("sub-agent of e0f2d3d3 · ma sessions e0f2d3d3")
    expect(text).toContain("B1 explorer")
    expect(text).not.toContain("A1 worker")
  })

  test("--json: version 1 and the catalog row with children (full model id)", () => {
    seed(TREE)
    const json = JSON.parse(run("e0f2", 100, { json: true }).rows.join("\n"))
    expect(json.version).toBe(1)
    expect(json.kind).toBe("session")
    expect(json.row.sid).toBe(LEAD)
    expect(json.row.model).toBe("acme/zeta-model-2[1m]")
    expect(json.row.children.map((c: { sid: string }) => c.sid)).toEqual([
      WORKER,
      REVIEWER,
      INTEGRATOR,
    ])
    expect(json.row.children[1].children[0].sid).toBe(EXPLORER)
  })

  test("writeSummaries false: the index does not change (review M1)", () => {
    // No summary line: the catalog would compute one and append it.
    seed([{ sid: ALONE, start: 0 }])
    const before = readFileSync(join(dir, "index.jsonl"), "utf-8")
    run("c0ffee")
    expect(readFileSync(join(dir, "index.jsonl"), "utf-8")).toBe(before)
    expect(existsSync(join(dir, "index-meta.jsonl"))).toBe(false)
  })

  test("P4c M1: newer rows whose title contains the sid do not push the row out", () => {
    const others = Array.from({ length: 12 }, (_, i) => ({
      sid: `f${String(i).padStart(7, "0")}-4444-4000-8000-000000000000`,
      start: 100 + i,
      end: 200,
      title: `notes about ${ALONE}`,
    }))
    seed([{ sid: ALONE, start: 0, end: 50, title: "the target" }, ...others])
    const text = run(ALONE).rows.join("\n")
    expect(text).toContain("the target")
  })

  test("P4c M1: the caller decides writeSummaries; only the target row is resolved", () => {
    // Newer rows with no summary line whose cwd contains the sid: the old
    // query lookup resolved and appended them too.
    const others = Array.from({ length: 3 }, (_, i) => ({
      sid: `f${String(i).padStart(7, "0")}-5555-4000-8000-000000000000`,
      start: 100 + i,
      cwd: `/tmp/${ALONE}`,
    }))
    seed([{ sid: ALONE, start: 0 }, ...others])
    const snapshot = readIndexSnapshot(dir)
    const opts = { sid: ALONE, snapshot, width: 100, color: false, json: true, dir, now: NOW }
    // Core appends summary lines to the index or to its sidecar file.
    const summaryLines = () =>
      ["index.jsonl", "index-meta.jsonl"]
        .flatMap((name) => {
          try {
            return readFileSync(join(dir, name), "utf-8").split("\n")
          } catch {
            return []
          }
        })
        .filter((l) => l.includes('"kind":"summary"'))
    runSessionDetail({ ...opts, writeSummaries: false })
    expect(summaryLines()).toEqual([])
    runSessionDetail({ ...opts, writeSummaries: true })
    const added = summaryLines()
    expect(added.length).toBe(1)
    expect(added[0]).toContain(ALONE)
  })
})

describe("resolveSessionsArg (item 29)", () => {
  test("a sid prefix needs 4+ hex characters", () => {
    expect(looksLikeSidPrefix("e0f2")).toBe(true)
    expect(looksLikeSidPrefix("e0f")).toBe(false)
    expect(looksLikeSidPrefix("e0f2d3d3-1111")).toBe(true)
    expect(looksLikeSidPrefix("auth")).toBe(false)
    expect(looksLikeSidPrefix("2026-05")).toBe(true)
  })

  test("unique prefix → detail; full sid → detail", () => {
    seed(TREE)
    const snap = readIndexSnapshot(dir)
    expect(resolveSessionsArg("e0f2", snap, { dir })).toEqual({ kind: "detail", sid: LEAD })
    expect(resolveSessionsArg("E0F2D3", snap, { dir })).toEqual({ kind: "detail", sid: LEAD })
    expect(resolveSessionsArg(WORKER, snap, { dir })).toEqual({ kind: "detail", sid: WORKER })
  })

  test("ambiguous prefix → the matches, newest first; the list shows them", () => {
    seed([
      { sid: "abcd0001-0000-4000-8000-000000000001", start: 0, end: 10, title: "one" },
      { sid: "abcd0002-0000-4000-8000-000000000002", start: 20, end: 30, title: "two" },
    ])
    const target = resolveSessionsArg("abcd", readIndexSnapshot(dir), { dir })
    expect(target.kind).toBe("ambiguous")
    if (target.kind !== "ambiguous") return
    expect(target.matches.map((m) => m.title)).toEqual(["two", "one"])
    const { rows, exitCode } = run("abcd")
    expect(exitCode).toBe(1)
    const text = rows.join("\n")
    expect(text).toContain("2 sessions start with abcd")
    expect(text).toContain("abcd0002-0000")
  })

  test("short, non-hex or unknown token → query", () => {
    seed(TREE)
    const snap = readIndexSnapshot(dir)
    expect(resolveSessionsArg("e0f", snap, { dir })).toEqual({ kind: "query", query: "e0f" })
    expect(resolveSessionsArg("checkout", snap, { dir })).toEqual({
      kind: "query",
      query: "checkout",
    })
    expect(resolveSessionsArg("ffff", snap, { dir })).toEqual({ kind: "query", query: "ffff" })
    expect(resolveSessionsArg(undefined, snap, { dir })).toEqual({ kind: "none" })
    // A query that is not a sid prefix gives the list.
    expect(run("checkout").rows.join("\n")).toContain("session ")
  })

  test("P6: a tombstone in index-meta.jsonl hides the sid in the detail lookup", () => {
    seed([...TREE, { sid: ALONE, start: 70, end: 80, title: "removed" }])
    // Before the tombstone: ALONE resolves to the detail view.
    expect(resolveSessionsArg("c0ffee00", readIndexSnapshot(dir), { dir })).toEqual({
      kind: "detail",
      sid: ALONE,
    })
    // A sidecar summary for LEAD (v3 shape) merges with the old summary line.
    const meta = [
      JSON.stringify({ kind: "tombstone", sid: ALONE, at: at(3000) }),
      JSON.stringify({
        kind: "summary",
        v: 3,
        sid: LEAD,
        title: "sidecar title",
        tokens: 1,
        estimated: false,
        turns: 1,
        endedAt: at(3000),
        status: "done",
      }),
    ]
    writeFileSync(join(dir, "index-meta.jsonl"), `${meta.join("\n")}\n`)
    const snap = readIndexSnapshot(dir)
    expect(snap.sessions.some((r) => r.sid === ALONE)).toBe(false)
    expect(snap.summaries.has(ALONE)).toBe(false)
    expect(resolveSessionsArg("c0ffee00", snap, { dir })).toEqual({
      kind: "query",
      query: "c0ffee00",
    })
    // Summaries merge: the sidecar line wins; old index.jsonl lines are still read.
    expect(snap.summaries.get(LEAD)?.title).toBe("sidecar title")
    expect(snap.summaries.get(WORKER)).toBeDefined()
  })

  test("F4: a sid prefix counts only lines whose session file exists", () => {
    const LIVE = "abcd0001-0000-4000-8000-000000000001"
    const GONE = "abcd0002-0000-4000-8000-000000000002"
    seed([
      { sid: LIVE, start: 0, end: 10, title: "kept" },
      { sid: GONE, start: 20, end: 30, title: "file removed" },
    ])
    // Stale line: the file is gone and no tombstone was written.
    rmSync(join(dir, `${GONE}.jsonl`))
    const snap = readIndexSnapshot(dir)
    expect(snap.sessions.some((r) => r.sid === GONE)).toBe(true)
    // Not ambiguous: the stale line does not count.
    expect(resolveSessionsArg("abcd", snap, { dir })).toEqual({ kind: "detail", sid: LIVE })
    // A prefix of the stale line alone is a text query, not "has no saved file".
    expect(resolveSessionsArg("abcd0002", snap, { dir })).toEqual({
      kind: "query",
      query: "abcd0002",
    })
    expect(resolveSessionsArg(GONE, snap, { dir })).toEqual({ kind: "query", query: GONE })
    // The injected check is used.
    expect(resolveSessionsArg("abcd", snap, { dir, exists: () => true }).kind).toBe("ambiguous")
    // End to end: the prefix opens the detail of the live session (no exit 1).
    const prefixOut = run("abcd")
    expect(prefixOut.exitCode ?? 0).toBe(0)
    expect(prefixOut.rows.join("\n")).toContain("kept")
    expect(prefixOut.rows.join("\n")).not.toContain("sessions start with abcd")
    expect(run("abcd0002").rows.join("\n")).not.toContain("has no saved file")
  })

  test("P4c m2: last → the same rule as resume last (core resolveLastSessionSid)", () => {
    const CHILD = "beef0000-0000-4000-8000-000000000009"
    const OTHER = "0ade0000-0000-4000-8000-00000000000c"
    seed([
      ...TREE,
      { sid: CHILD, start: 1000, end: 1100, leadSid: LEAD, title: "late child" },
      { sid: OTHER, start: 1200, end: 1300, title: "other dir", cwd: "/elsewhere" },
    ])
    const snap = readIndexSnapshot(dir)
    const cwd = "/Users/x/vairix/arcana/code"
    // The newest line of this cwd wins (a sub-agent too, as in resume last).
    expect(lastSessionSid(snap, { cwd, dir })).toBe(CHILD)
    expect(resolveSessionsArg("last", snap, { cwd, dir })).toEqual({ kind: "detail", sid: CHILD })
    // No line of this cwd: the newest line.
    expect(lastSessionSid(snap, { cwd: "/nowhere", dir })).toBe(OTHER)
    // A line whose session file is gone does not count (core readSessionIndex).
    rmSync(join(dir, `${OTHER}.jsonl`))
    expect(lastSessionSid(readIndexSnapshot(dir), { cwd: "/nowhere", dir })).toBe(CHILD)
    expect(
      runSessionsEntry({
        flags: flags({ query: "last" }),
        width: 100,
        color: false,
        dir,
        cwd,
        writeSummaries: false,
        now: NOW,
        timeZone: ZONE,
        home: HOME,
      }).rows.join("\n"),
    ).toContain("late child")
  })

  test("deep children come from the index; the view hides empty ones unless --all", () => {
    seed([
      ...TREE,
      {
        sid: "dead0000-0000-4000-8000-00000000000a",
        start: 310,
        end: 310,
        leadSid: REVIEWER,
        title: "",
        turns: 0,
      },
    ])
    const snap = readIndexSnapshot(dir)
    const row = {
      sid: REVIEWER,
      createdAt: at(290),
      cwd: "/x",
      model: "m",
      summarySource: "none" as const,
      children: [],
    }
    addDeepChildren(row, snap, { dir, exists: () => true })
    expect(row.children.map((c: { sid: string }) => c.sid)).toEqual([
      EXPLORER,
      "dead0000-0000-4000-8000-00000000000a",
    ])
    expect(run("e0f2").rows.join("\n")).not.toContain("dead0000")
    expect(run("e0f2", 100, { all: true }).rows.join("\n")).toContain("dead0000")
  })

  test("P4c M2: an index-only empty child (no summary, empty file) hides in list and detail", () => {
    const EMPTY = "dead0003-0000-4000-8000-00000000000b"
    // No `end`: no summary line; the seed writes an empty session file.
    seed([...TREE, { sid: EMPTY, start: 500, leadSid: LEAD, role: "worker", agentId: "A9" }])
    // List: the core finds 0 turns and hides it.
    expect(run(undefined).rows.join("\n")).not.toContain("dead0003")
    expect(run(undefined, 100, { all: true }).rows.join("\n")).toContain("dead0003")
    // Detail: the same rule.
    expect(run("e0f2").rows.join("\n")).not.toContain("dead0003")
    expect(run("e0f2", 100, { all: true }).rows.join("\n")).toContain("dead0003")
    // The index walk alone: no summary line → not added without --all.
    const snap = readIndexSnapshot(dir)
    const bare = () => ({
      sid: LEAD,
      createdAt: at(0),
      cwd: "/x",
      model: "m",
      summarySource: "none" as const,
      children: [],
    })
    const without = addDeepChildren(bare(), snap, { dir, exists: () => true })
    expect(without.children.map((c) => c.sid)).not.toContain(EMPTY)
    const withAll = addDeepChildren(bare(), snap, { dir, all: true, exists: () => true })
    expect(withAll.children.map((c) => c.sid)).toContain(EMPTY)
  })

  test("P4b: the detail view shows all depths (a chain of 10 sub-agents)", () => {
    const chain = Array.from(
      { length: 10 },
      (_, i) => `d${String(i).padStart(7, "0")}-3333-4000-8000-000000000000`,
    )
    seed([
      { sid: LEAD, start: 0, end: 900, title: "deep lead" },
      ...chain.map((sid, i) => ({
        sid,
        start: 10 + i * 10,
        end: 800,
        leadSid: i === 0 ? LEAD : (chain[i - 1] ?? LEAD),
        role: "worker",
        agentId: `A${i + 1}`,
        title: `level ${i + 1}`,
      })),
    ])
    const text = run("e0f2", 140).rows.join("\n")
    for (const sid of chain) expect(text).toContain(sid.slice(0, 8))
    expect(text).toContain("level 10")
    // A depth-3 row has two ancestor columns before its arm.
    expect(text).toMatch(/ {3} {3}╰─ /u)
  })
})

// ---------------------------------------------------------------------------
// X3b (title SPEC §9.3, §9.4): the detail header shows the saved title
// (user, then ai, then derived) with the dim `✦` for an ai title, the first
// prompt on a dim line, and a dim `title:` meta line (source, model, usage
// and cost of the title call). No saved title: the old view (goldens above).
// ---------------------------------------------------------------------------

describe("X3b: saved titles in the detail view", () => {
  interface TitleLine {
    sid: string
    title: string
    source: "ai" | "user" | "derived"
    model?: string
    provider?: string
    usage?: { inputTokens: number; outputTokens: number; costUsd?: number }
  }
  /** Append title lines to the temp index sidecar (`index-meta.jsonl`). */
  function titles(lines: readonly TitleLine[]): void {
    const text = lines
      .map((l) => JSON.stringify({ kind: "title", v: 1, at: new Date(NOW).toISOString(), ...l }))
      .join("\n")
    writeFileSync(join(dir, "index-meta.jsonl"), `${text}\n`)
  }
  const AI_LEAD: TitleLine = {
    sid: LEAD,
    title: "Flaky checkout e2e fix",
    source: "ai",
    model: "claude-haiku-5-5",
    provider: "anthropic",
    usage: { inputTokens: 812, outputTokens: 9, costUsd: 0.0001 },
  }
  const AI_KID: TitleLine = {
    sid: WORKER,
    title: "Cart retry patch",
    source: "ai",
    model: "claude-haiku-5-5",
  }

  for (const width of [60, 100]) {
    test(`golden: ai title at width ${width}`, async () => {
      seed(TREE)
      titles([AI_LEAD, AI_KID])
      const { rows, exitCode } = run("e0f2", width)
      expect(exitCode).toBeUndefined()
      for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(width)
      const golden = await Bun.file(join(GOLDEN_DIR, `sessions-detail-titles-w${width}.txt`)).text()
      expect(`${rows.join("\n")}\n`).toBe(golden)
    })
  }

  test("ai title: ✦ mark, first prompt line, title meta line with model, usage, cost", () => {
    seed(TREE)
    titles([AI_LEAD])
    const rows = run("e0f2", 100).rows
    expect(rows[1]).toBe("  e0f2d3d3  ✦ Flaky checkout e2e fix")
    expect(rows[2]).toBe('            "fix flaky checkout e2e test"')
    expect(rows[3]).toBe(
      "            title: ai · claude-haiku-5-5 · 812 in / 9 out · $0.0001 (not in session cost)",
    )
    // The lineage and fact lines follow, unchanged.
    expect(rows[4]).toContain("zeta-model-2")
  })

  test("the ✦ mark and the extra lines are dim with color", () => {
    seed(TREE)
    titles([AI_LEAD])
    const rows = runSessionsEntry({
      flags: flags({ query: "e0f2" }),
      width: 100,
      color: true,
      dir,
      writeSummaries: false,
      now: NOW,
      timeZone: ZONE,
      home: HOME,
    }).rows
    expect(rows[1]).toContain("\u001b[2m✦ ")
    expect(rows[2]?.startsWith("            \u001b[2m")).toBe(true)
    expect(rows[3]).toContain("\u001b[2mtitle: ai")
  })

  test("user title wins over ai: no mark, meta line says user (no model or cost)", () => {
    seed(TREE)
    titles([AI_LEAD, { sid: LEAD, title: "My checkout fix", source: "user" }])
    const rows = run("e0f2", 100).rows
    expect(rows[1]).toBe("  e0f2d3d3  My checkout fix")
    expect(rows[2]).toBe('            "fix flaky checkout e2e test"')
    expect(rows[3]).toBe("            title: user")
    expect(rows.join("\n")).not.toContain("✦")
  })

  test("an empty last user line clears the user title: the ai title shows again", () => {
    seed(TREE)
    titles([
      { sid: LEAD, title: "Old name", source: "user" },
      AI_LEAD,
      { sid: LEAD, title: "", source: "user" },
    ])
    expect(run("e0f2", 100).rows[1]).toBe("  e0f2d3d3  ✦ Flaky checkout e2e fix")
  })

  test("ai title with no usage: the meta line has the source and the model only", () => {
    seed([{ sid: ALONE, start: 0, end: 60, title: "just me" }])
    titles([{ sid: ALONE, title: "Solo", source: "ai", model: "claude-haiku-5-5" }])
    const rows = run("c0ffee", 100).rows
    expect(rows[1]).toBe("  c0ffee00  ✦ Solo")
    expect(rows[3]).toBe("            title: ai · claude-haiku-5-5")
  })

  test("a title equal to the first prompt has no prompt line", () => {
    seed([{ sid: ALONE, start: 0, end: 60, title: "just me" }])
    titles([{ sid: ALONE, title: "just me", source: "user" }])
    const rows = run("c0ffee", 100).rows
    expect(rows[1]).toBe("  c0ffee00  just me")
    expect(rows[2]).toBe("            title: user")
  })

  test("no title: the header has no prompt or title line", () => {
    seed(TREE)
    const text = run("e0f2", 100).rows.join("\n")
    expect(text).not.toContain("title:")
    expect(text).not.toContain("✦")
    expect(text).not.toContain('"fix flaky')
  })

  test("sub-agent rows use the same title rule", () => {
    seed(TREE)
    titles([
      AI_KID,
      { sid: REVIEWER, title: "Race review", source: "user" },
      { sid: REVIEWER, title: "AI race review", source: "ai" },
    ])
    const rows = run("e0f2", 100).rows
    const at = (sid: string): string =>
      rows[rows.findIndex((r) => r.includes(sid.slice(0, 8))) + 1] ?? ""
    expect(at(WORKER)).toContain("✦ Cart retry patch")
    expect(at(REVIEWER)).toContain("Race review")
    expect(at(REVIEWER)).not.toContain("✦")
    expect(at(EXPLORER)).toContain("read the cart module")
  })

  test("a sub-agent sid gets its own title header", () => {
    seed(TREE)
    titles([AI_KID])
    const rows = run(WORKER.slice(0, 6), 100).rows
    expect(rows[1]).toBe("  ecb565ab  ✦ Cart retry patch")
    expect(rows[2]).toBe('            "patch retry logic in cart.ts"')
    expect(rows.join("\n")).toContain("sub-agent of e0f2d3d3")
  })

  test("an ambiguous prefix list shows the saved title with the mark", () => {
    const A = "abcd0001-1111-4000-8000-000000000001"
    const B = "abcd0002-1111-4000-8000-000000000002"
    seed([
      { sid: A, start: 0, end: 60, title: "first prompt a" },
      { sid: B, start: 100, end: 160, title: "first prompt b" },
    ])
    titles([{ sid: A, title: "AI name a", source: "ai" }])
    const text = run("abcd", 100).rows.join("\n")
    expect(text).toContain("✦ AI name a")
    expect(text).toContain("first prompt b")
    expect(text).not.toContain("first prompt a")
  })

  test("--json: the row and its children get title, titleSource, prompt", () => {
    seed(TREE)
    titles([AI_LEAD, AI_KID])
    const json = JSON.parse(run("e0f2", 100, { json: true }).rows.join("\n"))
    expect(json.row).toMatchObject({
      sid: LEAD,
      title: "Flaky checkout e2e fix",
      titleSource: "ai",
      prompt: "fix flaky checkout e2e test",
    })
    expect(json.row.summary.title).toBe("fix flaky checkout e2e test")
    expect(json.row.children[0]).toMatchObject({ sid: WORKER, titleSource: "ai" })
    expect(json.row.children[1].titleSource).toBeUndefined()
    expect(json.row.children[1].title).toBe("review the diff for races")
  })

  test("width: a long CJK ai title and prompt stay inside each width", () => {
    seed([{ sid: ALONE, start: 0, end: 60, title: "長い最初のプロンプト".repeat(12) }])
    titles([
      {
        ...AI_LEAD,
        sid: ALONE,
        title: "セッションのタイトル".repeat(8),
        model: "claude-haiku-5-5-with-a-very-long-model-id",
      },
    ])
    for (const width of [20, 30, 40, 60, 80, 100, 140]) {
      const rows = run("c0ffee", width).rows
      for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(width)
      expect(rows.join("\n")).toContain("title: ")
    }
  })

  test("lineage: a fork with an ai title keeps the ↻ resumed from line", () => {
    seed(TREE)
    titles([AI_LEAD])
    const snapshot = readIndexSnapshot(dir)
    const result = runSessionDetail({
      sid: LEAD,
      snapshot,
      width: 100,
      color: false,
      json: false,
      dir,
      writeSummaries: false,
      now: NOW,
      timeZone: ZONE,
      home: HOME,
    })
    // The fork mark comes from the session file meta; here the view gets it directly.
    expect(result.rows[1]).toContain("✦ Flaky checkout e2e fix")
    const view = buildSessionDetailView(
      {
        ...(findSessionRow(LEAD, snapshot, { dir, writeSummaries: false }) as SessionCatalogRow),
        forkOf: ALONE,
      },
      NOW,
      false,
      snapshot.titles?.get(LEAD),
    )
    const rows = renderSessionDetail(view, {
      width: 100,
      color: false,
      now: NOW,
      timeZone: ZONE,
      home: HOME,
    })
    expect(rows[1]).toBe("  e0f2d3d3  ✦ Flaky checkout e2e fix")
    expect(rows[3]).toContain("title: ai")
    expect(rows[4]).toContain("↻ resumed from c0ffee00")
  })
})
