/**
 * Per-frame micro-benchmark (design step 13): `findAnnotationStart` reads
 * the trailing annotation run with the sideband codec. On a 112 KB body it
 * must not be slower than 3 times the old loop (one `lastIndexOf` for each
 * old prefix, the code before step 13). The old prefixes are built from
 * parts, so the sideband literal guard does not count them.
 *
 * A timing test is not stable on a shared runner: it skips on CI, and when
 * the sibling codec is missing.
 *
 * @module ui/tool-transcript/format.annotation-perf.test
 */

import { describe, expect, it } from "bun:test"

import { sidebandFixturePresent, testSideband } from "../../test-utils/sideband-fixture.ts"
import { findAnnotationStart } from "./format.ts"

const NL2 = "\n\n"
/** The old cut prefixes (format.ts before step 13), made from parts. */
const OLD_PREFIXES = [
  ...["truncated", "note"].map((k) => [NL2, "[", k, ":"].join("")),
  ...["output-preview", "diagnostics", "mode-active"].map((k) =>
    [NL2, "<", "ma::agent", "::", k].join(""),
  ),
]

/** The old per-frame cut: the earliest of the last match of each prefix. */
function oldFindAnnotationStart(content: string): number {
  let earliest = -1
  for (const p of OLD_PREFIXES) {
    const i = content.lastIndexOf(p)
    if (i >= 0 && (earliest < 0 || i < earliest)) earliest = i
  }
  return earliest
}

/** A 112 KB body of log lines, then one output-preview annotation. */
function bigContent(): { content: string; bodyLength: number } {
  const line = `${"x".repeat(100)} log line\n`
  const body = line.repeat(Math.ceil((112 * 1024) / line.length)).slice(0, 112 * 1024)
  const note = testSideband.render("output-preview", {
    attrs: { shown: "10", total: "1100", tool: "Bash" },
    body: "the user saw only a part of this output.",
  })
  return { content: `${body}${NL2}${note}`, bodyLength: body.length }
}

/** The median time in ms of `rounds` runs of `fn` (each run is `inner` calls). */
function medianMs(fn: () => void, rounds = 15, inner = 50): number {
  const times: number[] = []
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now()
    for (let i = 0; i < inner; i++) fn()
    times.push((performance.now() - t0) / inner)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(times.length / 2)] ?? 0
}

const SKIP = Boolean(process.env.CI) || !sidebandFixturePresent()

describe.skipIf(SKIP)("findAnnotationStart per-frame cost (112 KB body)", () => {
  it("finds the same cut as the old loop, and is not slower than 3x", () => {
    const { content, bodyLength } = bigContent()
    expect(content.length).toBeGreaterThan(112 * 1024)
    expect(findAnnotationStart(content, testSideband)).toBe(bodyLength)
    expect(oldFindAnnotationStart(content)).toBe(bodyLength)
    // Warm up the JIT for the two paths.
    medianMs(() => findAnnotationStart(content, testSideband), 3)
    medianMs(() => oldFindAnnotationStart(content), 3)
    const codec = medianMs(() => findAnnotationStart(content, testSideband))
    const old = medianMs(() => oldFindAnnotationStart(content))
    // A floor of 0.05 ms: the old loop can be too fast to measure well.
    const budget = Math.max(old * 3, 0.05)
    expect({ codecMs: codec, withinBudget: codec <= budget }).toEqual({
      codecMs: codec,
      withinBudget: true,
    })
    console.log(
      `[perf] findAnnotationStart 112KB: codec ${codec.toFixed(4)} ms, old ${old.toFixed(4)} ms, ratio ${(codec / Math.max(old, 1e-6)).toFixed(2)}`,
    )
  })
})
