/**
 * Test-only fixture (imported only by `*.test.ts`) for width-mode tables:
 * the sessions list data of
 * `research/sessions-tui-mockups/recommended.ts`, as a table spec.
 *
 * @module ui/__fixtures__/command-table-sessions
 */

import type {
  CommandTableColumn,
  CommandTableRow,
  CommandTableSection,
  CommandTableSpec,
} from "../command-table-types.ts"

type Status = "live" | "done" | "failed"

interface FixtureSession {
  sid: string
  start: string
  dur: string
  prompt: string
  tokens: string
  cost?: string
  model: string
  status: Status
  role?: string
}

const glyph = { live: "●", done: "○", failed: "✗" } as const
const glyphColor = { live: "green", done: "dim", failed: "red" } as const

/** Columns of the recommended sessions list. */
export const SESSION_COLUMNS: CommandTableColumn[] = [
  { key: "id", header: "session", width: 12 },
  { key: "start", header: "start", align: "r", width: 5, color: "dim", dropPriority: 3 },
  { key: "dur", header: "dur", align: "r", width: 6, color: "dim", dropPriority: 4 },
  { key: "prompt", header: "prompt", flex: true, minWidth: 20 },
  { key: "tokens", header: "tokens", align: "r", width: 6, dropPriority: 5 },
  { key: "cost", header: "cost", align: "r", width: 6, color: "dim", dropPriority: 1 },
  { key: "model", header: "model", width: 10, color: "dim", dropPriority: 2 },
]

/** Build one table row from a fixture session. */
export function sessionRow(s: FixtureSession, depth = 0): CommandTableRow {
  const kid = depth > 0
  return {
    depth,
    cells: { start: s.start, dur: s.dur, tokens: s.tokens, cost: s.cost, model: s.model },
    spans: {
      id: [
        { text: glyph[s.status], color: glyphColor[s.status] },
        { text: ` ${s.sid}`, color: kid ? "dim" : "cyan" },
      ],
      prompt: s.role
        ? [
            { text: s.role, color: "yellow" },
            { text: ` · ${s.prompt}`, color: "dim" },
          ]
        : [{ text: s.prompt }],
      tokens: [{ text: s.tokens, color: kid ? "dim" : "none" }],
    },
  }
}

const kid = (
  sid: string,
  start: string,
  role: string,
  prompt: string,
  tokens: string,
  dur: string,
  status: Status = "done",
  model = "sonnet-5-5",
): CommandTableRow => sessionRow({ sid, start, role, prompt, tokens, dur, status, model }, 1)

/** Day sections of the recommended mockup. */
export const SESSION_SECTIONS: CommandTableSection[] = [
  {
    title: "Wed Nov 18",
    rows: [
      sessionRow({
        sid: "14b9c023",
        start: "22:10",
        dur: "4m",
        prompt: "how do I create a new user on mac using the terminal",
        tokens: "4.3k",
        cost: "$0.02",
        model: "opus-4-7",
        status: "done",
      }),
    ],
  },
  {
    title: "today",
    rows: [
      sessionRow({
        sid: "284138af",
        start: "08:33",
        dur: "21m",
        prompt: "split session-store into smaller modules, keep the public api",
        tokens: "1.2M",
        cost: "$1.90",
        model: "opus-5-5",
        status: "done",
      }),
      sessionRow({
        sid: "e0f2d3d3",
        start: "08:49",
        dur: "9m02s",
        prompt: "fix flaky checkout e2e test 日本語 wide chars ok",
        tokens: "10.7M",
        cost: "$6.12",
        model: "opus-5-5",
        status: "done",
      }),
      kid(
        "ecb565ab",
        "08:50",
        "worker",
        "patch retry logic in cart.ts and add a regression test",
        "4.5M",
        "3m40s",
      ),
      kid(
        "4ba189cc",
        "08:54",
        "reviewer",
        "review the diff for races",
        "2.7M",
        "2m10s",
        "done",
        "opus-5-5",
      ),
      kid(
        "217a4f68",
        "08:57",
        "integrator",
        "run suite and commit",
        "351k",
        "48s",
        "failed",
        "haiku-5-5",
      ),
      sessionRow({
        sid: "443ef015",
        start: "08:55",
        dur: "35m",
        prompt: "review how the sessions command works",
        tokens: "275k",
        cost: "$0.41",
        model: "sonnet-5-5",
        status: "live",
      }),
      kid("2609ae26", "08:56", "explorer", "read session store + index", "102.9k", "1m14s"),
    ],
  },
]

/** The full spec of the recommended mockup at `width` cells. */
export function sessionTableSpec(width: number, color = false): CommandTableSpec {
  return {
    width,
    color,
    columns: SESSION_COLUMNS,
    sections: SESSION_SECTIONS,
    summary: "4 of 17,427 sessions · 1,449 empty/test hidden · --all · --limit N · sessions <sid>",
  }
}
