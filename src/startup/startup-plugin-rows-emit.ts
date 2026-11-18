/**
 * Collect and print plugin rows for the startup tree (`startup.rows`).
 *
 * The core emits nothing here: the host fires the `startup.rows` chain
 * once, just before the tree closes, under a short budget (250 ms). Each
 * listener appends one semantic row. On timeout, error, or a malformed
 * result the host prints nothing.
 *
 * Placement (H1 design): plugin rows go AFTER `tools`. Today `tools` is
 * the closer (`╰`). So when plugin rows exist, `tools` prints as a normal
 * `│` row (`printStartupToolsRow`) and the plugin group closes the tree
 * (`last: true`). With no plugin rows the old path runs unchanged
 * (`closeStartupTreeWithLoadedTools`).
 *
 * Budget: the 250 ms race bounds only ASYNC listener work. A listener that
 * blocks synchronously (file reads, parsing, hashing) holds the event loop
 * and the timer cannot fire, so listeners must stay synchronous-cheap and
 * move any heavy work behind an `await` or off the boot path.
 *
 * Safety: every plugin string (row label, summary text, child label, child
 * value text) is stripped of ESC sequences and C0/DEL/C1 controls (tab and
 * newline become a space), and an unknown tone falls back to `default`.
 * Any error in collect, render, or print falls back to the old closer, and
 * nothing is printed before the lines are fully rendered.
 *
 * @module startup/startup-plugin-rows-emit
 */

import type { StartupRow, StartupRowPart, StartupRowsPayload } from "@minimal-agent/core/plugin-api"
import { applyToolNamePolicy, type ToolNamePolicy } from "@minimal-agent/core/sdk/tool-filter"

import {
  closeStartupTreeWithLoadedTools,
  startupToolEntries,
} from "../plugins-ui/startup-tool-entries.ts"
import { renderStartupPluginRows } from "../ui/chrome/startup-plugin-rows.ts"
import { resolveHelpColor } from "../ui/help/policy.ts"
import { stripAllTerminalControls } from "../ui/sanitize-scrollback.ts"
import {
  isStartupTreeVisible,
  printStartupToolsRow,
  resetStartupTreeRow,
} from "../ui/startup/tree.ts"

/** The slice of the loader hook bus this module needs. */
export interface StartupRowsHooks {
  emitChain<T>(channel: string, payload: T): Promise<{ payload: T }>
}

/** Options for {@link collectStartupRows}. */
export interface CollectStartupRowsOptions {
  cwd: string
  cols: number
  /** Time budget in ms. Default 250. */
  budgetMs?: number
}

/** Default budget for the `startup.rows` chain, in ms. */
export const STARTUP_ROWS_BUDGET_MS = 250

const TIMEOUT = Symbol("timeout")

/**
 * Strip terminal control content from a plugin-supplied string: escape
 * sequences and control strings (CSI, OSC, DCS, ...), then every C0
 * control, DEL, and C1 control. Tab, newline and CR become a space so
 * words stay apart (`\r\n` is one space). The scanner is shared with the
 * scrollback sanitizer (`ui/sanitize-scrollback.ts`).
 */
export const stripTerminalControls: (text: string) => string = stripAllTerminalControls

const TONES: ReadonlySet<string> = new Set(["default", "dim", "accent", "warn", "ok"])

function isPartArray(v: unknown): v is Array<Record<string, unknown>> {
  return (
    Array.isArray(v) &&
    v.every((p) => typeof p === "object" && p !== null && typeof p.text === "string")
  )
}

/** Clean parts: strip controls from text, map an unknown tone to `default`. */
function cleanParts(parts: Array<Record<string, unknown>>): StartupRowPart[] {
  return parts.map((p) => {
    const part: StartupRowPart = { text: stripTerminalControls(p.text as string) }
    if (p.tone !== undefined) {
      part.tone =
        typeof p.tone === "string" && TONES.has(p.tone)
          ? (p.tone as StartupRowPart["tone"])
          : "default"
    }
    return part
  })
}

