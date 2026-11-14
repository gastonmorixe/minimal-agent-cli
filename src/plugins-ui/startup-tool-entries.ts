/**
 * Decorate the loaded tool list for the startup tree `tools` row.
 *
 * Core tool definitions carry no cosmetic fields (S29, S31). The CLI owns
 * tool presentation in its static map (S41). The transcript header and the
 * `--resume` replay already read that map. This helper makes the startup
 * banner read it too, so the row shows `⤓ Fetch` and not a bare `Fetch`.
 *
 * Only `icon` and `color` go into a row entry. `headerKey` is a transcript
 * concern and the row formatter has no use for it.
 *
 * @module plugins-ui/startup-tool-entries
 */

import { applyToolNamePolicy, type ToolNamePolicy } from "@minimal-agent/core/sdk/tool-filter"

import type { StartupToolEntry } from "../ui/chrome/startup-tools-row.ts"
import { closeStartupTree, closeStartupTreeWithTools } from "../ui/startup/tree.ts"
import { type ToolPresentation, toolIcon } from "../ui/tool-transcript/format.ts"
import { TOOL_PRESENTATION } from "./tool-presentation.ts"

/**
 * Map each tool to a startup row entry. A tool with a map row gets its icon
 * and color. A tool with no row (or a row with no icon) gets the default icon.
 *
 * @param tools - The tools in advertised order (only `name` is read).
 * @param presentation - The presentation map. Default: {@link TOOL_PRESENTATION}.
 * @returns One entry per tool, in the same order.
 */
export function startupToolEntries(
  tools: ReadonlyArray<{ readonly name: string }>,
  presentation: ReadonlyMap<string, ToolPresentation> = TOOL_PRESENTATION,
): StartupToolEntry[] {
  return tools.map(({ name }) => {
    const p = presentation.get(name)
    const icon = toolIcon(p)
    return p?.color ? { name, icon, color: p.color } : { name, icon }
  })
}

/**
 * Close the startup tree with the `tools` row. The row lists the tools the
 * model sees (same pure SDK policy helper as AgentCore request assembly),
 * each with its CLI icon. With no tool left, close on the last row.
 */
export function closeStartupTreeWithLoadedTools(
  tools: ReadonlyArray<{ readonly name: string }>,
  policy: ToolNamePolicy,
): void {
  const entries = startupToolEntries(applyToolNamePolicy(tools, policy))
  if (entries.length > 0) closeStartupTreeWithTools(entries)
  else closeStartupTree()
}
