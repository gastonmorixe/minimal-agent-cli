/**
 * Hand-made `--debug --verbose` request-dump rows for the renderer tests.
 *
 * The rows follow the contract in `research/verbose-dump/plan.md` section 2:
 * the labelled row of each part carries `kind: "part"`, each message content
 * block a `kind: "block"` row, and each source line a `kind: "line"` row whose
 * text is the raw line. No core code is needed to build them.
 *
 * @module ui/status/debug-dump.fixtures
 */

import { join } from "node:path"
import type { DumpOriginSource } from "./debug-dump-origins.ts"

/** One dump row: the diagnostic message and its verbose-only data. */
export type FixtureRow = readonly [string, Readonly<Record<string, string | number | boolean>>?]

/** The system block text of {@link VERBOSE_ROWS}, as one string. */
export const SYSTEM_TEXT = [
  '<ma::sys::tool name="Skill">',
  "Name the skill you activated in your reply.",
  "</ma::sys::tool>",
  "",
  '<ma::sys::context name="environment">',
  "Host snapshot at session start.",
  "</ma::sys::context>",
].join("\n")

/** Line rows for one part, numbered from 1. */
function lines(section: string, part: number, text: string, block?: number): FixtureRow[] {
  return text
    .split("\n")
    .map((t, i) => [
      t,
      { kind: "line", section, part, ...(block === undefined ? {} : { block }), line: i + 1 },
    ])
}

/** A verbose dump with 3 messages, 1 system block and 3 tools. */
export const VERBOSE_ROWS: readonly FixtureRow[] = [
  ["--- POST m1 ---"],
  ["  model: m1"],
  ["  Body:"],
  ["    messages: [3 message(s)]"],
  ['      user: "fix this: ⏎ indented line"', { kind: "part", section: "messages", part: 0 }],
  [
    "        block 0 text",
    { kind: "block", section: "messages", part: 0, block: 0, blockType: "text" },
  ],
  ...lines("messages", 0, "fix this:\n    indented line", 0),
  ["      assistant: tool_use(Bash#a1){command}", { kind: "part", section: "messages", part: 1 }],
  [
    "        block 0 tool_use",
    {
      kind: "block",
      section: "messages",
      part: 1,
      block: 0,
      blockType: "tool_use",
      toolUseId: "a1",
      toolName: "Bash",
    },
  ],
  ...lines("messages", 1, '{\n  "command": "ls"\n}', 0),
  [
    '      user [← cached prefix ends here]: tool_result(a1) "README.md ⏎ src"',
    { kind: "part", section: "messages", part: 2 },
  ],
  [
    "        block 0 tool_result",
    {
      kind: "block",
      section: "messages",
      part: 2,
      block: 0,
      blockType: "tool_result",
      toolUseId: "a1",
      isError: false,
    },
  ],
  ...lines("messages", 2, "README.md\nsrc", 0),
  ["    system: [1 block(s)]"],
  [
    '      block 0 [cached]: <ma::sys::tool name="Skill"> ⏎ …',
    { kind: "part", section: "system", part: 0 },
  ],
  ...lines("system", 0, SYSTEM_TEXT),
  ["    tools: [3 tool(s)]"],
  [
    "      Skill: Discover, inspect and load an Agent Skill.",
    { kind: "part", section: "tools", part: 0 },
  ],
  ...lines("tools", 0, "Discover, inspect and load an Agent Skill."),
  ["      Bash: Run a command", { kind: "part", section: "tools", part: 1 }],
  ...lines("tools", 1, "Run a command"),
  ["      Mystery: x", { kind: "part", section: "tools", part: 2 }],
  ...lines("tools", 2, "x"),
]

/** Package dir of the fake skills plugin, under the cwd so it prints relative. */
export const SKILLS_DIR = join(process.cwd(), "plugins", "ma-skills-plugin")
/** Package dir of the fake env-info plugin. */
export const ENV_DIR = join(process.cwd(), "plugins", "ma-env-info-plugin")

/** A fake loader with every optional getter, matching {@link VERBOSE_ROWS}. */
export function fakeOrigins(): DumpOriginSource {
  return {
    loadedPackages: () => [
      { id: "ma-skills-plugin", packageDir: SKILLS_DIR },
      { id: "ma-env-info-plugin", packageDir: ENV_DIR },
    ],
    toolOwners: () =>
      new Map([["Skill", { pluginId: "ma-skills-plugin", packageDir: SKILLS_DIR }]]),
    getPromptProvenance: () => ({
      afterInstructions: [],
      sessionContext: [
        { role: "tool", name: "Skill", pluginId: "ma-skills-plugin", packageDir: SKILLS_DIR },
        {
          role: "context",
          name: "environment",
          pluginId: "ma-env-info-plugin",
          packageDir: ENV_DIR,
        },
      ],
    }),
    describeSystemBlock: (text) =>
      text === SYSTEM_TEXT
        ? [{ slot: "sessionContext", start: 0, end: text.length, overridden: false }]
        : undefined,
  }
}
