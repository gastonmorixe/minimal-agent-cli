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
 * @module startup/startup-plugin-rows-emit
 */

import type { StartupRow, StartupRowsPayload } from "@minimal-agent/core/plugin-api"
import { applyToolNamePolicy, type ToolNamePolicy } from "@minimal-agent/core/sdk/tool-filter"

import {
  closeStartupTreeWithLoadedTools,
  startupToolEntries,
} from "../plugins-ui/startup-tool-entries.ts"
import { renderStartupPluginRows } from "../ui/chrome/startup-plugin-rows.ts"
import { resolveHelpColor } from "../ui/help/policy.ts"
import { isStartupTreeVisible, printStartupToolsRow } from "../ui/startup/tree.ts"

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

function isPartArray(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every((p) => typeof p === "object" && p !== null && typeof p.text === "string")
  )
}

/** Keep only rows with a string label and a valid summary (and children). */
function sanitizeRows(rows: unknown): StartupRow[] {
  if (!Array.isArray(rows)) return []
  const out: StartupRow[] = []
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue
    const r = row as Record<string, unknown>
    if (typeof r.label !== "string" || !isPartArray(r.summary)) continue
    const clean: StartupRow = { label: r.label, summary: r.summary as StartupRow["summary"] }
    if (Array.isArray(r.children)) {
      clean.children = r.children.filter(
        (ch): ch is NonNullable<StartupRow["children"]>[number] =>
          typeof ch === "object" &&
          ch !== null &&
          typeof ch.label === "string" &&
          isPartArray(ch.value),
      )
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

/**
 * Close the startup tree with `tools`, then any plugin rows from
 * `startup.rows`. With no plugin rows this is exactly
 * `closeStartupTreeWithLoadedTools`.
 */
export async function closeStartupTreeWithToolsAndPluginRows(
  loader: { hooks(): StartupRowsHooks },
  tools: ReadonlyArray<{ readonly name: string }>,
  policy: ToolNamePolicy,
  { cwd }: { cwd: string },
): Promise<void> {
  const rows = isStartupTreeVisible()
    ? await collectStartupRows(loader.hooks(), { cwd, cols: stderrCols() })
    : []
  const plain = !resolveHelpColor(process.env, process.stderr.isTTY)
  const visible = renderStartupPluginRows(rows, { cols: stderrCols(), plain })
  if (visible.length === 0) {
    closeStartupTreeWithLoadedTools(tools, policy)
    return
  }
  const entries = startupToolEntries(applyToolNamePolicy(tools, policy))
  if (entries.length > 0) printStartupToolsRow(entries)
  printStartupPluginRows(rows, { cols: stderrCols(), plain, last: true })
}
