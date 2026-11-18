/**
 * `Compositor.writeBlock` against REAL mdstream output, cut at every offset.
 *
 * mdstream echoes the raw partial line on the open row, and at the line's end
 * it rewrites that same row (`\r`, `ESC[K`, the formatted line). A block that
 * ended the open row with a newline first would move the cursor off the echo:
 * the rewrite then lands on the NEW row and the raw echo stays in scrollback
 * as a duplicate of the line. So `writeBlock` waits for the row to be final.
 *
 * The fixture is mdstream 0.3.9 output, captured through a pipe, one input
 * chunk at a time (`segments[i]` is what it wrote after `chunks[i]`). Each
 * test feeds a prefix of that stream, injects the block, feeds the rest, and
 * compares the screen with the run that has no block. Every offset counts:
 * inside the raw echo, inside an escape sequence, right after a `\r`.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { FakeTerminal } from "../test-utils/fake-terminal.ts"

import { Compositor } from "./compositor.ts"
import { findEscapeSafeSplit } from "./terminal/ansi-stream.ts"

interface Scenario {
  columns: number
  chunks: string[]
  segments: string[]
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "test-utils", "fixtures", "mdstream-segments.json"),
    "utf8",
  ),
) as { mdstream: string; scenarios: Record<string, Scenario> }

const BLOCK_ROWS = [
  "  ⚠ warn  cache.anomaly · 08:08:25",
  "  │ cache: turn 1 wrote 22106 tokens",
  "  ╰ code: no_read_after_write",
]
const BLOCK = `${BLOCK_ROWS.join("\n")}\n`
const ROWS = 30

type Inject = (c: Compositor) => void
const viaWriteBlock: Inject = (c) => c.writeBlock(BLOCK)
/** A policy that fails: end the open row, then write the block. */
const viaLineFeed: Inject = (c) => c.writeStream(`\n${BLOCK}`)
/** The policy that failed first: append the block at the stream cursor. */
const viaAppend: Inject = (c) => c.writeStream(BLOCK)
const none: Inject = () => {}

/** Feed `stream` to a fresh compositor, injecting at `cut`, and return all rows. */
function render(
  sc: Scenario,
  stream: string,
  opts: { cut: number; liveArea: boolean; inject: Inject },
): string[] {
  const term = new FakeTerminal({ cols: sc.columns, rows: ROWS, scrollbackLimit: 200 })
  const c = new Compositor({
    output: {
      isTTY: true,
      columns: sc.columns,
      rows: ROWS,
      write: (s: string) => {
        term.feed(s)
        return true
      },
    },
  })
  c.mount()
  if (opts.liveArea) c.setLiveArea(["❯ "], { row: 0, col: 2 })
  c.writeStream(stream.slice(0, opts.cut))
  opts.inject(c)
  c.writeStream(stream.slice(opts.cut))
  c.flushStream() // the end of the turn
  return [...term.scrollback, ...term.screen()]
}

const trimEnd = (rows: string[]): string[] => {
  const out = [...rows]
  while (out.length > 0 && (out[out.length - 1] ?? "").trim() === "") out.pop()
  return out
}

/**
 * Why `rows` differ from `golden` once the block is taken out, or `null` when
 * they do not. `ignoreBlankRows` compares the text rows only: after a turn
 * that ends mid-row, the closing newline may add or drop a blank row.
 */
function verdict(
  rows: string[],
  golden: string[],
  hasBlock: boolean,
  ignoreBlankRows = false,
): string | null {
  let rest = rows
  if (hasBlock) {
    const heads = rows.flatMap((r, i) => (r === BLOCK_ROWS[0] ? [i] : []))
    if (heads.length !== 1) return `the block head appears ${heads.length} times`
    const at = heads[0] as number
    if (rows[at + 1] !== BLOCK_ROWS[1] || rows[at + 2] !== BLOCK_ROWS[2])
      return "the block is not in one piece"
    rest = [...rows.slice(0, at), ...rows.slice(at + BLOCK_ROWS.length)]
  }
  const got = ignoreBlankRows ? rest.filter((r) => r.trim() !== "") : trimEnd(rest)
  const want = ignoreBlankRows ? golden.filter((r) => r.trim() !== "") : trimEnd(golden)
  if (got.join("\n") === want.join("\n")) return null
  const extra = got.filter((r) => !want.includes(r))
  const lost = want.filter((r) => !got.includes(r))
  if (extra.length > 0) return `extra rows ${JSON.stringify(extra)}`
  if (lost.length > 0) return `lost rows ${JSON.stringify(lost)}`
  return got.length > want.length ? "an extra repeated row" : "a missing repeated row"
}

