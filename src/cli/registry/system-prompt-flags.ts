/**
 * System-prompt override flags as registry data (plan M-8a, 2.1 and 2.3).
 *
 * The flag and env names repeat the names in
 * `src/cli/system-prompt-override-flags.ts` and core
 * `SYSTEM_PROMPT_OVERRIDE_KEY_SPECS`. They are not imported from there:
 * that module imports `@minimal-agent/core/host/system-prompt-overrides`,
 * and the registry must import no core host module (plan 4.2, R-18, the
 * M-9c import test). `registry-definition.test.ts` checks that both lists
 * hold the same names, so they cannot drift.
 *
 * Each part has a visible value flag, plus a `-file` form and a `no-` form,
 * both hidden (so the drift test and M-12 still see them). Order is the
 * root help order, not the core key-spec order.
 *
 * @module cli/registry/system-prompt-flags
 */

import type { FlagSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import type { BuiltinEnvSpec } from "./types.ts"

/** Flag and env names plus help text for one override part. */
interface SystemPromptPartData {
  /** Value flag name with no dashes. The `-file` and `no-` forms derive from it. */
  readonly flag: string
  /** Env name for the value. */
  readonly env: string
  /** Env name for the file path. */
  readonly fileEnv: string
  /** Root help summary of the value flag. */
  readonly summary: string
  /** Root help notes of the value flag. */
  readonly description: string[]
}

/** The override parts, in root help order. */
const PARTS: readonly SystemPromptPartData[] = [
  {
    flag: "system-prompt",
    env: "MINIMAL_AGENT_SYSTEM_PROMPT",
    fileEnv: "MINIMAL_AGENT_SYSTEM_PROMPT_FILE",
    summary: "Replace the whole core-controllable system prompt",
    description: ["every override accepts <flag>-file <path> or --no-<flag-name> to omit"],
  },
  {
    flag: "system-identity",
    env: "MINIMAL_AGENT_SYSTEM_IDENTITY",
    fileEnv: "MINIMAL_AGENT_SYSTEM_IDENTITY_FILE",
    summary: "Replace the neutral identity block",
    description: ["or --system-identity-file <path>, or --no-system-identity"],
  },
  {
    flag: "system-instructions",
    env: "MINIMAL_AGENT_SYSTEM_INSTRUCTIONS",
    fileEnv: "MINIMAL_AGENT_SYSTEM_INSTRUCTIONS_FILE",
    summary: "Replace the base instructions block",
    description: ["or --system-instructions-file <path>, or --no-system-instructions"],
  },
  {
    flag: "system-loop-safety",
    env: "MINIMAL_AGENT_SYSTEM_LOOP_SAFETY",
    fileEnv: "MINIMAL_AGENT_SYSTEM_LOOP_SAFETY_FILE",
    summary: "Replace the loop-safety paragraph",
    description: ["or --system-loop-safety-file <path>, or --no-system-loop-safety"],
  },
  {
    flag: "system-tool-output-conventions",
    env: "MINIMAL_AGENT_SYSTEM_TOOL_OUTPUT_CONVENTIONS",
    fileEnv: "MINIMAL_AGENT_SYSTEM_TOOL_OUTPUT_CONVENTIONS_FILE",
    summary: "Replace the tool-output-conventions paragraph",
    description: [
      "or --system-tool-output-conventions-file <path>, or --no-system-tool-output-conventions",
    ],
  },
  {
    flag: "system-session-context",
    env: "MINIMAL_AGENT_SYSTEM_SESSION_CONTEXT",
    fileEnv: "MINIMAL_AGENT_SYSTEM_SESSION_CONTEXT_FILE",
    summary: "Replace the session-context block (plugin prompts)",
    description: ["or --system-session-context-file <path>, or --no-system-session-context"],
  },
  {
    flag: "provider-system-preamble",
    env: "MINIMAL_AGENT_PROVIDER_SYSTEM_PREAMBLE",
    fileEnv: "MINIMAL_AGENT_PROVIDER_SYSTEM_PREAMBLE_FILE",
    summary: "Replace the provider-owned preamble (requires --unsafe-system-prompt-overrides)",
    description: ["or --provider-system-preamble-file <path>, or --no-provider-system-preamble"],
  },
]

/** FlagSpec.group of every system-prompt flag. */
const GROUP = "system-prompt"

/** The three FlagSpecs of one part: value (visible), `-file` and `no-` (hidden). */
function partFlags(part: SystemPromptPartData): FlagSpec[] {
  return [
    {
      name: part.flag,
      type: "string",
      value: "required",
      valueName: "text",
      env: part.env,
      summary: part.summary,
      description: part.description,
      group: GROUP,
      global: true,
    },
    {
      name: `${part.flag}-file`,
      type: "string",
      value: "required",
      valueName: "path",
      env: part.fileEnv,
      summary: `Read the --${part.flag} text from a file`,
      group: GROUP,
      hidden: true,
      global: true,
    },
    {
      name: `no-${part.flag}`,
      type: "boolean",
      value: "none",
      summary: `Omit the part that --${part.flag} replaces`,
      group: GROUP,
      hidden: true,
      global: true,
    },
  ]
}

/** Every system-prompt override FlagSpec, in root help order. */
export const SYSTEM_PROMPT_FLAGS: readonly FlagSpec[] = [
  ...PARTS.flatMap(partFlags),
  {
    name: "unsafe-system-prompt-overrides",
    type: "boolean",
    value: "none",
    summary: "Allow provider preamble replacement/omission",
    description: ["without this flag, provider preamble overrides are rejected"],
    group: GROUP,
    global: true,
  },
]

/**
 * The system-prompt env names, hidden. Root help shows them through one
 * wildcard row, `MINIMAL_AGENT_SYSTEM_*` (legacy override 4, plan 2.4).
 */
export const SYSTEM_PROMPT_ENV: readonly BuiltinEnvSpec[] = PARTS.flatMap((part) => [
  {
    name: part.env,
    summary: `Same as --${part.flag}; empty = omit`,
    flag: part.flag,
    hidden: true,
  },
  {
    name: part.fileEnv,
    summary: `Same as --${part.flag}-file`,
    flag: `${part.flag}-file`,
    hidden: true,
  },
])
