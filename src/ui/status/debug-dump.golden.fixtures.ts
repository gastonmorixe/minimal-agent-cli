/**
 * Inputs of the `--debug` dump golden test (`debug-dump.golden.test.ts`).
 *
 * One synthetic request that touches each rendering rule: every header
 * field, a cached system block and a cached message, a preview over the
 * 80-character cap, a preview that fits the cap but not a narrow terminal,
 * wide (CJK, emoji) text, a surrogate pair at the cap, control bytes, a
 * block over the verbose row cap, `tool_use` and `tool_result` pairs, and
 * plugin, built-in and unrecorded tool origins.
 *
 * Do not change this data without a reason: the golden files record the
 * output for exactly this input. A change here needs `UPDATE_GOLDEN=1` and a
 * review of each changed golden file.
 *
 * @module ui/status/debug-dump.golden.fixtures
 */

import { join } from "node:path"
import type { RequestSnapshot } from "@minimal-agent/core/host/request-inspector"
import type { Message } from "@minimal-agent/core/sdk/messages"
import { testSideband } from "../../test-utils/sideband-fixture.ts"
import type { DumpOriginSource } from "./debug-dump-origins.ts"

/** The multi-line, cached system block. The fake describer maps it to `sessionContext`. */
export const GOLDEN_SYSTEM_TEXT = [
  '<ma::sys::tool name="Skill">',
  "Name the skill you activated in your reply.",
  "</ma::sys::tool>",
  "",
  '<ma::sys::context name="environment">',
  "Host snapshot at session start.",
  "\tcwd=/work/repo",
  "</ma::sys::context>",
].join("\n")

/** A tool id with a stable short form. */
const BASH_ID = "toolu_01ABCDEFa1b2c3"
const READ_ID = "toolu_02GHIJKLd4e5f6"

/** 210 lines: over the verbose cap of 200 rows. */
const LONG_TEXT = Array.from({ length: 210 }, (_, i) => `line ${i + 1}`).join("\n")

/** Wide text: fits the 80-character cap, but needs about 110 cells. */
const WIDE_FITS = `日本語のテキストです。${"表示幅".repeat(14)}`

/** Over the cap, with an emoji pair across the cut at character 80. */
const WIDE_OVER = `${"x".repeat(79)}🎉 then more text after the emoji, ${"漢字".repeat(10)}`

const messages: Message[] = [
  { role: "user", content: "fix this:\n    indented line" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "let me look at the files", signature: "sig" },
      { type: "text", text: "Sure." },
      {
        type: "tool_use",
        id: BASH_ID,
        name: "Bash",
        input: { command: "ls -la", description: "list" },
      },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: BASH_ID, content: "README.md\nsrc" }],
  },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: READ_ID, name: "Read", input: { file_path: "/x" } }],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: READ_ID,
        is_error: true,
        content: [{ type: "text", text: "ENOENT: no such file or directory, open '/x'" }],
      },
    ],
  },
  { role: "user", content: [{ type: "text", text: LONG_TEXT }] },
  {
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0K" } },
      { type: "text", text: `what is this? note: a colon. ${WIDE_OVER}` },
    ],
  },
  { role: "assistant", content: `a control \u001b[2J byte and a C1 \u009b byte in ${WIDE_FITS}` },
  {
    role: "user",
    content: [{ type: "text", text: "hi there", cache_control: { type: "ephemeral" } }],
  },
]

const system: RequestSnapshot["system"] = [
  { type: "text", text: "You are minimal agent." },
  { type: "text", text: GOLDEN_SYSTEM_TEXT, cache_control: { type: "ephemeral" } },
  {
    type: "text",
    text: `# Instructions\n- Be concise.\n${"Prefer dedicated tools over shell commands. ".repeat(4)}`,
    cache_control: { type: "ephemeral" },
  },
]

