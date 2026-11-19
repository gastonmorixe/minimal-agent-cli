/**
 * `sessions --backfill-lineage [--dry-run]`, inferred children in the list,
 * `lineageSource` in `--json`, and the fork mark. Temp dirs only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseSessionsFlags, runSessionsCommand, type SessionsFlags } from "./sessions.ts"
import { runSessionsEntry } from "./sessions-detail.ts"

let guardHome: string
const savedHome = process.env.MINIMAL_AGENT_HOME
beforeAll(() => {
  guardHome = mkdtempSync(join(tmpdir(), "ma-cli-lineage-home-"))
  process.env.MINIMAL_AGENT_HOME = guardHome
})
afterAll(() => {
  if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = savedHome
  rmSync(guardHome, { recursive: true, force: true })
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-cli-lineage-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const NOW = Date.UTC(2026, 10, 19, 12, 0)
const LEAD = "aaaaaaaa-0000-4000-8000-000000000001"
const KID = "bbbbbbbb-0000-4000-8000-000000000001"
const FORK = "cccccccc-0000-4000-8000-000000000001"

function t(min: number): string {
  return new Date(Date.UTC(2026, 10, 18, 12, min)).toISOString()
}

function file(
  sid: string,
  min: number,
  pid: number,
  ppid: number,
  extra: { body?: string[]; parentSid?: string } = {},
): string {
  const recs = [
    {
      kind: "meta",
      formatVersion: 1,
      sid,
      createdAt: t(min),
      model: "claude-opus-5-5",
      cwd: "/p",
      systemHash: "",
      toolsHash: "",
      agentVersion: "t",
      ...(extra.parentSid ? { parentSid: extra.parentSid, forkedAt: t(min) } : {}),
    },
    {
      kind: "attach",
      ts: t(min),
      pid,
      ppid,
      startTime: t(min),
      hostname: "h",
      agentVersion: "t",
    },
    { kind: "user", ts: t(min), content: [{ type: "text", text: `task ${sid.slice(0, 4)}` }] },
  ].map((r) => JSON.stringify(r))
  recs.push(...(extra.body ?? []))
  recs.push(JSON.stringify({ kind: "detach", ts: t(min + 30), pid, reason: "exit", exitCode: 0 }))
  return `${recs.join("\n")}\n`
}

function seed(): void {
  const spawn = JSON.stringify({
    kind: "tool_result",
    ts: t(1),
    content: [
      {
        type: "text",
        text: `Spawned sub-agent A1 (worker · m · fresh), running in background as session ${KID}. It works.`,
      },
    ],
  })
  writeFileSync(join(dir, `${LEAD}.jsonl`), file(LEAD, 0, 100, 1, { body: [spawn] }))
  writeFileSync(join(dir, `${KID}.jsonl`), file(KID, 1, 200, 100))
  writeFileSync(join(dir, `${FORK}.jsonl`), file(FORK, 40, 300, 1, { parentSid: LEAD }))
  const index = [
    { sid: LEAD, createdAt: t(0), cwd: "/p", model: "claude-opus-5-5", argv: ["bun", "ma"] },
    {
      sid: KID,
      createdAt: t(1),
      cwd: "/p",
      model: "claude-opus-5-5",
      argv: ["bun", "ma", "--session-id", KID, "--output-format", "stream-json", "--prompt", "x"],
    },
    { sid: FORK, createdAt: t(40), cwd: "/p", model: "claude-opus-5-5", argv: ["bun", "ma"] },
  ]
  writeFileSync(join(dir, "index.jsonl"), `${index.map((r) => JSON.stringify(r)).join("\n")}\n`)
}

function flags(args: string[]): SessionsFlags {
  const read = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i === -1 ? undefined : args[i + 1]
  }
  const parsed = parseSessionsFlags({ args, readFlagValue: read, cwd: "/p", now: NOW })
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.flags
}

const plain = (rows: string[]): string => rows.join("\n")

describe("sessions --backfill-lineage", () => {
  test("parses the flags", () => {
    expect(flags(["--backfill-lineage", "--dry-run"])).toMatchObject({
      backfillLineage: true,
      dryRun: true,
    })
    expect(flags([]).backfillLineage).toBeUndefined()
  })

  test("--dry-run prints the counts and writes nothing; then a real run links", () => {
    seed()
    const metaPath = join(dir, "index-meta.jsonl")
    const dry = runSessionsEntry({
      flags: flags(["--backfill-lineage", "--dry-run"]),
      width: 100,
      color: false,
      dir,
      writeSummaries: false,
    })
    const text = plain(dry.rows)
    expect(text).toContain("dry run, nothing written")
    expect(text).toMatch(/candidates\s+1/)
    expect(text).toMatch(/linked \(transcript\)\s+1/)
    expect(text).toMatch(/linked \(ppid\)\s+0/)
    expect(text).toMatch(/ambiguous\s+0/)
    expect(text).toMatch(/unknown\s+0/)
    expect(existsSync(metaPath)).toBe(false)

    const json = runSessionsEntry({
      flags: flags(["--backfill-lineage", "--dry-run", "--json"]),
      width: 100,
      color: false,
      dir,
    })
    const parsed = JSON.parse(json.rows[0] ?? "{}") as Record<string, unknown>
    expect(parsed).toMatchObject({ version: 1, dryRun: true, candidates: 1, written: 0 })

    const real = runSessionsEntry({
      flags: flags(["--backfill-lineage"]),
      width: 100,
      color: false,
      dir,
    })
    expect(plain(real.rows)).toMatch(/written\s+1/)
    expect(readFileSync(metaPath, "utf8")).toContain('"kind":"lineage"')
  })

  test("inferred children show like recorded children; --json has lineageSource", () => {
    seed()
    runSessionsEntry({ flags: flags(["--backfill-lineage"]), width: 100, color: false, dir })
    const list = runSessionsCommand({
      flags: flags([]),
      width: 120,
      color: false,
      dir,
      writeSummaries: false,
      now: NOW,
      timeZone: "UTC",
    })
    const text = plain(list.rows)
    const kidLine = text.split("\n").find((l) => l.includes(KID.slice(0, 8)))
    expect(kidLine).toContain("A1 worker")
    expect(kidLine).toMatch(/[╰├]/u)

    const json = runSessionsCommand({
      flags: flags(["--json"]),
      width: 120,
      color: false,
      dir,
      writeSummaries: false,
      now: NOW,
    })
    const out = JSON.parse(json.rows[0] ?? "{}") as {
      rows: {
        sid: string
        lineageSource?: string
        forkOf?: string
        children: { sid: string; lineageSource?: string }[]
      }[]
    }
    const lead = out.rows.find((r) => r.sid === LEAD)
    expect(lead?.lineageSource).toBeUndefined()
    expect(lead?.children[0]).toMatchObject({ sid: KID, lineageSource: "transcript" })
    // A fork is a top-level row with forkOf, not a child.
    const fork = out.rows.find((r) => r.sid === FORK)
    expect(fork?.forkOf).toBe(LEAD)
    expect(lead?.children.some((c) => c.sid === FORK)).toBe(false)
  })

  test("the list marks a fork with ↻ before the prompt", () => {
    seed()
    const list = runSessionsCommand({
      flags: flags([]),
      width: 120,
      color: false,
      dir,
      writeSummaries: false,
      now: NOW,
      timeZone: "UTC",
    })
    const lines = plain(list.rows).split("\n")
    const forkLine = lines.find((l) => l.includes(FORK.slice(0, 8)))
    const leadLine = lines.find((l) => l.includes(LEAD.slice(0, 8)))
    expect(forkLine).toContain("↻ task")
    expect(leadLine).not.toContain("↻")
  })

  test("the detail header of a fork says resumed from <sid8>", () => {
    seed()
    const out = runSessionsEntry({
      flags: { ...flags([]), query: FORK },
      width: 120,
      color: false,
      dir,
      writeSummaries: false,
      now: NOW,
      timeZone: "UTC",
    })
    expect(plain(out.rows)).toContain(`resumed from ${LEAD.slice(0, 8)}`)
    const lead = runSessionsEntry({
      flags: { ...flags([]), query: LEAD },
      width: 120,
      color: false,
      dir,
      writeSummaries: false,
      now: NOW,
      timeZone: "UTC",
    })
    expect(plain(lead.rows)).not.toContain("resumed from")
  })
})
