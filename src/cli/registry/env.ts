/**
 * Built-in environment variables as registry data (plan M-8a, 2.1).
 *
 * The visible entries are the 44 rows of the root help "Env" section in
 * `src/startup/help.ts`, in the same order, with the same summary and notes.
 * `set` keeps the value hint of the 16 rows whose term is `NAME=1` or
 * `NAME=0` (legacy override 3, plan 2.4). `flag` names the FlagSpec a
 * variable backs, when one exists.
 *
 * The system-prompt override variables follow as hidden entries. Root help
 * shows them through the wildcard row `MINIMAL_AGENT_SYSTEM_*`, which is the
 * last visible entry here (legacy override 4).
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
    summary: "Verbose request/response debug diagnostics",
    description: ["session log file, stderr with MINIMAL_AGENT_LOG_STDERR=1"],
  },
  { name: "MINIMAL_AGENT_LOG_STDERR", set: "1", summary: "Mirror every diagnostic to stderr" },
  {
    name: "MINIMAL_AGENT_TRANSPORT",
    default: "http2",
    summary: "Transport: http2 or fetch",
    description: ["default: http2; plaintext http:// auto-routes to HTTP/1.1"],
  },
  {
    name: "MINIMAL_AGENT_NO_PLAINTEXT_HTTP1",
    set: "1",
    summary: "Keep http:// on HTTP/2 (disable the plaintext auto-route)",
    description: ["for an h2c-capable local server"],
  },
  {
    name: "MINIMAL_AGENT_ALLOW_FETCH_FALLBACK",
    set: "1",
    summary: "Allow fetch fallback after HTTP/2 failure",
  },
  {
    name: "MINIMAL_AGENT_NET_DBG",
    set: "1",
    summary: "Mirror raw HTTP req/res to ~/.minimal-agent/net-dbg/",
  },
  { name: "CLAUDE_CODE_EXTRA_METADATA", summary: "JSON object merged into metadata.user_id" },
  {
    name: "MINIMAL_AGENT_SPINNER",
    flag: "spinner",
    summary: "Spinner preset id",
    description: ["same values as --spinner"],
  },
  {
    name: "MINIMAL_AGENT_EFFORT",
    flag: "effort",
    summary: "Reasoning effort",
    description: ["low | medium | high | xhigh | max"],
  },
  {
    name: "MINIMAL_AGENT_FAST",
    set: "1",
    flag: "fast",
    summary: "Opt into fast-mode dispatch",
    description: ["fast-capable models only"],
  },
  {
    name: "MINIMAL_AGENT_THINKING_DISPLAY",
    flag: "thinking-display",
    summary: "Force thinking display",
    description: ["summarized | omitted"],
  },
  {
    name: "MINIMAL_AGENT_FORMATTER_ARGS",
    flag: "formatter-args",
    summary: "Extra args for the formatter",
    description: ['shell-style, e.g. "--table-fit"'],
  },
  {
    name: "MINIMAL_AGENT_CONFIG",
    default: "~/.minimal-agent/config.jsonc",
    summary: "Override config path",
    description: ["default: ~/.minimal-agent/config.jsonc"],
  },
  {
    name: "MINIMAL_AGENT_MODEL",
    flag: "model",
    summary: "Default model id",
    description: ["same as --model"],
  },
  {
    name: "MINIMAL_AGENT_PROVIDER",
    flag: "provider",
    summary: "Default provider id",
    description: ["same as --provider"],
  },
  {
    name: "MINIMAL_AGENT_ENDPOINT",
    flag: "endpoint",
    summary: "Generic endpoint URL",
    description: ["same as --endpoint"],
  },
  {
    name: "MINIMAL_AGENT_FORMAT",
    flag: "format",
    summary: "Generic endpoint surface id",
    description: ["same as --format / --surface"],
  },
  {
    name: "MINIMAL_AGENT_AUTH_TYPE",
    flag: "auth-type",
    summary: "Generic endpoint auth",
    description: ["api-key | bearer | none | custom-header, same as --auth-type"],
  },
  {
    name: "MINIMAL_AGENT_API_KEY",
    flag: "api-key",
    summary: "Generic endpoint key/token",
    description: ["same as --api-key"],
  },
  {
    name: "MINIMAL_AGENT_AUTH_HEADER",
    flag: "auth-header",
    summary: "Custom auth header name",
    description: ["same as --auth-header"],
  },
  {
    name: "MINIMAL_AGENT_PROVIDER_MODEL",
    flag: "provider-model",
    summary: "Wire model id override",
    description: ["same as --provider-model"],
  },
  {
    name: "MINIMAL_AGENT_EFFORT_LEVELS",
    flag: "effort-levels",
    summary: "Generic endpoint effort ladder",
    description: ["comma-separated, same as --effort-levels"],
  },
  {
    name: "MINIMAL_AGENT_MEMORY_NAMESPACE",
    summary: "Namespace memory paths under namespaces/<ns>/",
    description: ["memory plugin"],
  },
  {
    name: "MINIMAL_AGENT_THEME",
    summary: "UI theme",
    description: ["dark | light | high-contrast"],
  },
  {
    name: "MINIMAL_AGENT_NO_LIVE_AREA",
    set: "1",
    summary: "Disable live-area REPL",
    description: ["fall back to legacy raw input"],
  },
  {
    name: "MINIMAL_AGENT_HEADER",
    flag: "header",
    summary: "Force startup tree",
    description: ["0|1, default hidden in non-interactive"],
  },
  {
    name: "MINIMAL_AGENT_MODE",
    flag: "mode",
    summary: "Initial mode id",
    description: ['or "none" to disable'],
  },
  {
    name: "MINIMAL_AGENT_CONTINUATION_PROMPT",
    default: "  ",
    summary: "Override continuation-prompt prefix",
    description: ['default: "  "'],
  },
  {
    name: "MINIMAL_AGENT_SHOW_HIDDEN_CHARS",
    set: "1",
    flag: "show-hidden-chars",
    summary: "Show spaces/tabs/newlines as faint glyphs",
  },
  {
    name: "MINIMAL_AGENT_SKIP_QUOTA",
    set: "1",
    flag: "skip-quota",
    summary: "Skip startup quota check",
  },
  {
    name: "MINIMAL_AGENT_NO_PLUGIN_SYNC",
    set: "1",
    summary: "Skip the first-run extended-plugins clone",
  },
  {
    name: "MINIMAL_AGENT_PLUGIN_SIBLINGS",
    summary: "Dev plugin checkout dirs (colon-separated)",
    description: ["default: ../minimal-agent-plugins next to the CLI repo"],
  },
  {
    name: "MINIMAL_AGENT_AUTO_ASK",
    set: "0",
    summary: "Turn off automatic ASK mode in the REPL",
    description: ["or config autoAsk: false"],
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
    description: ["same as --disable-plugin"],
  },
  {
    name: "MINIMAL_AGENT_ENABLE_PLUGINS",
    flag: "enable-plugin",
    summary: "Comma-separated plugin ids to force on this run",
    description: ["same as --enable-plugin"],
  },
  {
    name: "MINIMAL_AGENT_NO_AGENTS_MD",
    set: "1",
    flag: "no-agents-md",
    summary: "Skip AGENTS.md system-prompt injection",
    description: ["same as --no-agents-md / --disable-plugin agents-md"],
  },
  {
    name: "MINIMAL_AGENT_PLUGINS_REPO",
    summary: "Git URL for the extended plugins repo",
    description: ["fork/mirror"],
  },
  {
    name: "MINIMAL_AGENT_GITHUB_TOKEN",
    summary: "Token to clone a private plugins repo",
    description: ["else GITHUB_TOKEN / GH_TOKEN / gh"],
  },
  {
    name: "MINIMAL_AGENT_NO_HISTORY",
    set: "1",
    summary: "Disable prompt history",
    description: ["history plugin"],
  },
  {
    name: "MINIMAL_AGENT_FILE_LOCK_DISABLED",
    set: "1",
    summary: "Disable cooperative file locking",
    description: ["file-lock plugin"],
  },
  {
    name: "MINIMAL_AGENT_SUBAGENT_MODEL",
    summary: "Force a model for spawned workers",
    description: ["else inherit your model"],
  },
  {
    name: "MINIMAL_AGENT_SUBAGENT_AUTO_TIER",
    set: "1",
    summary: "Let specialists pick a per-role model",
    description: ["default off"],
  },
  {
    // Wildcard row (legacy override 4). Not a real variable: it stands for
    // the hidden system-prompt entries below.
    name: "MINIMAL_AGENT_SYSTEM_*",
    summary: "Override system-prompt parts (see System prompt section)",
    description: [
      "_INSTRUCTIONS, _IDENTITY, _LOOP_SAFETY, _TOOL_OUTPUT_CONVENTIONS, _SESSION_CONTEXT, _PROMPT",
      "also MINIMAL_AGENT_PROVIDER_SYSTEM_PREAMBLE; each also *_FILE for a path; empty = omit",
    ],
  },
]

/** Every built-in env entry: the visible rows in root help order, then the hidden ones. */
export const BUILTIN_ENV: readonly BuiltinEnvSpec[] = [...VISIBLE_ENV, ...SYSTEM_PROMPT_ENV]
