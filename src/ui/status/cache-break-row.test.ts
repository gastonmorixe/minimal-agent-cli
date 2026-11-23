import { describe, expect, test } from "bun:test"
import { EventBus } from "@minimal-agent/core/host/event-bus"
import { CACHE_DID_BREAK, type CacheBreakPayload } from "@minimal-agent/core/plugin-api"
import { displayWidth, stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"
import { PALETTE } from "../../terminal-kit/palette.ts"
import {
  attachCacheBreakRows,
  formatCacheBreakRow,
  formatDuration,
  formatTokens,
  parseCacheBreakPayload,
} from "./cache-break-row.ts"
import { formatScrollbackTs } from "./scrollback.ts"

const AT = new Date(2026, 10, 18, 16, 49, 36).getTime()

/** The real case: an expected expiry after an hour idle, turn 5. */
function ttlExpired(over: Partial<CacheBreakPayload> = {}): CacheBreakPayload {
  return {
    v: 1,
    sessionId: "s1",
    model: "claude-opus",
    origin: "https://api.anthropic.com",
    turn: 5,
    prevTurn: 4,
    expectedRead: 48213,
    read: 0,
    written: 49000,
    lost: 48213,
    gapSec: 3793,
    ttlSec: 300,
    idle: true,
    cause: "ttl_expired",
    streak: 1,
    streakLost: 48213,
    actionable: false,
    message: "cache expired",
    at: AT,
    ...over,
  }
}

const plain = (p: CacheBreakPayload, columns?: number): string =>
  stripAnsi(formatCacheBreakRow(p, columns !== undefined ? { columns } : {}))

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe("formatCacheBreakRow", () => {
  test("ttl_expired: the real case", () => {
    const row = formatCacheBreakRow(ttlExpired())
    expect(stripAnsi(row)).toBe(
      `  ◇ cache rewrote 48,213 tok · ttl expired · idle 63 min > 5 min TTL · turn 5 · ${formatScrollbackTs(AT)}`,
    )
    // The warning color (gold), as the scrollback sink. Never sky.
    expect(row).toContain(`${PALETTE.gold}◇`)
    expect(row).toContain(`${PALETTE.gold}cache`)
    expect(row).not.toContain(PALETTE.sky)
    expect(row).not.toContain("\n")
  })

  test("an expected row and an actionable row have the same warning color", () => {
    const expected = formatCacheBreakRow(ttlExpired())
    const actionable = formatCacheBreakRow(
      ttlExpired({ cause: "server_miss", idle: false, actionable: true }),
    )
    for (const row of [expected, actionable]) {
      expect(row).toContain(`${PALETTE.gold}cache`)
      expect(row).not.toContain(PALETTE.sky)
      expect(row).not.toContain(PALETTE.cyan)
    }
    // Only the glyph tells the two kinds apart.
    expect(stripAnsi(expected)).toContain("◇ cache")
    expect(stripAnsi(actionable)).toContain("◆ cache")
  })

  test("prefix_changed: names the changed part, and idle", () => {
    const row = formatCacheBreakRow(
      ttlExpired({ cause: "prefix_changed", changed: "tools", actionable: true, lost: 30000 }),
    )
    expect(stripAnsi(row)).toBe(
      `  ◆ cache rewrote 30,000 tok · tools changed · idle 63 min > 5 min TTL · turn 5 · ${formatScrollbackTs(AT)}`,
    )
    expect(row).toContain(PALETTE.gold)
  })

  test("prefix_changed: a message index", () => {
    const p = ttlExpired({
      cause: "prefix_changed",
      changed: "message",
      changedIndex: 12,
      idle: false,
      gapSec: 20,
      actionable: true,
    })
    expect(plain(p)).toContain("· message #12 changed · turn 5 ·")
    expect(plain(p)).not.toContain("idle")
  })

  test("server_miss: appends the request id", () => {
    const p = ttlExpired({
      cause: "server_miss",
      idle: false,
      gapSec: 40,
      actionable: true,
      requestId: "req_011C000000000000000000000",
    })
    expect(plain(p)).toBe(
      `  ◆ cache rewrote 48,213 tok · likely server miss · gap 40 s < 5 min TTL · turn 5 · req req_011C000000000000000000000 · ${formatScrollbackTs(AT)}`,
    )
  })

  test("streak suffix when streak > 1", () => {
    const p = ttlExpired({
      cause: "prefix_changed",
      changed: "system",
      idle: false,
      actionable: true,
      streak: 3,
      streakLost: 120500,
    })
    expect(plain(p)).toContain("· turn 5 · 3 in a row, 120,500 tok ·")
    expect(plain(ttlExpired())).not.toContain("in a row")
  })

  test("lost 0 still renders a row", () => {
    expect(plain(ttlExpired({ lost: 0 }))).toContain("rewrote 0 tok")
  })

  test("stays under the terminal width, keeps the timestamp", () => {
    const p = ttlExpired({
      cause: "server_miss",
      idle: false,
      actionable: true,
      requestId: "req_x".repeat(20),
    })
    const row = formatCacheBreakRow(p, { columns: 60 })
    expect(displayWidth(row)).toBeLessThan(60)
    expect(stripAnsi(row)).toContain("…")
    expect(stripAnsi(row).endsWith(formatScrollbackTs(AT))).toBe(true)
  })

  test("uses now when the payload has no at", () => {
    const { at: _at, ...rest } = ttlExpired()
    const now = new Date(2026, 0, 1, 9, 8, 7).getTime()
    expect(stripAnsi(formatCacheBreakRow(rest as CacheBreakPayload, { now }))).toEndWith(
      "· 09:08:07",
    )
  })
})

describe("helpers", () => {
  test("formatTokens groups digits", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(999)).toBe("999")
    expect(formatTokens(48213)).toBe("48,213")
    expect(formatTokens(1234567)).toBe("1,234,567")
  })

  test("formatDuration", () => {
    expect(formatDuration(40)).toBe("40 s")
    expect(formatDuration(300)).toBe("5 min")
    expect(formatDuration(3793)).toBe("63 min")
    expect(formatDuration(3600 * 5)).toBe("5 h")
    expect(formatDuration(3600 * 2.5)).toBe("2.5 h")
  })
})