/** Keep only rows with a string label and a valid summary (and children), cleaned. */
function sanitizeRows(rows: unknown): StartupRow[] {
  if (!Array.isArray(rows)) return []
  const out: StartupRow[] = []
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue
    const r = row as Record<string, unknown>
    if (typeof r.label !== "string" || !isPartArray(r.summary)) continue
    const clean: StartupRow = {
      label: stripTerminalControls(r.label),
      summary: cleanParts(r.summary),
    }
    if (Array.isArray(r.children)) {
      clean.children = []
      for (const ch of r.children as unknown[]) {
        if (typeof ch !== "object" || ch === null) continue
        const c = ch as Record<string, unknown>
        if (typeof c.label !== "string" || !isPartArray(c.value)) continue
        clean.children.push({ label: stripTerminalControls(c.label), value: cleanParts(c.value) })
      }
    }
    if (typeof r.order === "number" && Number.isFinite(r.order)) clean.order = r.order
    out.push(clean)
  }
  return out
}

/**
 * Fire the `startup.rows` chain under a time budget.
 *
 * @returns The valid rows, or `[]` on timeout, error, or a malformed result. Never throws.
 */
export async function collectStartupRows(
  hooks: StartupRowsHooks,
  { cwd, cols, budgetMs = STARTUP_ROWS_BUDGET_MS }: CollectStartupRowsOptions,
): Promise<StartupRow[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const payload: StartupRowsPayload = { cwd, cols, rows: [] }
    const emit = hooks.emitChain("startup.rows", payload)
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), budgetMs)
    })
    // A late rejection after the timeout must not surface as unhandled.
    emit.catch(() => undefined)
    const result = await Promise.race([emit, timeout])
    if (result === TIMEOUT) return []
    const rows = (result as { payload?: { rows?: unknown } } | null)?.payload?.rows
    return sanitizeRows(rows)
  } catch {
    return []
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Options for {@link printStartupPluginRows}. */
export interface PrintStartupPluginRowsOptions {
  cols: number
  plain: boolean
  last?: boolean
  /** Line writer. Default: `console.error`, the tree.ts writer. */
  write?: (line: string) => void
}

/** Render plugin rows and write them to stderr like tree.ts rows. Empty rows print nothing. */
export function printStartupPluginRows(
  rows: ReadonlyArray<StartupRow>,
  { cols, plain, last, write = (line) => console.error(line) }: PrintStartupPluginRowsOptions,
): void {
  for (const line of renderStartupPluginRows(rows, { cols, plain, last })) write(line)
}

/** Current stderr width, same fallback as tree.ts (80). */
function stderrCols(): number {
  return (process.stderr as { columns?: number }).columns ?? 80
}

/** Test seam: the renderer used by {@link closeStartupTreeWithToolsAndPluginRows}. */
export const startupPluginRowsSeam = { render: renderStartupPluginRows }

/**
 * Close the startup tree with `tools`, then any plugin rows from
 * `startup.rows`. With no plugin rows this is exactly
 * `closeStartupTreeWithLoadedTools`. Never throws: any error before the
 * first line is printed falls back to `closeStartupTreeWithLoadedTools`.
 */
export async function closeStartupTreeWithToolsAndPluginRows(
  loader: { hooks(): StartupRowsHooks },
  tools: ReadonlyArray<{ readonly name: string }>,
  policy: ToolNamePolicy,
  { cwd }: { cwd: string },
): Promise<void> {
  let lines: string[]
  let entries: ReturnType<typeof startupToolEntries>
  try {
    const cols = stderrCols()
    const rows = isStartupTreeVisible()
      ? await collectStartupRows(loader.hooks(), { cwd, cols })
      : []
    const plain = !resolveHelpColor(process.env, process.stderr.isTTY)
    lines = rows.length === 0 ? [] : startupPluginRowsSeam.render(rows, { cols, plain, last: true })
    entries = lines.length === 0 ? [] : startupToolEntries(applyToolNamePolicy(tools, policy))
  } catch {
    lines = []
    entries = []
  }
  if (lines.length === 0) {
    closeStartupTreeWithLoadedTools(tools, policy)
    return
  }
  try {
    if (entries.length > 0) printStartupToolsRow(entries)
    for (const line of lines) console.error(line)
  } catch {
    // Output already started: a fallback would print the tree twice.
  } finally {
    // The plugin group closed the tree: no later closeStartupTree rewrite.
    resetStartupTreeRow()
  }
}
