/**
 * Real-PTY integration test: stacked paste ghost frames (Aug 21 2026 bug).
 *
 * Root cause under test: the controller/renderer wrapped content at
 * `output.columns` while the compositor's erase walk-up re-measured at its
 * own `effectiveColumns()` (which falls back to `$COLUMNS`). Under PTY
 * wrappers that propagate a broken WINSZ (asciinema, script(1), some tmux
 * chains) the two disagree; every repaint of a large multi-chunk paste then
 * lands the erase on the wrong physical row and commits whole previous
 * frames into scrollback as stacked duplicate frames.
 *
 * This test spawns the real driver inside a REAL pseudo-terminal via
 * `Bun.Terminal` (Bun 1.3.5 or later) with COLUMNS deliberately disagreeing
 * with the PTY width — the exact recorded-session scenario — then replays
 * the compositor's byte stream through FakeTerminal and asserts no previous
 * live-area frame leaked into scrollback. The ghost signature of this bug
 * is DUPLICATED FRAME CONTENT in scrollback: the prompt row and first
 * pasted content row reappear once per committed stale frame.
 *
 * Since the whole-paste assembly (paste plugin v3, D1) the editor paints the
 * paste ONE time, at the end marker; mid-paste it only paints a "pasting N
 * kB" status row through the trailing coalesce.
 *
 * I4: a Ghostty-style blank paste and a Ctrl+V with no clipboard text still
 * give an `[Image #` token through the media hook defer. The driver injects
 * the image reader, so the user clipboard is never read or changed (J4).
 *
 * J4: every spawn sets TERM explicitly (with TERM=dumb the CLI runs the plain
 * REPL, not the editor).
 *
 * Skipped when Bun.Terminal is unavailable.
 */
import { describe, expect, it } from "bun:test"

import { FakeTerminal } from "../test-utils/fake-terminal.ts"

const PANE_COLS = 60
const PANE_ROWS = 24

function haveBunTerminal(): boolean {
  return typeof Bun.spawn === "function"
}

async function runDriver(env: Record<string, string>): Promise<string> {
  const chunks: string[] = []
  const proc = Bun.spawn(["bun", "run", "src/test-utils/fixtures/paste-pty-driver.ts"], {
    cwd: import.meta.dir + "/../..",
    terminal: {
      cols: PANE_COLS,
      rows: PANE_ROWS,
      data(_t: unknown, d: Uint8Array) {
        chunks.push(new TextDecoder().decode(d))
      },
    } as any,
    env: { ...process.env, TERM: "xterm-ghostty", ...env },
  })
  const term = (proc as any).terminal as { close(): void } | undefined
  // Hard timeout so a wedged driver can't hang CI.
  const timer = setTimeout(() => {
    try {
      term?.close()
    } catch {}
    proc.kill()
  }, 15_000)
  await proc.exited
  clearTimeout(timer)
  return chunks.join("")
}

/** The base64 payload after `marker` in the driver output, decoded. */
function decodeAfter(out: string, marker: string): string {
  const markerIdx = out.lastIndexOf(`${marker} `)
  expect(markerIdx).toBeGreaterThan(-1)
  const b64 = out
    .slice(markerIdx + marker.length + 1)
    .trim()
    .split(/\s+/)[0]
  expect(b64).toBeTruthy()
  return Buffer.from(b64!, "base64").toString("utf8")
}

async function captureDriverBytes(env: Record<string, string>): Promise<string> {
  return decodeAfter(await runDriver(env), "PASTE-PTY-DONE")
}

function countScrollbackFrameDupes(raw: string): { prompts: number; firstLines: number } {
  const t = new FakeTerminal({ cols: PANE_COLS, rows: PANE_ROWS })
  t.feed(raw)
  const sb = t.scrollback.map((r) => r.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ""))
  // Ghost signature: each stale frame committed to scrollback restarts with
  // the prompt row ("ASK ❯ …") followed by the first pasted content row.
  const prompts = sb.filter((r) => r.includes("ASK")).length
  const firstLines = sb.filter((r) => /^x+\s+0$/.test(r.trim())).length
  return { prompts, firstLines }
}

/**
 * Number of live-area repaints in the captured stream. Each `setLiveArea`
 * paint emits exactly one CUU (walk-up) sequence inside its erase block.
 * The paste-coalesce contract: a 12-chunk burst must produce FEW paints,
 * not one per stdin chunk (pre-fix this was 11; coalesced it is ≤ 6). The
 * mid-paste paints show only the status row; the end marker paints the text.
 */
function countPaints(raw: string): number {
  return (raw.match(/\x1b\[\d*A/g) ?? []).length
}

describe("paste ghost frames — real Bun.Terminal PTY integration", () => {
  it.skipIf(!haveBunTerminal())(
    "disagreeing $COLUMNS vs PTY cols commits zero stale frames into scrollback",
    async () => {
      const raw = await captureDriverBytes({ COLUMNS: "45" })
      // The driver painted: the "pasting N kB" row mid-paste, then the whole
      // paste at the end marker (its last row is the last pasted line).
      expect(raw.length).toBeGreaterThan(500)
      expect(raw).toContain("pasting ")
      expect(raw).toContain("x 79")
      const { prompts, firstLines } = countScrollbackFrameDupes(raw)
      // Single source of truth: erase math uses the same cols the renderer
      // wrapped at, so NO frame is ever committed to scrollback.
      expect(prompts).toBe(0)
      expect(firstLines).toBe(0)
    },
    20_000,
  )

  it.skipIf(!haveBunTerminal())(
    "agreeing $COLUMNS vs PTY cols also stays clean (control)",
    async () => {
      const raw = await captureDriverBytes({ COLUMNS: String(PANE_COLS) })
      const { prompts, firstLines } = countScrollbackFrameDupes(raw)
      expect(prompts).toBe(0)
      expect(firstLines).toBe(0)
    },
    20_000,
  )

  it.skipIf(!haveBunTerminal())(
    "12-chunk paste burst coalesces paints instead of one per chunk",
    async () => {
      const raw = await captureDriverBytes({ COLUMNS: "45" })
      // Pre-fix: 11 paints for 12 chunks. Coalesced: initial paint + a
      // handful of trailing-edge flushes. Pin the contract well under the
      // per-chunk count so reintroducing the storm fails loudly.
      const paints = countPaints(raw)
      expect(paints).toBeGreaterThan(0)
      expect(paints).toBeLessThanOrEqual(6)
    },
    20_000,
  )

  it.skipIf(!haveBunTerminal())(
    "I4: a blank paste and an empty Ctrl+V still give [Image # tokens",
    async () => {
      const buffer = decodeAfter(
        await runDriver({ PASTE_PTY_MODE: "image", COLUMNS: String(PANE_COLS) }),
        "PASTE-PTY-BUFFER",
      )
      // One token from the blank bracketed paste, one from Ctrl+V.
      expect(buffer.match(/\[Image #/g)?.length).toBe(2)
    },
    20_000,
  )
})
