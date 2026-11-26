/**
 * The static tool presentation map of the CLI (S41).
 *
 * Core tool definitions and plugin manifests carry no cosmetic fields
 * (S29, S31). The CLI keeps the icon, color, and header key of each core
 * built-in tool and each first-party plugin tool here, keyed by the
 * canonical tool name. The
 * live tool header (`ToolExecutorAdapter.presentation`) and the
 * `--resume` replay both read this map. It does not depend on loaded
 * plugin `ui` modules, so every route sees the same map.
 *
 * - `icon`: glyph before the bold tool name in the `╭` header.
 * - `color`: an `ansiStyle` key for the icon and the label.
 * - `headerKey`: an input field that heads the header at once. The live
 *   header then paints before the handler returns (long tools: Fetch).
 *
 * A tool that is not in the map (a user plugin, an alias) gets
 * `DEFAULT_TOOL_ICON` in the default label color.
 *
 * @module plugins-ui/tool-presentation
 */

import type { ToolPresentation } from "../ui/tool-transcript/format.ts"

/** Rows: canonical tool name, then its presentation. Plugin package in the comment. */
const ROWS: ReadonlyArray<readonly [string, ToolPresentation]> = [
  // Core built-ins (`TOOL_DEFINITIONS`). Same glyphs as before S29 (core 65b832d).
  ["Bash", { icon: "»", color: "orange" }], // core
  ["Read", { icon: "•", color: "sky" }], // core
  ["Write", { icon: "✚", color: "lime" }], // core
  ["Edit", { icon: "✦", color: "gold" }], // core
  ["Glob", { icon: "✱", color: "violet" }], // core
  ["Grep", { icon: "⌕", color: "pink" }], // core
  ["FilesStats", { icon: "▦", color: "cyan" }], // core
  ["Mode", { icon: "◐", color: "sky" }], // core
  // Plugin tools.
  ["CloudStatus", { icon: "☁", color: "sky" }], // ma-agent-cloud
  ["CloudLogin", { icon: "☁", color: "sky" }], // ma-agent-cloud
  ["CloudPush", { icon: "☁", color: "sky" }], // ma-agent-cloud
  ["BackgroundRun", { icon: "▶", color: "cyan" }], // ma-background-plugin
  ["BackgroundStatus", { icon: "◎", color: "violet" }], // ma-background-plugin
  ["BackgroundLogs", { icon: "▤", color: "sky" }], // ma-background-plugin
  ["BackgroundStop", { icon: "■", color: "red" }], // ma-background-plugin
  ["ChromeCDP", { icon: "◉", color: "orange" }], // ma-chrome-cdp-plugin
  ["CompactContext", { icon: "✂", color: "violet" }], // ma-compact-plugin
  ["Computer", { icon: "◈", color: "cyan" }], // ma-computer-use-plugin
  ["DiffViewerShowDiff", { icon: "±", color: "lime" }], // ma-diff-view-plugin
  ["Fetch", { icon: "⤓", color: "sky", headerKey: "url" }], // ma-fetch-plugin
  ["LockStatus", { icon: "⊠", color: "yellow" }], // ma-file-lock-plugin
  ["IntercomPeers", { icon: "◎", color: "cyan" }], // ma-intercom-plugin
  ["IntercomSend", { icon: "->", color: "magenta" }], // ma-intercom-plugin
  ["IntercomInbox", { icon: "↓", color: "cyan" }], // ma-intercom-plugin
  ["MemoryTool", { icon: "󰍩", color: "purple" }], // ma-memory-plugin
  ["ModelInfo", { icon: "◇", color: "sky" }], // ma-model-info-plugin
  ["PromptNew", { icon: "❯", color: "lime" }], // ma-prompts-plugin
  ["PromptList", { icon: "❯", color: "lime" }], // ma-prompts-plugin
  ["PromptShow", { icon: "❯", color: "lime" }], // ma-prompts-plugin
  ["PromptEdit", { icon: "❯", color: "lime" }], // ma-prompts-plugin
  ["PromptDelete", { icon: "❯", color: "lime" }], // ma-prompts-plugin
  ["ScheduleCronCreate", { icon: "⧗", color: "gold" }], // ma-schedule-plugin
  ["ScheduleCronList", { icon: "⧗", color: "gold" }], // ma-schedule-plugin
  ["ScheduleCronDelete", { icon: "⧗", color: "gold" }], // ma-schedule-plugin
  ["ScheduleCronReschedule", { icon: "⧗", color: "gold" }], // ma-schedule-plugin
  ["SecurityStatus", { icon: "▣", color: "gold" }], // ma-security-plugin
  ["SessionHistory", { icon: "↺", color: "violet" }], // ma-session-history-plugin
  ["SessionInfo", { icon: "◷", color: "cyan" }], // ma-session-info-plugin
  ["SessionTitle", { icon: "✎", color: "gold" }], // ma-title-plugin
  ["Skill", { icon: "✦", color: "violet" }], // ma-skills-plugin
  ["Speak", { icon: "♪", color: "sky" }], // ma-speak-plugin
  ["SpeakStatus", { icon: "◎", color: "violet" }], // ma-speak-plugin
  ["SpeakStop", { icon: "■", color: "red" }], // ma-speak-plugin
  ["SubAgentsSpawnAgent", { icon: "◈", color: "gold" }], // ma-sub-agents-plugin
  ["SubAgentsReportResult", { icon: "◈", color: "lime" }], // ma-sub-agents-plugin
  ["SubAgentsListAgents", { icon: "◈", color: "sky" }], // ma-sub-agents-plugin
  ["SubAgentsAgentStatus", { icon: "◈", color: "sky" }], // ma-sub-agents-plugin
  ["SubAgentsAgentResult", { icon: "◈", color: "lime" }], // ma-sub-agents-plugin
  ["SubAgentsAgentOutput", { icon: "◈", color: "sky" }], // ma-sub-agents-plugin
  ["SubAgentsMailbox", { icon: "✉", color: "violet" }], // ma-sub-agents-plugin
  ["SubAgentsStopAgent", { icon: "◈", color: "red" }], // ma-sub-agents-plugin
  ["Task", { icon: "◉", color: "lime" }], // ma-tasks-plugin
  ["WebSearch", { icon: "󰖟", color: "gold" }], // ma-web-search-plugin
]

/** The static tool presentation map. Read-only. */
export const TOOL_PRESENTATION: ReadonlyMap<string, ToolPresentation> = new Map(ROWS)

/** A new mutable copy of {@link TOOL_PRESENTATION}, for callers that take a `Map`. */
export function toolPresentationMap(): Map<string, ToolPresentation> {
  return new Map(ROWS)
}
