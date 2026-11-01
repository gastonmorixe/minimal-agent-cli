/**
 * The CLI's view of its terminal size for tool calls (spec S24). Core never
 * reads the terminal size. The CLI reads its own `process.stdout` here and
 * gives core the env values for a spawned tool through the `toolEnv` port.
 *
 * `COLUMNS` / `LINES` let tools inside Bash (`tput cols`, `stty size`, a
 * script that reads `$COLUMNS`) see the real size instead of a fixed
 * 80x24 fallback. The values are read once at spawn: a resize during a
 * command does not change them.
 *
 * @module terminal/terminal-tool-env
 */

import type { ToolEnvPort } from "@minimal-agent/core/sdk/ports"

/** The live terminal width in columns, or `undefined` with no TTY width. */
export function terminalColumns(): number | undefined {
  const cols = process.stdout.columns
  return typeof cols === "number" && cols > 0 ? cols : undefined
}

/** The live terminal height in rows, or `undefined` with no TTY height. */
export function terminalRows(): number | undefined {
  const rows = process.stdout.rows
  return typeof rows === "number" && rows > 0 ? rows : undefined
}

/** A `toolEnv` port with this process's live terminal size. */
export const TERMINAL_TOOL_ENV: ToolEnvPort = {
  values: () => {
    const env: Record<string, string> = {}
    const cols = terminalColumns()
    const rows = terminalRows()
    if (cols !== undefined) env.COLUMNS = String(Math.floor(cols))
    if (rows !== undefined) env.LINES = String(Math.floor(rows))
    return { env }
  },
}
