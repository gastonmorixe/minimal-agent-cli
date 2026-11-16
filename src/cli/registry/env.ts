/**
 * Built-in environment variables as registry data (plan M-8a, 2.1).
 *
 * The visible entries are the 44 rows of the root help ENVIRONMENT section,
 * in display order. `summary` is one line (no closing period). `set` is the
 * value that turns a switch on or off (16 rows), `default` the value when
 * unset, `flag` the FlagSpec a variable backs. Help makes notes from these
 * three fields, so the text does not repeat them. `description` holds
 * longer text that root help does not print (R-13, plan M-8d).
 *
 * The system-prompt override variables follow as hidden entries. The
 * wildcard row `MINIMAL_AGENT_SYSTEM_*` (the last visible entry) points at
 * them. Root help also shows each one in the row of its flag.
 *
 * @module cli/registry/env
 */

import { SYSTEM_PROMPT_ENV } from "./system-prompt-flags.ts"
import type { BuiltinEnvSpec } from "./types.ts"

/** The visible env rows, in root help order. */
const VISIBLE_ENV: readonly BuiltinEnvSpec[] = [
  {
    name: "DEBUG",
    set: "1",
    flag: "debug",
    summary: "Verbose request and response debug diagnostics",
    description: [
      "Writes to the session log file. Also to stderr with MINIMAL_AGENT_LOG_STDERR=1.",
    ],
  },
  { name: "MINIMAL_AGENT_LOG_STDERR", set: "1", summary: "Mirror every diagnostic to stderr" },
  {
    name: "MINIMAL_AGENT_TRANSPORT",
    default: "http2",
    summary: "Transport: http2 or fetch",
    description: ["Plaintext http:// auto-routes to HTTP/1.1."],
  },
  {
    name: "MINIMAL_AGENT_NO_PLAINTEXT_HTTP1",
    set: "1",
    summary: "Keep http:// on HTTP/2, no plaintext auto-route",
    description: ["Use it for an h2c-capable local server."],
  },
  {
    name: "MINIMAL_AGENT_ALLOW_FETCH_FALLBACK",
    set: "1",
    summary: "Allow fetch fallback after HTTP/2 failure",
  },
  {
    name: "MINIMAL_AGENT_NET_DBG",
    set: "1",
    summary: "Mirror raw HTTP traffic to ~/.minimal-agent/net-dbg/",
  },
  { name: "CLAUDE_CODE_EXTRA_METADATA", summary: "JSON object merged into metadata.user_id" },
  {
    name: "MINIMAL_AGENT_SPINNER",
    flag: "spinner",
    summary: "Spinner preset id",
  },
  {
    name: "MINIMAL_AGENT_EFFORT",
    flag: "effort",
    summary: "Reasoning effort",
  },
  {
    name: "MINIMAL_AGENT_FAST",
    set: "1",
    flag: "fast",
    summary: "Opt into fast-mode dispatch",
  },
  {
    name: "MINIMAL_AGENT_THINKING_DISPLAY",
    flag: "thinking-display",
    summary: "Force the thinking display mode",
  },
  {
    name: "MINIMAL_AGENT_FORMATTER_ARGS",
    flag: "formatter-args",
    summary: "Extra formatter args, shell-style",
  },
  {
    name: "MINIMAL_AGENT_CONFIG",
    default: "~/.minimal-agent/config.jsonc",
    summary: "Override the config path",
  },
  {
    name: "MINIMAL_AGENT_MODEL",
    flag: "model",
    summary: "Default model id",
  },
  {
    name: "MINIMAL_AGENT_PROVIDER",
    flag: "provider",
    summary: "Default provider id",
  },
  {
    name: "MINIMAL_AGENT_ENDPOINT",
    flag: "endpoint",
    summary: "Generic endpoint URL",
  },
  {
    name: "MINIMAL_AGENT_FORMAT",
    flag: "format",
    summary: "Generic endpoint surface id",
  },
  {
    name: "MINIMAL_AGENT_AUTH_TYPE",
    flag: "auth-type",
    summary: "Generic endpoint auth type",
  },
  {
    name: "MINIMAL_AGENT_API_KEY",
    flag: "api-key",
    summary: "Generic endpoint key or token",
  },
  {
    name: "MINIMAL_AGENT_AUTH_HEADER",
    flag: "auth-header",
    summary: "Custom auth header name",
  },
  {
    name: "MINIMAL_AGENT_PROVIDER_MODEL",
    flag: "provider-model",
    summary: "Wire model id override",
  },
  {
    name: "MINIMAL_AGENT_EFFORT_LEVELS",
    flag: "effort-levels",
    summary: "Generic endpoint effort ladder, comma-separated",
  },
  {
    name: "MINIMAL_AGENT_MEMORY_NAMESPACE",
    summary: "Namespace memory paths under namespaces/<ns>/",
    description: ["Read by the memory plugin."],
  },
  {
    name: "MINIMAL_AGENT_THEME",
    summary: "UI theme: dark, light, or high-contrast",
  },
  {
    name: "MINIMAL_AGENT_NO_LIVE_AREA",
    set: "1",
    summary: "Disable the live-area REPL",
    description: ["Falls back to the legacy raw input."],
  },
  {
    name: "MINIMAL_AGENT_HEADER",
    flag: "header",
    summary: "Force the startup tree: 0 or 1",
    description: ["Default: hidden in non-interactive runs."],
  },
  {
    name: "MINIMAL_AGENT_HEADER_FORMAT",
    flag: "header-format",
    summary: "Header template that replaces the startup tree",
  },
  {
    name: "MINIMAL_AGENT_MODE",
    flag: "mode",
    summary: "Initial mode id, or none",
  },
  {
    name: "MINIMAL_AGENT_CONTINUATION_PROMPT",
    default: "  ",
    summary: "Override the continuation-prompt prefix",
  },
  {
    name: "MINIMAL_AGENT_SHOW_HIDDEN_CHARS",
    set: "1",
    flag: "show-hidden-chars",
    summary: "Show spaces, tabs, and newlines as faint glyphs",
  },
  {
    name: "MINIMAL_AGENT_SKIP_QUOTA",
    set: "1",
    flag: "skip-quota",
    summary: "Skip the startup quota check",
  },
  {
    name: "MINIMAL_AGENT_NO_PLUGIN_SYNC",
    set: "1",
    summary: "Skip the first-run extended-plugins clone",
  },
  {
    name: "MINIMAL_AGENT_PLUGIN_SIBLINGS",
    summary: "Dev plugin checkout dirs, colon-separated",
    description: ["Default: ../minimal-agent-plugins next to the CLI repo."],
  },
  {
    name: "MINIMAL_AGENT_AUTO_ASK",
    set: "0",
    summary: "Turn off automatic ASK mode in the REPL",
    description: ["Or set the config key autoAsk to false."],
  },
  {
    name: "MINIMAL_AGENT_AUTO_COMPACT",
    set: "0",
    summary: "Turn off auto compact on a context overflow",
  },
  {
    name: "MINIMAL_AGENT_DISABLE_PLUGINS",
    flag: "disable-plugin",
    summary: "Comma-separated plugin ids to skip this run",
  },
  {
    name: "MINIMAL_AGENT_ENABLE_PLUGINS",
    flag: "enable-plugin",
    summary: "Comma-separated plugin ids to force on this run",
  },
  {
    name: "MINIMAL_AGENT_NO_AGENTS_MD",
    set: "1",
    flag: "no-agents-md",
    summary: "Skip AGENTS.md system-prompt injection",
    description: ["Same as --disable-plugin agents-md."],
  },
  {
    name: "MINIMAL_AGENT_PLUGIN_PROMPTS",
    set: "1",
    flag: "no-plugin-prompts",
    // Direction follows the resolver in core
    // (`resolvePluginPromptSuppression`): `1`/`true` suppresses every plugin
    // prompt text, `0`/`false` suppresses nothing.
    summary: "Suppress all plugin prompt text",
    description: [
      "0 or false turns every plugin prompt text back on.",
      "A suppressed plugin still loads and keeps its tools.",
    ],
  },
  {
    name: "MINIMAL_AGENT_DRY_RUN",
    set: "1",
    // No `flag:` pointer on purpose. Command help matches env rows by flag
    // name, and `auth-status prune` has its own `--dry-run`. A pointer would
    // list this variable in prune help, where it does nothing.
    summary: "Build the request, print it as JSON, do not send it",
    description: ["Same as --dry-run and --enable-plugin dry-run."],
  },
  {
    name: "MINIMAL_AGENT_PLUGINS_REPO",
    summary: "Git URL of the extended plugins repo, for a fork or mirror",
  },
  {
    name: "MINIMAL_AGENT_GITHUB_TOKEN",
    summary: "Token to clone a private plugins repo, else GITHUB_TOKEN, GH_TOKEN, gh",
  },
  {
    name: "MINIMAL_AGENT_NO_HISTORY",
    set: "1",
    summary: "Disable prompt history",
    description: ["Read by the history plugin."],
  },
  {
    name: "MINIMAL_AGENT_FILE_LOCK_DISABLED",
    set: "1",
    summary: "Disable cooperative file locking",
    description: ["Read by the file-lock plugin."],
  },
  {
    name: "MINIMAL_AGENT_SUBAGENT_MODEL",
    summary: "Force a model for spawned workers",
    description: ["Else the workers inherit your model."],
  },
  {
    name: "MINIMAL_AGENT_SUBAGENT_AUTO_TIER",
    set: "1",
    summary: "Let specialists pick a per-role model",
    description: ["Default: off."],
  },
  {
    // Wildcard row. Not a real variable: it stands for the hidden
    // system-prompt entries below.
    name: "MINIMAL_AGENT_SYSTEM_*",
    summary: "Override system-prompt parts, see the System prompt flags",
    description: [
      "Parts: _INSTRUCTIONS, _IDENTITY, _LOOP_SAFETY, _TOOL_OUTPUT_CONVENTIONS, _SESSION_CONTEXT, _PROMPT.",
      "Also MINIMAL_AGENT_PROVIDER_SYSTEM_PREAMBLE. Each one also has a *_FILE form for a path. An empty value omits the part.",
    ],
  },
]

/** Every built-in env entry: the visible rows in root help order, then the hidden ones. */
export const BUILTIN_ENV: readonly BuiltinEnvSpec[] = [...VISIBLE_ENV, ...SYSTEM_PROMPT_ENV]
