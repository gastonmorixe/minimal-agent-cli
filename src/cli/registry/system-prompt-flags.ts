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
 * both hidden (so the drift test and M-12 still see them). Root help names
 * the hidden forms in the row of the value flag. Order is the root help
 * order, not the core key-spec order.
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
  /** One-line summary of the value flag. */
  readonly summary: string
}

/** The override parts, in root help order. */
const PARTS: readonly SystemPromptPartData[] = [
  {
    flag: "system-prompt",
    env: "MINIMAL_AGENT_SYSTEM_PROMPT",
    fileEnv: "MINIMAL_AGENT_SYSTEM_PROMPT_FILE",
    summary: "Replace the whole core-controllable system prompt",
  },
  {
    flag: "system-identity",
    env: "MINIMAL_AGENT_SYSTEM_IDENTITY",
    fileEnv: "MINIMAL_AGENT_SYSTEM_IDENTITY_FILE",
    summary: "Replace the neutral identity block",
  },
  {
    flag: "system-instructions",
    env: "MINIMAL_AGENT_SYSTEM_INSTRUCTIONS",
    fileEnv: "MINIMAL_AGENT_SYSTEM_INSTRUCTIONS_FILE",
    summary: "Replace the base instructions block",
  },
  {
    flag: "system-tool-output-conventions",
    env: "MINIMAL_AGENT_SYSTEM_TOOL_OUTPUT_CONVENTIONS",
    fileEnv: "MINIMAL_AGENT_SYSTEM_TOOL_OUTPUT_CONVENTIONS_FILE",
    summary: "Replace the tool-output-conventions paragraph",
  },
  {
    flag: "system-session-context",
    env: "MINIMAL_AGENT_SYSTEM_SESSION_CONTEXT",
    fileEnv: "MINIMAL_AGENT_SYSTEM_SESSION_CONTEXT_FILE",
    summary: "Replace the session-context block of plugin prompts",
  },
  {
    flag: "provider-system-preamble",
    env: "MINIMAL_AGENT_PROVIDER_SYSTEM_PREAMBLE",
    fileEnv: "MINIMAL_AGENT_PROVIDER_SYSTEM_PREAMBLE_FILE",
    summary: "Replace the provider preamble, needs --unsafe-system-prompt-overrides",
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
      description: [
        `Read the text from a file with --${part.flag}-file <path>. Omit the part with --no-${part.flag}.`,
      ],
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
    summary: "Allow a provider preamble override or omission",
    description: ["Without this flag, provider preamble overrides are rejected."],
    group: GROUP,
    global: true,
  },
]

/**
 * The system-prompt env names, hidden. Root help shows each one in the
 * row of its flag, and the wildcard row `MINIMAL_AGENT_SYSTEM_*` in env.ts
 * points at them.
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
