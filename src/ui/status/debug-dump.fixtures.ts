/**
 * Request snapshot fixtures for the `--debug` dump renderer tests.
 *
 * The tests build a typed `DumpView` with `dumpView(snapOf(...), ...)`, the
 * same path the live wiring uses. No core code is needed: {@link snapOf}
 * gives the snapshot the way core's `requestSnapshot` builds it.
 *
 * @module ui/status/debug-dump.fixtures
 */

import { join } from "node:path"
import type { RequestSnapshot } from "@minimal-agent/core/host/request-inspector"
import { type DumpView, dumpView } from "../../logging/request-dump-model.ts"
import { testSideband } from "../../test-utils/sideband-fixture.ts"
import type { DumpOriginSource } from "./debug-dump-origins.ts"

/** A loose request shape for the fixtures (tests cast like the core tests do). */
export interface SnapInput {
  readonly model?: string
  readonly stream?: boolean
  readonly maxTokens?: number
  readonly requestType?: string
  readonly outputConfig?: unknown
  readonly tools?: readonly unknown[]
  readonly system?: readonly unknown[]
  readonly messages?: readonly unknown[]
}

/** True when a block-like value has a truthy `cache_control` (core `requestSnapshot` rule). */
const hasCache = (b: unknown): boolean =>
  Boolean((b as { cache_control?: unknown } | undefined)?.cache_control)

/**
 * Build a snapshot the way core's `requestSnapshot` does.
 *
 * @param input - The loose request.
 * @returns The snapshot, with the cache breakpoints from `cache_control`.
 */
export function snapOf(input: SnapInput): RequestSnapshot {
  const system = (input.system ?? []) as RequestSnapshot["system"]
  const messages = (input.messages ?? []) as RequestSnapshot["messages"]
  return {
    model: input.model,
    stream: input.stream ?? true,
    ...(input.maxTokens != null ? { maxTokens: input.maxTokens } : {}),
    requestType: (input.requestType ?? "conversation") as RequestSnapshot["requestType"],
    ...(input.outputConfig
      ? { outputConfig: input.outputConfig as RequestSnapshot["outputConfig"] }
      : {}),
    tools: (input.tools ?? []) as RequestSnapshot["tools"],
    system,
    messages,
    cache: {
      system: system.flatMap((b, i) => (hasCache(b) ? [i] : [])),
      messages: messages.flatMap((m, i) =>
        typeof m.content !== "string" && hasCache(m.content[m.content.length - 1]) ? [i] : [],
      ),
    },
  }
}

/**
 * The typed view of a loose request.
 *
 * @param input - The loose request.
 * @param lines - Fill the verbose lines. Default `true`.
 */
export function viewOf(input: SnapInput, lines = true): DumpView {
  return dumpView(snapOf(input), { lines, sideband: testSideband })
}

/** A tool definition with a description. */
export const tool = (name: string, description: string): unknown => ({
  name,
  description,
  input_schema: { type: "object" },
})

/** A cache breakpoint marker for a block. */
export const CACHE = { cache_control: { type: "ephemeral" } } as const

/** The system block text of {@link VERBOSE_REQUEST}, as one string. */
export const SYSTEM_TEXT = [
  '<ma::sys::tool name="Skill">',
  "Name the skill you activated in your reply.",
  "</ma::sys::tool>",
  "",
  '<ma::sys::context name="environment">',
  "Host snapshot at session start.",
  "</ma::sys::context>",
].join("\n")

/** A request with 3 messages (the last one cached), 1 cached system block and 3 tools. */
export const VERBOSE_REQUEST: SnapInput = {
  model: "m1",
  messages: [
    { role: "user", content: "fix this:\n    indented line" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "a1", name: "Bash", input: { command: "ls" } }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "a1",
          content: "README.md\nsrc",
          is_error: false,
          ...CACHE,
        },
      ],
    },
  ],
  system: [{ type: "text", text: SYSTEM_TEXT, ...CACHE }],
  tools: [
    tool("Skill", "Discover, inspect and load an Agent Skill."),
    tool("Bash", "Run a command"),
    tool("Mystery", "x"),
  ],
}

/** Package dir of the fake skills plugin, under the cwd so it prints relative. */
export const SKILLS_DIR = join(process.cwd(), "plugins", "ma-skills-plugin")
/** Package dir of the fake env-info plugin. */
export const ENV_DIR = join(process.cwd(), "plugins", "ma-env-info-plugin")

/** A fake loader with every optional getter, matching {@link VERBOSE_REQUEST}. */
export function fakeOrigins(): DumpOriginSource {
  return {
    // The real codec of the sibling checkout reads the section tags.
    sideband: () => testSideband,
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
