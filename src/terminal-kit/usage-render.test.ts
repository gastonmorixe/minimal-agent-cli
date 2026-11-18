import { describe, expect, it } from "bun:test"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"
import type { UsageReport, UsageTotals } from "@minimal-agent/core/plugin-api/utils/usage-report"

import {
  fmtTokens,
  fmtUSD,
  periodLabel,
  renderUsageOverlay,
  renderUsageReport,
} from "./usage-render.ts"

function totals(over: Partial<UsageTotals> = {}): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    tokens: 0,
    costUSD: 0,
    turns: 0,
    estimatedTurns: 0,
    ...over,
  }
}

function report(over: Partial<UsageReport> = {}): UsageReport {
  return {
    period: "all",
    startMs: 0,
    nowMs: Date.now(),
    totals: totals(),
    byProvider: [],
    byModel: [],
    estimated: false,
    ...over,
  }
}

describe("fmtTokens", () => {
  it("formats with k / M / B and drops trailing .0", () => {
    expect(fmtTokens(0)).toBe("0")
    expect(fmtTokens(999)).toBe("999")
    expect(fmtTokens(1000)).toBe("1k")
    expect(fmtTokens(12_300)).toBe("12.3k")
    expect(fmtTokens(1_000_000)).toBe("1M")
    expect(fmtTokens(2_500_000_000)).toBe("2.5B")
  })

  it("uses a sentinel for negatives", () => {
    expect(fmtTokens(-1)).toBe("—")
  })
})

describe("fmtUSD", () => {
  it("formats dollars, sub-cent, and k", () => {
    expect(fmtUSD(0)).toBe("$0.00")
    expect(fmtUSD(0.004)).toBe("<$0.01")
    expect(fmtUSD(1.235)).toBe("$1.24")
    expect(fmtUSD(1500)).toBe("$1.5k")
  })
})

describe("periodLabel", () => {
  it("maps ids to labels", () => {
    expect(periodLabel("today")).toBe("Today")
    expect(periodLabel("all")).toBe("All time")
  })
})

describe("renderUsageReport", () => {
  it("renders an empty period without throwing", () => {
    const lines = renderUsageReport(report({ period: "today" }))
    const text = stripAnsi(lines.join("\n"))
    expect(text).toContain("Token usage — Today")
    expect(text).toContain("no usage recorded in this period")
  })

  it("renders totals + provider + model sections with [R] for real usage", () => {
    const r = report({
      totals: totals({
        input: 100,
        output: 50,
        tokens: 150,
        costUSD: 1.5,
        turns: 2,
        estimatedTurns: 0,
      }),
      byProvider: [{ key: "anthropic", totals: totals({ tokens: 150, costUSD: 1.5, turns: 2 }) }],
      byModel: [
        { key: "claude-opus-4-8", totals: totals({ tokens: 150, costUSD: 1.5, turns: 2 }) },
      ],
    })
    const text = stripAnsi(
      renderUsageReport(r, {
        cols: 80,
        modelLabel: (modelId) => (modelId === "claude-opus-4-8" ? "anth-4.8" : modelId),
      }).join("\n"),
    )
    expect(text).toContain("Total")
    expect(text).toContain("[R]")
    expect(text).toContain("By provider")
    expect(text).toContain("anthropic")
    expect(text).toContain("By model")
    expect(text).toContain("anth-4.8")
    expect(text).toContain("$1.50")
  })

  it("marks a fully-estimated period [E] and hides the billed split", () => {
    const r = report({
      estimated: true,
      totals: totals({ tokens: 4000, turns: 3, estimatedTurns: 3 }),
      byModel: [
        { key: "claude-opus-4-8", totals: totals({ tokens: 4000, turns: 3, estimatedTurns: 3 }) },
      ],
    })
    const text = stripAnsi(renderUsageReport(r).join("\n"))
    expect(text).toContain("[E]")
    expect(text).toContain("estimated from transcript")
  })
})

describe("renderUsageOverlay", () => {
  it("includes a period tab strip with the active period bracketed", () => {
    const r = report({ period: "ytd", totals: totals({ tokens: 100, turns: 1 }) })
    const text = stripAnsi(renderUsageOverlay(r, { cols: 80 }).join("\n"))
    expect(text).toContain("[YTD]")
    expect(text).toContain("Today")
    expect(text).toContain("period")
    expect(text).toContain("close")
  })

  it("caps model rows at maxRows and shows an overflow note", () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({
      key: `m${i}`,
      totals: totals({ tokens: 100 - i, turns: 1 }),
    }))
    const r = report({ byModel: rows, totals: totals({ tokens: 1000, turns: 9 }) })
    const text = stripAnsi(renderUsageOverlay(r, { cols: 80, maxRows: 6 }).join("\n"))
    expect(text).toContain("+3 more model")
  })
})

describe("renderUsageReport alignment", () => {
  it("aligns bars and number columns across both sections, even with long labels", () => {
    const row = (key: string, tokens: number, costUSD: number, est = 0) => ({
      key,
      totals: totals({ tokens, costUSD, turns: 10, estimatedTurns: est }),
    })
    const r = report({
      totals: totals({ tokens: 100, turns: 10 }),
      byProvider: [
        row("anthropic", 41_300_000_000, 27_900),
        row("generic-endpoint", 126_200_000, 0, 3),
        row("wafer", 39_300_000, 7.6),
      ],
      byModel: [
        row("og-muse-spark-1.3-contributor", 6_100_000_000, 368.47),
        row("oz-claude-opus-5-5", 25_200_000_000, 14_800, 2),
        row("cur-cursor-auto", 7_900_000_000, 0, 1),
      ],
    })
    const lines = renderUsageReport(r, { cols: 111 }).map(stripAnsi)
    const rows = lines.filter((l) => /[█░▏▎▍▌▋▊▉]/.test(l))
    expect(rows).toHaveLength(6)
    const barStart = (l: string) => l.search(/[█░▏▎▍▌▋▊▉]/)
    const tokEnd = (l: string) => l.search(/[█░▏▎▍▌▋▊▉][^█░▏▎▍▌▋▊▉]*$/) // last bar cell
    expect(new Set(rows.map(barStart)).size).toBe(1)
    expect(new Set(rows.map(tokEnd)).size).toBe(1)
    // cost column starts at the same offset whenever present
    const costCols = rows.filter((l) => l.includes("$")).map((l) => l.indexOf("$"))
    expect(new Set(costCols).size).toBe(1)
    // the [~] marker lines up whether or not the row has a cost
    const markCols = rows.filter((l) => l.includes("[~]")).map((l) => l.indexOf("[~]"))
    expect(new Set(markCols).size).toBe(1)
  })
})
