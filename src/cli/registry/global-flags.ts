/**
 * Global FlagSpecs: flags that apply to every command path (plan M-8a, 2.3).
 *
 * The flags sit in blocks by `FlagSpec.group` (ids in `groups.ts`). Summaries
 * and notes are copied from the root help text in `src/startup/help.ts`, so
 * M-8c can rebuild root help byte-identical. Long notes sit in `description`
 * for now. M-8d rewrites them (lead decision 2).
 *
 * `value` is the TRUE arity, read from the parser (`src/cli/parse-argv.ts`,
 * `src/main.ts`, `src/startup/run-subcommand.ts`), not from the hand-kept
 * arity sets in `src/cli/extract-prompt.ts` (lead decision 6). Long flags
 * whose true arity differs from `FLAGS_WITH_VALUES` / `FLAGS_NO_VALUE`
 * (M-12, V-18 owns the fix):
 *
 *   - `--parallel` (auth-status command flag): required value, in neither set.
 *     Possible live bug: `auth-status plan --parallel 8` may leak "8" as a
 *     prompt (IMPL-PROGRESS lead decision 6).
 *   - `--fast`, `--json`, `--diagnostics`: no value, in neither set.
 *   - `--dump-paths`, `--table`, `--dry-run`, `--force`, `--all` (command
 *     flags): no value, in neither set.
 *   - `--usage` (alias `--usage-stats`): optional value
 *     (`valueAfter`, parse-argv.ts:319), in neither set.
 *   - `--list-models`, `--list-models-live`, `--sessions`: optional value
 *     (`valueAfter`, parse-argv.ts:241, 316), listed in `FLAGS_NO_VALUE`.
 *
 * `registry-definition.test.ts` pins this list.
 *
 * @module cli/registry/global-flags
 */

