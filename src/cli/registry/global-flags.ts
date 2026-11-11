/**
 * Global FlagSpecs: flags that apply to every command path (plan M-8a, 2.3).
 *
 * The flags sit in blocks by `FlagSpec.group` (ids in `groups.ts`). Root
 * help shows the one-line `summary` (no closing period), plus notes made
 * from `default`, `choices`, and `env`. Longer text sits in `description`
 * (full sentences), which root help does not print (R-13, plan M-8d). Do
 * not repeat the env name in the text: help adds it from `env`.
 *
 * `value` is the TRUE arity, read from the parser (`src/cli/parse-argv.ts`,
 * `src/main.ts`, `src/startup/run-subcommand.ts`). Since M-12 the parser
 * arity sets (`FLAGS_WITH_VALUES` / `FLAGS_NO_VALUE` in
 * `src/cli/extract-prompt.ts`) and the alias maps (`SHORT_TO_LONG` /
 * `LONG_ALIAS` in `src/cli/cli-args.ts`) are derived from this registry by
 * `./arity.ts`. So `value`, `short`, and the command-form `aliases` here
 * drive the parse:
 *
 *   - `required`: in `FLAGS_WITH_VALUES`. The prompt scan skips the value.
 *   - `none`: in `FLAGS_NO_VALUE`.
 *   - `optional` (`--list-models`, `--list-models-live`, `--sessions`,
 *     `--usage`): in `FLAGS_NO_VALUE` (spec M-12). `parse-argv.ts` reads the
 *     value with `valueAfter`.
 *
 * The gaps that M-12 fixed (`arity.test.ts`, V-18): `--parallel` was in
 * neither set, so `--parallel 8 hello` gave the prompt "8". The booleans
 * `--fast`, `--json`, `--diagnostics`, `--dump-paths`, `--table`,
 * `--dry-run`, `--force`, `--all` and the optional `--usage` were in
 * neither set (no scan change: the scan never takes a `--` token as a
 * prompt). `--dry-run` was then only the `auth-status prune` flag. It is
 * now also a global flag (below, group plugins). The prune command still
 * reads its own `--dry-run`.
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
  summary: "Select the provider for --model",
  description: ["Else the env value, then the config key provider."],
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
    summary: "Select the model",
    description: ["Needs --provider. Else the env value, then the config key model."],
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
    group: "model",
    global: true,
  },
  {
    name: "fast",
    short: "F",
    type: "boolean",
    value: "none",
    env: "MINIMAL_AGENT_FAST",
    summary: "Fast-mode dispatch on fast-capable models",
    description: ['Sends speed:"fast". About 2.5x tokens per second at about 2x cost.'],
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
    summary: "Force the thinking display mode",
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
    description: ["Else the env value, then the config key cacheTtl."],
    group: "model",
    global: true,
  },
  {
    name: "service-tier",
    type: "string",
    value: "required",
    valueName: "tier",
    env: "MINIMAL_AGENT_SERVICE_TIER",
    summary: "Provider service tier: auto, default, flex, scale, priority",
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
      "Use it when the provider has more than one credential, for example Work and Personal.",
      "Else the env value, then the config key credentialName.",
      "--resume reuses the session pin only for the same provider.",
    ],
    group: "model",
    global: true,
  },
  {
    // Hidden until SPEC-ONESHOT wires the parse site. Remove `hidden` in the same commit that wires it.
    name: "temperature",
    type: "number",
    value: "required",
    valueName: "n",
    env: "MINIMAL_AGENT_TEMPERATURE",
    summary: "Sampling temperature",
    description: ["Ignored with a warning when the model does not accept it."],
    group: "model",
    hidden: true,
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
    description: ["Use with --provider generic-endpoint."],
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
    summary: "Generic endpoint wire surface",
    description: ["A registered wire surface id."],
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
    summary: "Generic endpoint auth type",
    group: "endpoint",
    global: true,
  },
  {
    name: "api-key",
    type: "string",
    value: "required",
    valueName: "key",
    env: "MINIMAL_AGENT_API_KEY",
    summary: "Generic endpoint key or token",
    group: "endpoint",
    global: true,
  },
  {
    name: "auth-header",
    type: "string",
    value: "required",
    valueName: "name",
    env: "MINIMAL_AGENT_AUTH_HEADER",
    summary: "Auth header name for --auth-type custom-header",
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
    description: ["Separate from the local --model."],
    group: "endpoint",
    global: true,
  },
  {
    name: "effort-levels",
    type: "string",
    value: "required",
    valueName: "levels",
    env: "MINIMAL_AGENT_EFFORT_LEVELS",
    summary: "Generic endpoint effort ladder, comma-separated",
    description: ['For example "low,medium,high". It lets --effort pass through.'],
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
    summary: "Non-interactive: send the prompt, print, exit",
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
    summary: "Non-interactive output format, --json is short for json",
    description: [
      "text is human output. json is buffered JSONL. stream-json writes JSONL events live.",
      "--json is an alias for --output-format json.",
      "With json and stream-json, stdout carries only JSON lines. A stray write fails the run.",
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
    description: ['Each line is a session log entry with ch "event" or "diag".'],
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
      "The run exits non-zero when the answer is absent or does not match.",
      "Enforced keywords: type, required, properties, additionalProperties, items, enum (deep-equal).",
      "Accepted but not enforced: minimum, maxLength, pattern, anyOf, oneOf, allOf, not, $ref, format, const.",
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
    summary: "Pipe output through a formatter command",
    group: "output",
    global: true,
  },
  {
    name: "formatter-args",
    type: "string",
    value: "required",
    valueName: "args",
    env: "MINIMAL_AGENT_FORMATTER_ARGS",
    summary: "Extra formatter args, for example --table-fit",
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
    summary: "Pick a status spinner preset, see spinners",
    group: "output",
    global: true,
  },
  {
    name: "header",
    type: "boolean",
    value: "none",
    negatable: true,
    env: "MINIMAL_AGENT_HEADER",
    summary: "Force the startup tree on or off",
    description: ["Default: hidden in non-interactive runs."],
    group: "output",
    global: true,
  },
  {
    name: "no-color",
    type: "boolean",
    value: "none",
    summary: "Print help with no color, as do NO_COLOR and TERM=dumb",
    description: [
      "Help is also plain when NO_COLOR is set and not empty, TERM=dumb, or output is not a TTY.",
    ],
    group: "output",
    global: true,
  },
  {
    name: "show-hidden-chars",
    type: "boolean",
    value: "none",
    env: "MINIMAL_AGENT_SHOW_HIDDEN_CHARS",
    summary: "Show spaces, tabs, and newlines as faint glyphs",
    group: "output",
    global: true,
  },
  {
    // Hidden until SPEC-ONESHOT wires the parse site. Remove `hidden` in the same commit that wires it.
    name: "strict",
    type: "boolean",
    value: "none",
    summary: "Ask the provider to enforce --output-schema",
    description: ["The provider plugin skips it when the model cannot enforce a schema."],
    group: "output",
    hidden: true,
    global: true,
  },
  {
    // Hidden until SPEC-ONESHOT wires the parse site. Remove `hidden` in the same commit that wires it.
    name: "schema-retries",
    type: "number",
    value: "required",
    valueName: "n",
    default: 0,
    summary: "Retry when the answer does not match --output-schema",
    group: "output",
    hidden: true,
    global: true,
  },
  {
    // Hidden until SPEC-ONESHOT wires the parse site. Remove `hidden` in the same commit that wires it.
    name: "input-format",
    type: "string",
    value: "required",
    valueName: "format",
    choices: ["text", "open-responses"],
    default: "text",
    summary: "Read the run request from stdin in this format",
    group: "output",
    hidden: true,
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
    summary: "Initial mode id, or none",
    description: ["Default: ask in non-interactive runs, else the plugin default."],
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
    summary: "Advertise only these tools, comma-separated",
    description: [
      'For example --tools "WebSearch,Task".',
      "The model only sees the listed tools. Checked before mode permissions.",
    ],
    group: "tools",
    global: true,
  },
  {
    name: "no-tools",
    type: "boolean",
    value: "none",
    summary: "Advertise no tools, for pure Q&A",
    description: ["Sends an empty tools array. Checked before mode permissions."],
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
  summary: "Skip a plugin for this run, repeatable",
  description: ["A comma-separated list is also accepted. See plugins list."],
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
  summary: "Force-enable a plugin for this run, repeatable",
  description: ["Overrides the config and the manifest opt-out."],
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
    summary: "Skip AGENTS.md injection, same as --disable-plugin agents-md",
    group: "plugins",
    global: true,
  },
  {
    name: "dry-run",
    type: "boolean",
    value: "none",
    env: "MINIMAL_AGENT_DRY_RUN",
    summary:
      "Build the request, print it as JSON, do not send it (same as --enable-plugin dry-run)",
    group: "plugins",
    global: true,
  },
  // Plugin prompt-TEXT suppression. Every flag here has UNAMBIGUOUS arity:
  // the CLI takes a bare positional prompt, so an optional-value flag would
  // swallow the prompt text.
  {
    name: "no-plugin-prompts",
    type: "boolean",
    value: "none",
    // The env name sits on THIS flag because its `1`/`true` means the same
    // thing (`resolvePluginPromptSuppression` in core reads it that way).
    // `0`/`false` is the `--plugin-prompts` side.
    env: "MINIMAL_AGENT_PLUGIN_PROMPTS",
    summary: "Suppress all plugin prompt text",
    description: [
      "A suppressed plugin still loads and still advertises its tools.",
      "Only its prompt text is dropped. Env 1 or true does the same.",
    ],
    group: "plugins",
    global: true,
  },
  {
    name: "plugin-prompts",
    type: "boolean",
    value: "none",
    summary: "Keep all plugin prompt text on, per id use --plugin-prompts-for",
    description: ["Same as env 0 or false. A config suppress list still applies."],
    group: "plugins",
    global: true,
  },
  {
    name: "no-plugin-prompts-for",
    type: "string",
    value: "required",
    valueName: "id",
    multiple: true,
    summary: "Suppress the prompt text of these plugins only",
    description: ["Repeatable. A comma-separated list is also accepted."],
    group: "plugins",
    global: true,
  },
  {
    name: "plugin-prompts-for",
    type: "string",
    value: "required",
    valueName: "id",
    multiple: true,
    summary: "Keep the prompt text of these plugins on",
    description: ["Repeatable. A keep wins over --no-plugin-prompts for the same id."],
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
    summary: "Override the platform for plugin and tool gating",
    group: "plugins",
    global: true,
  },
  {
    name: "host-mode",
    type: "string",
    value: "required",
    valueName: "id",
    summary: "Hand the process to a plugin host mode, for example acp",
    description: [
      "Needs a loaded, enabled plugin that declares that hostModes[] id.",
      "stdin and stdout carry the protocol. Logs go to stderr.",
      "Every arg after the id goes to the host mode.",
      "Cannot be combined with --prompt, -p, or a stdin prompt.",
    ],
    group: "plugins",
    global: true,
  },
  {
    // Hidden until SPEC-ONESHOT wires the parse site. Remove `hidden` in the same commit that wires it.
    name: "bare",
    type: "boolean",
    value: "none",
    summary: "Load only the provider plugin and skip AGENTS.md",
    description: ["For fast one-shot runs."],
    group: "plugins",
    hidden: true,
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
    summary: "Pin the session id of this run",
    description: ["Else the env value, else a random id."],
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
// system-prompt: the append flags (SPEC-ONESHOT R8)
// ---------------------------------------------------------------------------

/**
 * The append flags. They sit here, not in `system-prompt-flags.ts`: they
 * are not core override keys, so the name match with the parser override
 * specs does not include them.
 */