describe("parseCacheBreakPayload", () => {
  test("accepts a v1 payload", () => {
    expect(parseCacheBreakPayload(ttlExpired())).not.toBeNull()
  })

  const bad: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "cache broke"],
    ["v 2", { ...ttlExpired(), v: 2 }],
    ["no lost", { ...ttlExpired(), lost: undefined }],
    ["no read", { ...ttlExpired(), read: undefined }],
    ["written a string", { ...ttlExpired(), written: "49000" }],
    ["no expectedRead", { ...ttlExpired(), expectedRead: undefined }],
    ["no message", { ...ttlExpired(), message: undefined }],
    ["lost as text", { ...ttlExpired(), lost: "48213" }],
    ["NaN turn", { ...ttlExpired(), turn: Number.NaN }],
    ["no streak", { ...ttlExpired(), streak: undefined }],
    ["unknown cause", { ...ttlExpired(), cause: "gremlins" }],
    ["actionable missing", { ...ttlExpired(), actionable: undefined }],
  ]
  for (const [name, raw] of bad) {
    test(`rejects ${name}`, () => {
      expect(parseCacheBreakPayload(raw)).toBeNull()
    })
  }
})

describe("attachCacheBreakRows", () => {
  test("subscribes on a real EventBus, writes one row per break, and unsubscribes", async () => {
    const bus = new EventBus(() => {})
    const out: string[] = []
    const dispose = attachCacheBreakRows(bus, (t) => out.push(t))

    bus.emit(CACHE_DID_BREAK, ttlExpired())
    bus.emit(CACHE_DID_BREAK, ttlExpired({ turn: 6 }))
    await flush()
    expect(out).toHaveLength(2)
    expect(out[0]?.endsWith("\n")).toBe(true)
    expect(stripAnsi(out[1] ?? "")).toContain("turn 6")

    dispose()
    dispose() // idempotent
    bus.emit(CACHE_DID_BREAK, ttlExpired())
    await flush()
    expect(out).toHaveLength(2)
    bus.dispose()
  })

  test("ignores a malformed payload", async () => {
    const bus = new EventBus(() => {})
    const out: string[] = []
    const dispose = attachCacheBreakRows(bus, (t) => out.push(t))
    bus.emit(CACHE_DID_BREAK, { v: 1, turn: "five" })
    bus.emit(CACHE_DID_BREAK, undefined)
    await flush()
    expect(out).toHaveLength(0)
    dispose()
    bus.dispose()
  })

  test("passes the live width", async () => {
    const bus = new EventBus(() => {})
    const out: string[] = []
    const dispose = attachCacheBreakRows(bus, (t) => out.push(t), { columns: () => 40 })
    bus.emit(CACHE_DID_BREAK, ttlExpired())
    await flush()
    expect(displayWidth((out[0] ?? "").trimEnd())).toBeLessThan(40)
    dispose()
    bus.dispose()
  })
})

describe("no direct process writes", () => {
  test("a break row goes only to the injected writer, never to stdout or stderr", async () => {
    const realOut = process.stdout.write
    const realErr = process.stderr.write
    let direct = 0
    const spy = ((..._args: unknown[]) => {
      direct++
      return true
    }) as typeof process.stdout.write
    process.stdout.write = spy
    process.stderr.write = spy
    const bus = new EventBus(() => {})
    const out: string[] = []
    try {
      const dispose = attachCacheBreakRows(bus, (t) => out.push(t), { columns: () => 80 })
      bus.emit(CACHE_DID_BREAK, ttlExpired())
      bus.emit(CACHE_DID_BREAK, { v: 1, turn: "bad" })
      await flush()
      dispose()
    } finally {
      process.stdout.write = realOut
      process.stderr.write = realErr
      bus.dispose()
    }
    expect(out).toHaveLength(1)
    expect(direct).toBe(0)
  })
})

describe("narrow terminal", () => {
  test("a row is never wider than the terminal, also when the head and time do not fit", () => {
    for (const columns of [4, 8, 12, 16, 20, 30]) {
      const row = formatCacheBreakRow(ttlExpired(), { columns })
      expect(displayWidth(row)).toBeLessThan(columns)
    }
  })
})

describe("session label", () => {
  const own = "2012ba5a-0000-4000-8000-28c291e797e3"
  test("a break of this session has no label", () => {
    const row = stripAnsi(
      formatCacheBreakRow({ ...ttlExpired(), sessionId: own }, { ownSessionId: own }),
    )
    expect(row).not.toContain("session ")
  })
  test("a break of another session names it", () => {
    const row = stripAnsi(
      formatCacheBreakRow(
        { ...ttlExpired(), sessionId: "8f2f6f8c-a00b-43f8" },
        { ownSessionId: own },
      ),
    )
    expect(row).toContain("· session 8f2f6f8c ·")
  })
  test("no own id: no label", () => {
    const row = stripAnsi(formatCacheBreakRow({ ...ttlExpired(), sessionId: "8f2f6f8c-a00b" }))
    expect(row).not.toContain("session ")
  })
})