import type { FlagSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { SYSTEM_PROMPT_FLAGS } from "./system-prompt-flags.ts"

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

/** `--provider <id>`. Exported: `auth-status refresh` reads it by reference. */
export const PROVIDER_FLAG: FlagSpec = {
  name: "provider",
  type: "string",
  value: "required",
  valueName: "id",
  env: "MINIMAL_AGENT_PROVIDER",
  summary: "Select provider for --model",
  description: ["else MINIMAL_AGENT_PROVIDER, config provider"],
  group: "model",
  global: true,
}

const MODEL_FLAGS: readonly FlagSpec[] = [
  {
    name: "model",
    short: "m",
    type: "string",
    value: "required",
    valueName: "id",
    env: "MINIMAL_AGENT_MODEL",
    summary: "Select model",
    description: ["requires --provider, else MINIMAL_AGENT_MODEL, config model"],
    group: "model",
    global: true,
  },
  PROVIDER_FLAG,
  {
    name: "effort",
    short: "e",
    type: "string",
    value: "required",
    valueName: "level",
    env: "MINIMAL_AGENT_EFFORT",
    summary: "Reasoning effort: low, medium, high, xhigh, max",
    description: ["or MINIMAL_AGENT_EFFORT"],
    group: "model",
    global: true,
  },
  {
    name: "fast",
    short: "F",
    type: "boolean",
    value: "none",
    env: "MINIMAL_AGENT_FAST",
    summary: "Fast-mode dispatch",
    description: [
      'speed:"fast", fast-capable models only, ~2.5x tok/s, ~2x cost, or MINIMAL_AGENT_FAST=1',
    ],
    group: "model",
    global: true,
  },
  {
    name: "thinking-display",
    type: "string",
    value: "required",
    valueName: "mode",
    choices: ["summarized", "omitted"],
    env: "MINIMAL_AGENT_THINKING_DISPLAY",
    summary: "Force thinking display: summarized or omitted",
    description: ["or MINIMAL_AGENT_THINKING_DISPLAY"],
    group: "model",
    global: true,
  },
  {
    name: "cache-ttl",
    type: "string",
    value: "required",
    valueName: "5m|1h",
    choices: ["5m", "1h"],
    default: "5m",
    env: "MINIMAL_AGENT_CACHE_TTL",
    summary: "Prompt-cache breakpoint TTL",
    description: ["default: 5m, or MINIMAL_AGENT_CACHE_TTL, config cacheTtl"],
    group: "model",
    global: true,
  },
  {
    name: "service-tier",
    type: "string",
    value: "required",
    valueName: "tier",
    env: "MINIMAL_AGENT_SERVICE_TIER",
    summary: "Provider service tier (auto, default, flex, scale, priority)",
    description: ["or MINIMAL_AGENT_SERVICE_TIER"],
    group: "model",
    global: true,
  },
  {
    name: "credential-name",
    type: "string",
    value: "required",
    valueName: "name",
    env: "MINIMAL_AGENT_CREDENTIAL_NAME",
    summary: "Select a stored credential by name",
    description: [
      "use when the provider has multiple credentials (e.g. Work and Personal)",
      "or MINIMAL_AGENT_CREDENTIAL_NAME, config credentialName",
      "--resume reuses the session pin only for the same provider",
    ],
    group: "model",
    global: true,
  },
]

// ---------------------------------------------------------------------------
// endpoint
// ---------------------------------------------------------------------------

const ENDPOINT_FLAGS: readonly FlagSpec[] = [
  {
    name: "endpoint",
    type: "string",
    value: "required",
    valueName: "url",
    env: "MINIMAL_AGENT_ENDPOINT",
    summary: "Generic endpoint URL",
    description: ["use with --provider generic-endpoint, or MINIMAL_AGENT_ENDPOINT"],
    group: "endpoint",
    global: true,
  },
  {
    name: "format",
    aliases: ["surface"],
    type: "string",
    value: "required",
    valueName: "id",
    env: "MINIMAL_AGENT_FORMAT",
    summary: "Generic endpoint surface",
    description: ["a registered wire surface, or MINIMAL_AGENT_FORMAT"],
    group: "endpoint",
    global: true,
  },
  {
    name: "auth-type",
    type: "string",
    value: "required",
    valueName: "type",
    choices: ["api-key", "bearer", "none", "custom-header"],
    env: "MINIMAL_AGENT_AUTH_TYPE",
    summary: "Generic endpoint auth",
    description: ["api-key | bearer | none | custom-header, or MINIMAL_AGENT_AUTH_TYPE"],
    group: "endpoint",
    global: true,
  },
  {
    name: "api-key",
    type: "string",
    value: "required",
    valueName: "key",
    env: "MINIMAL_AGENT_API_KEY",
    summary: "Generic endpoint key/token",
    description: ["or MINIMAL_AGENT_API_KEY"],
    group: "endpoint",
    global: true,
  },
  {
    name: "auth-header",
    type: "string",
    value: "required",
    valueName: "name",
    env: "MINIMAL_AGENT_AUTH_HEADER",
    summary: "Custom auth header name",
    description: ["for --auth-type custom-header, or MINIMAL_AGENT_AUTH_HEADER"],
    group: "endpoint",
    global: true,
  },
  {
    name: "provider-model",
    type: "string",
    value: "required",
    valueName: "id",
    env: "MINIMAL_AGENT_PROVIDER_MODEL",
    summary: "Wire model id override",
    description: ["separate from local --model, or MINIMAL_AGENT_PROVIDER_MODEL"],
    group: "endpoint",
    global: true,
  },
  {
    name: "effort-levels",
    type: "string",
    value: "required",
    valueName: "levels",
    env: "MINIMAL_AGENT_EFFORT_LEVELS",
    summary: "Generic endpoint effort ladder",
    description: [
      'comma-separated, e.g. "low,medium,high", lets --effort pass through',
      "or MINIMAL_AGENT_EFFORT_LEVELS",
    ],
    group: "endpoint",
    global: true,
  },
]

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

const OUTPUT_FLAGS: readonly FlagSpec[] = [
  {
    name: "prompt",
    short: "p",
    type: "string",
    value: "required",
    valueName: "text",
    summary: "Non-interactive: send prompt, print, exit",
    group: "output",
    global: true,
  },
  {
    name: "output-format",
    type: "string",
    value: "required",
    valueName: "text|json|stream-json",
    choices: ["text", "json", "stream-json"],
    default: "text",
    summary: "Non-interactive output",
    description: [
      "text is human output; json is buffered JSONL; stream-json flushes JSONL events live",
      "--json is an alias for --output-format json",
      "json, stream-json: stdout carries only JSON lines; a stray write fails the run",
    ],
    group: "output",
    global: true,
  },
  {
    // A boolean alias of `--output-format json`, so it is its own spec, not
    // an `aliases` entry (an alias would take a value).
    name: "json",
    type: "boolean",
    value: "none",
    summary: "Alias for --output-format json",
    group: "output",
    hidden: true,
    global: true,
  },
  {
    name: "diagnostics",
    type: "boolean",
    value: "none",
    summary: "With --output-format json, also write diagnostics",
    description: ['each line is a session log entry with ch "event" or "diag"'],
    group: "output",
    global: true,
  },
  {
    name: "output-schema",
    type: "string",
    value: "required",
    valueName: "file",
    summary: "Constrain the final answer to a JSON Schema",
    description: [
      "run exits non-zero if the answer is absent or non-conforming",
      "enforces a SUBSET: type, required, properties, additionalProperties, items, enum (deep-equal)",
      "accepted but NOT enforced: minimum/maxLength/pattern/anyOf/oneOf/allOf/not/$ref/format/const, don't rely on them",
    ],
    group: "output",
    global: true,
  },
  {
    name: "formatter",
    short: "f",
    type: "string",
    value: "required",
    valueName: "cmd",
    default: "mdstream",
    summary: "Pipe output through formatter",
    description: ["default: mdstream"],
    group: "output",
    global: true,
  },
  {
    name: "formatter-args",
    type: "string",
    value: "required",
    valueName: "args",
    env: "MINIMAL_AGENT_FORMATTER_ARGS",
    summary: "Extra args appended to the formatter",
    description: ['e.g. "--table-fit", or MINIMAL_AGENT_FORMATTER_ARGS'],
    group: "output",
    global: true,
  },
  {
    name: "spinner",
    short: "s",
    type: "string",
    value: "required",
    valueName: "preset",
    env: "MINIMAL_AGENT_SPINNER",
    summary: "Pick a status spinner preset",
    description: ["see --list-spinners"],
    group: "output",
    global: true,
  },
  {
    name: "header",
    type: "boolean",
    value: "none",
    negatable: true,
    env: "MINIMAL_AGENT_HEADER",
    summary: "Force startup tree on/off",
    description: ["default: hidden in non-interactive"],
    group: "output",
    global: true,
  },
  {
    name: "no-color",
    type: "boolean",
    value: "none",
    summary: "Print this help with no color",
    description: [
      "help is also plain when NO_COLOR is set and not empty, TERM=dumb, or output is not a TTY",
    ],
    group: "output",
    global: true,
  },
  {
    name: "show-hidden-chars",
    type: "boolean",
    value: "none",
    env: "MINIMAL_AGENT_SHOW_HIDDEN_CHARS",
    summary: "Reveal spaces/tabs/newlines as faint glyphs",
    group: "output",
    global: true,
  },
]

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const TOOLS_FLAGS: readonly FlagSpec[] = [
  {
    name: "mode",
    type: "string",
    value: "required",
    valueName: "id|none",
    env: "MINIMAL_AGENT_MODE",
    summary: "Initial mode",
    description: ["default: ask in non-interactive, plugin default otherwise"],
    group: "tools",
    global: true,
  },
  {
    // `--tools` takes a value and the parser has no `--no-tools` negation of
    // it, so `no-tools` is its own spec (plan 2.3 note).
    name: "tools",
    type: "string",
    value: "required",
    valueName: "names",
    summary: "Advertise only these tools",
    description: [
      'comma-separated allow-list, e.g. --tools "WebSearch,Task"',
      "model only sees listed tools; checked before mode permissions",
    ],
    group: "tools",
    global: true,
  },
  {
    name: "no-tools",
    type: "boolean",
    value: "none",
    summary: "Advertise no tools (pure Q&A)",
    description: ["empty tools array on the request; checked before mode permissions"],
    group: "tools",
    global: true,
  },
]

// ---------------------------------------------------------------------------
// plugins
// ---------------------------------------------------------------------------

/** `--disable-plugin <id>`. Exported: the `plugins` command reads it by reference. */
export const DISABLE_PLUGIN_FLAG: FlagSpec = {
  name: "disable-plugin",
  type: "string",
  value: "required",
  valueName: "id",
  multiple: true,
  env: "MINIMAL_AGENT_DISABLE_PLUGINS",
  summary: "Skip a plugin for this run",
  description: ["repeatable, comma-separated ok, see plugins list"],
  group: "plugins",
  global: true,
}

/** `--enable-plugin <id>`. Exported: the `plugins` command reads it by reference. */
export const ENABLE_PLUGIN_FLAG: FlagSpec = {
  name: "enable-plugin",
  type: "string",
  value: "required",
  valueName: "id",
  multiple: true,
  env: "MINIMAL_AGENT_ENABLE_PLUGINS",
  summary: "Force-enable a plugin for this run",
  description: ["overrides config + manifest opt-out"],
  group: "plugins",
  global: true,
}

const PLUGINS_FLAGS: readonly FlagSpec[] = [
  DISABLE_PLUGIN_FLAG,
  ENABLE_PLUGIN_FLAG,
  {
    name: "no-agents-md",
    aliases: ["no-agents"],
    type: "boolean",
    value: "none",
    env: "MINIMAL_AGENT_NO_AGENTS_MD",
    summary: "Skip AGENTS.md injection",
    description: ["alias for --disable-plugin agents-md, or MINIMAL_AGENT_NO_AGENTS_MD=1"],
    group: "plugins",
    global: true,
  },
  {
    name: "platform",
    type: "string",
    value: "required",
    valueName: "os",
    choices: ["macos", "linux", "windows", "all"],
    env: "MINIMAL_AGENT_PLATFORM",
    summary: "Override platform for plugin/tool gating: macos, linux, windows, all",
    description: ["or MINIMAL_AGENT_PLATFORM"],
    group: "plugins",
    global: true,
  },
  {
    name: "host-mode",
    type: "string",
    value: "required",
    valueName: "id",
    summary: "Hand the process to a plugin host mode (e.g. acp)",
    description: [
      "needs a loaded, enabled plugin that declares that hostModes[] id",
      "stdin/stdout carry the protocol",
      "logs go to stderr",
      "every arg after the id goes to the host mode",
      "cannot be combined with --prompt, -p, or a stdin prompt",
    ],
    group: "plugins",
    global: true,
  },
]

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

const SESSION_FLAGS: readonly FlagSpec[] = [
  {
    name: "session-id",
    type: "string",
    value: "required",
    valueName: "uuid",
    env: "MINIMAL_AGENT_SESSION_ID",
    summary: "Pin this run's session id",
    description: ["else MINIMAL_AGENT_SESSION_ID, else random"],
    group: "session",
    global: true,
  },
  {
    // The flag form of `resume <sid|last>`. Root help shows the command row.
    name: "resume",
    short: "r",
    type: "string",
    value: "required",
    valueName: "sid|last",
    summary: "Resume a saved session",
    group: "session",
    hidden: true,
    global: true,
  },
  {
    // The flag form of `resume-same <sid|last>`.
    name: "resume-same-sid",
    type: "string",
    value: "required",
    valueName: "sid|last",
    summary: "Resume in place, keeping the same session id",
    group: "session",
    hidden: true,
    global: true,
  },
]

// ---------------------------------------------------------------------------
// debug
// ---------------------------------------------------------------------------

const DEBUG_FLAGS: readonly FlagSpec[] = [
  {
    name: "debug",
    short: "d",
    type: "boolean",
    value: "none",
    env: "DEBUG",
    summary: "Enable debug logging",
    description: ["or DEBUG=1", "outside the REPL, also mirror diagnostics to stderr"],
    group: "debug",
    global: true,
  },
  {
    name: "verbose",
    short: "v",
    type: "boolean",
    value: "none",
    env: "VERBOSE",
    summary: "Don't truncate debug output",
    description: ["or VERBOSE=1"],
    group: "debug",
    global: true,
  },
  {
    name: "skip-quota",
    type: "boolean",
    value: "none",
    env: "MINIMAL_AGENT_SKIP_QUOTA",
    summary: "Skip startup quota check",
    description: ["or MINIMAL_AGENT_SKIP_QUOTA=1"],
    group: "debug",
    global: true,
  },
]

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

/** `-h, --help`. `--all` waits for M-10 (R-12). */
export const HELP_FLAG: FlagSpec = {
  name: "help",
  short: "h",
  type: "boolean",
  value: "none",
  summary: "Show this help",
  group: "help",
  global: true,
}

// ---------------------------------------------------------------------------
// command-forms: the legacy flag forms of commands, all hidden
// ---------------------------------------------------------------------------

/** One hidden command-form flag. */
function commandForm(
  name: string,
  summary: string,
  extra: Partial<Pick<FlagSpec, "aliases" | "type" | "value" | "valueName">> = {},
): FlagSpec {
  return {
    name,
    type: "boolean",
    value: "none",
    ...extra,
    summary,
    group: "command-forms",
    hidden: true,
    global: true,
  }
}

const COMMAND_FORM_FLAGS: readonly FlagSpec[] = [
  commandForm("list-models", "Same as providers models [<id>]", {
    aliases: ["models", "list-model"],
    type: "string",
    value: "optional",
    valueName: "id",
  }),
  commandForm("list-models-live", "Same as providers models-live [<id>]", {
    aliases: ["models-live", "list-model-live"],
    type: "string",
    value: "optional",
    valueName: "id",
  }),
  commandForm("list-providers", "Same as providers", { aliases: ["providers"] }),
  commandForm("list-flags", "Same as flags", { aliases: ["flags", "list-flag"] }),
  commandForm("list-plugins", "Same as plugins", { aliases: ["plugins", "list-plugin"] }),
  commandForm("list-spinners", "Same as spinners", { aliases: ["spinners", "list-spinner"] }),
  commandForm("sessions", "Same as sessions [<query>]", {
    aliases: ["session", "list-sessions"],
    type: "string",
    value: "optional",
    valueName: "query",
  }),
  commandForm("usage", "Same as usage [<period>]", {
    aliases: ["usage-stats"],
    type: "string",
    value: "optional",
    valueName: "period",
  }),
  commandForm("dump", "Same as sessions dump <sid|last>", {
    type: "string",
    value: "required",
    valueName: "sid|last",
  }),
  commandForm("login", "Same as login"),
  commandForm("logout", "Same as logout"),
  commandForm("auth-status", "Same as auth-status"),
]

/** Every global FlagSpec, in blocks by `FlagSpec.group` (plan 2.3 order). */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  ...MODEL_FLAGS,
  ...ENDPOINT_FLAGS,
  ...OUTPUT_FLAGS,
  ...TOOLS_FLAGS,
  ...PLUGINS_FLAGS,
  ...SESSION_FLAGS,
  ...SYSTEM_PROMPT_FLAGS,
  ...DEBUG_FLAGS,
  HELP_FLAG,
  ...COMMAND_FORM_FLAGS,
]