const tools: RequestSnapshot["tools"] = [
  {
    name: "Skill",
    description: "Discover, inspect and load an Agent Skill.",
    input_schema: { type: "object" },
  },
  {
    name: "Bash",
    description: `Executes a given bash command.\nOutput: capped. ${"Run it with care. ".repeat(8)}`,
    input_schema: { type: "object" },
  },
  {
    name: "Read",
    description: "Read a file.\n  Returns its text.",
    input_schema: { type: "object" },
  },
  { name: "Mystery", description: "x", input_schema: {} },
  { name: "Wide", description: WIDE_FITS, input_schema: {} },
  { name: "Ctl", description: "Run a comm\u001b[31mand\u009b now", input_schema: {} },
]

/** The synthetic request of the golden test. */
export const GOLDEN_SNAPSHOT: RequestSnapshot = {
  model: "claude-opus-4-8",
  stream: true,
  maxTokens: 32000,
  requestType: "conversation",
  thinking: { type: "adaptive", display: "summarized" },
  outputConfig: {
    effort: "high",
    format: {
      type: "json_schema",
      schema: { type: "object", properties: { answer: { type: "string" } } },
    },
  },
  speed: "fast",
  tools,
  system,
  messages,
  cache: { system: [1, 2], messages: [8] },
}

/** Package dir of the fake skills plugin, under the cwd so it prints relative. */
const SKILLS_DIR = join(process.cwd(), "plugins", "ma-skills-plugin")
/** Package dir of the fake env-info plugin. */
const ENV_DIR = join(process.cwd(), "plugins", "ma-env-info-plugin")

/**
 * A fake loader for the golden test: one plugin tool (`Skill`), one built-in
 * tool (`Bash`, `Read` from core), the rest unrecorded.
 *
 * @param describe - The system block describer. Default: the synthetic
 *   block maps to `sessionContext`, other blocks are unknown.
 */
export function goldenOrigins(
  describe?: DumpOriginSource["describeSystemBlock"],
): DumpOriginSource {
  return {
    // The real codec of the sibling checkout reads the section tags.
    sideband: () => testSideband,
    loadedPackages: () => [
      { id: "ma-skills-plugin", packageDir: SKILLS_DIR },
      { id: "ma-env-info-plugin", packageDir: ENV_DIR },
    ],
    toolOwners: () =>
      new Map([
        ["Skill", { pluginId: "ma-skills-plugin", packageDir: SKILLS_DIR }],
        ["Echo", { pluginId: "ma-skills-plugin", packageDir: SKILLS_DIR }],
      ]),
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
    describeSystemBlock:
      describe ??
      ((text) =>
        text === GOLDEN_SYSTEM_TEXT
          ? [{ slot: "sessionContext", start: 0, end: text.length, overridden: false }]
          : undefined),
  }
}

/** One render variant. */
export interface GoldenVariant {
  /** File name part. */
  readonly name: string
  /** Verbose (lines with a gutter) or compact rows. */
  readonly verbose: boolean
  /** Clip width of compact rows and header fields. */
  readonly width?: number
  /** Hanging-indent wrap width of verbose lines. */
  readonly wrapWidth?: number
}

/** The variants of the synthetic request. */
export const SYNTH_VARIANTS: readonly GoldenVariant[] = [
  { name: "compact-w30", verbose: false, width: 30 },
  { name: "compact-w40", verbose: false, width: 40 },
  { name: "compact-w80", verbose: false, width: 80 },
  { name: "compact-w93", verbose: false, width: 93 },
  { name: "compact-w140", verbose: false, width: 140 },
  { name: "compact-nowidth", verbose: false },
  { name: "verbose-nowrap", verbose: true },
  { name: "verbose-w60", verbose: true, wrapWidth: 60 },
  { name: "verbose-w100", verbose: true, wrapWidth: 100 },
  { name: "verbose-w100-clip80", verbose: true, width: 80, wrapWidth: 100 },
]

/** The variants of the real AgentCore request. */
export const CORE_VARIANTS: readonly GoldenVariant[] = [
  { name: "compact-w80", verbose: false, width: 80 },
  { name: "compact-w140", verbose: false, width: 140 },
  { name: "compact-nowidth", verbose: false },
  { name: "verbose-w100", verbose: true, wrapWidth: 100 },
]