const APPEND_SYSTEM_PROMPT_FLAGS: readonly FlagSpec[] = [
  {
    // Hidden until SPEC-ONESHOT wires the parse site. Remove `hidden` in the same commit that wires it.
    name: "append-system-prompt",
    type: "string",
    value: "required",
    valueName: "text",
    summary: "Add text after the base instructions",
    group: "system-prompt",
    hidden: true,
    global: true,
  },
  {
    // Hidden until SPEC-ONESHOT wires the parse site. Remove `hidden` in the same commit that wires it.
    name: "append-system-prompt-file",
    type: "string",
    value: "required",
    valueName: "path",
    summary: "Read text to add after the base instructions from a file",
    group: "system-prompt",
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
    description: ["Outside the REPL, also mirror diagnostics to stderr."],
    group: "debug",
    global: true,
  },
  {
    name: "verbose",
    short: "v",
    type: "boolean",
    value: "none",
    env: "VERBOSE",
    summary: "Do not truncate debug output",
    group: "debug",
    global: true,
  },
  {
    name: "skip-quota",
    type: "boolean",
    value: "none",
    env: "MINIMAL_AGENT_SKIP_QUOTA",
    summary: "Skip the startup quota check",
    group: "debug",
    global: true,
  },
]

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

/** `-h, --help`. With `--help`, `--all` also lists disabled and hidden entries (R-12). */
export const HELP_FLAG: FlagSpec = {
  name: "help",
  short: "h",
  type: "boolean",
  value: "none",
  summary: "Show help",
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
  ...APPEND_SYSTEM_PROMPT_FLAGS,
  ...DEBUG_FLAGS,
  HELP_FLAG,
  ...COMMAND_FORM_FLAGS,
]