/** Every cut of every scenario that renders wrongly. Empty when the policy is safe. */
function sweep(inject: Inject, opts: { liveArea: boolean; only?: string }): string[] {
  const bad: string[] = []
  for (const [name, sc] of Object.entries(fixture.scenarios)) {
    if (opts.only !== undefined && name !== opts.only) continue
    const stream = sc.segments.join("")
    const golden = render(sc, stream, { cut: stream.length, liveArea: opts.liveArea, inject: none })
    for (let cut = 0; cut <= stream.length; cut++) {
      const rows = render(sc, stream, { cut, liveArea: opts.liveArea, inject })
      const why = verdict(rows, golden, inject !== none)
      if (why !== null) {
        const before = JSON.stringify(stream.slice(Math.max(0, cut - 14), cut))
        bad.push(`${name} cut=${cut} after ${before}: ${why}`)
      }
    }
  }
  return bad
}

/**
 * True when a stream that stops after `prefix` is a state a turn can end in.
 * Two prefixes are not, and an ordinary `writeStream` after them misbehaves too
 * (checked without any block): one that ends inside an escape sequence, which the
 * terminal would swallow the next bytes into, and one that ends on a bare `\r`,
 * where the formatter has erased its echo row and is about to rewrite it (the
 * next write wipes that row). mdstream finishes its rewrite before it exits, so
 * the REPL never ends a turn there.
 */
function isReachableEnd(prefix: string): boolean {
  if (findEscapeSafeSplit(prefix) !== prefix.length) return false
  return !/\r(?:\x1b\[[0-9;?]*[A-Za-z])*$/.test(prefix)
}

/**
 * Every reachable truncation of every stream: the turn ends (or is aborted)
 * with the row open, so the block can only be written by the end-of-turn flush.
 */
function sweepTruncated(opts: { liveArea: boolean }): string[] {
  const bad: string[] = []
  let checked = 0
  for (const [name, sc] of Object.entries(fixture.scenarios)) {
    const full = sc.segments.join("")
    for (let end = 0; end <= full.length; end++) {
      const stream = full.slice(0, end)
      if (!isReachableEnd(stream)) continue
      checked++
      const golden = render(sc, stream, {
        cut: stream.length,
        liveArea: opts.liveArea,
        inject: none,
      })
      // The block arrives after the whole truncated stream was written, row still open.
      const rows = render(sc, stream, {
        cut: stream.length,
        liveArea: opts.liveArea,
        inject: viaWriteBlock,
      })
      const why = verdict(rows, golden, true, true)
      if (why !== null) bad.push(`${name} truncated at ${end}: ${why}`)
    }
  }
  // The filter must leave most of the stream: a filter that skips everything proves nothing.
  if (checked < 400) bad.push(`only ${checked} truncations were checked`)
  return bad
}

describe(`Compositor.writeBlock with real ${fixture.mdstream} output`, () => {
  it("the fixture holds the cases that matter: a rewritten row, a clipped echo, a soft break", () => {
    const names = Object.keys(fixture.scenarios)
    expect(names).toEqual(["plain", "markup", "soft", "list", "fence", "clip"])
    // A rewrite is `\r` + `ESC[K`: the whole reason the block must not end the row.
    expect(fixture.scenarios.markup?.segments.join("")).toContain("\r\x1b[K")
    expect(fixture.scenarios.clip?.segments.join("")).toContain("…")
  })

  it("control: splitting the stream at any offset, with no block, changes nothing", () => {
    expect(sweep(none, { liveArea: true })).toEqual([])
    expect(sweep(none, { liveArea: false })).toEqual([])
  })

  it("never corrupts a row, at any offset, with a live area", () => {
    expect(sweep(viaWriteBlock, { liveArea: true })).toEqual([])
  })

  it("never corrupts a row, at any offset, without a live area", () => {
    expect(sweep(viaWriteBlock, { liveArea: false })).toEqual([])
  })

  it("a turn that ends with the row open still shows the block, in one piece (every truncation)", () => {
    expect(sweepTruncated({ liveArea: true })).toEqual([])
    expect(sweepTruncated({ liveArea: false })).toEqual([])
  })

  it("negative control: appending the block to the open row (the reported bug) is seen", () => {
    const bad = sweep(viaAppend, { liveArea: true, only: "plain" })
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.some((b) => b.includes("the block head appears 0 times"))).toBe(true)
  })

  it("negative control: ending the row first leaves a raw echo behind, and the sweep sees it", () => {
    // This is the reason writeBlock waits. If this test ever passes with an empty
    // list, the sweep stopped seeing the failure it exists to catch.
    const bad = sweep(viaLineFeed, { liveArea: true, only: "markup" })
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.some((b) => b.includes("extra"))).toBe(true)
  })
})
