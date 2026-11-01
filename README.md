# minimal-agent-cli

The terminal and process host for minimal-agent. This repo owns the
`minimal-agent` bin, argument parsing, the REPL and TUI, stdout and stderr
output, startup, plugin root discovery, process exit, and `--host-mode`.

The engine is the library package `@minimal-agent/core`, in
[gastonmorixe/minimal-agent-core](https://github.com/gastonmorixe/minimal-agent-core).
First-party plugins are in
[gastonmorixe/minimal-agent-plugins](https://github.com/gastonmorixe/minimal-agent-plugins).

## Requirements

Requires Bun 1.4.2 or newer. The product itself runs on Bun. Architecture checks additionally require Node 22.18.0 or newer because they execute TypeScript source with Node's built-in type stripping. Set `NODE=/path/to/node` to select a compatible executable.

The architecture checker also imports the explicitly unstable `typescript/unstable/ast` and `typescript/unstable/sync` surfaces. TypeScript is therefore pinned exactly to 7.0.2. Updating TypeScript or the architecture-check Node baseline may require coordinated checker changes.

Optional: `git`, for the first-run clone of the extended plugins, and
`mdstream` for Markdown rendering (the CLI downloads it on first run).

## Run the CLI

```sh
bun install                  # installs @minimal-agent/core (git pin) and the toolchain
bun run src/index.ts --help  # show every command and flag
bun run src/index.ts         # interactive REPL
bun run start -- --help      # the same entry point, through package.json
```

The bin is `src/index.ts` (`package.json#bin`, name `minimal-agent`). It calls
`src/main.ts`, which does the startup work.

One prompt, then exit:

```sh
bun run src/index.ts "explain this repo in five bullets"
bun run src/index.ts --prompt "list the files touched in the last commit"
echo "summarize stdin" | bun run src/index.ts -
bun run src/index.ts -p "hi" --output-format stream-json
```

Other commands (each one also accepts `--help`):

- **Resume:** `resume <sid|last>` (alias `--resume`)
- **Sessions:** `sessions`, `sessions dump <sid|last>` (alias `--dump`)
- **Models:** `providers models` (alias `--list-models`)
- **Plugins:** `plugins list`
- **Login:** `provider <id> login`, `provider <id> logout`, `auth-status`

Useful flags:

- **Model:** `--model <id>` (alias `-m`, use with `--provider <id>`)
- **Effort:** `--effort <low|medium|high|xhigh|max>` (alias `-e`)
- **Fast mode:** `--fast` (alias `-F`)
- **Debug logging:** `--debug`
- **Skip quota check:** `--skip-quota`

### First run

On a clean machine the first interactive launch shows a short setup card and
then, in order:

1. **Signs you in.** OAuth via the manual-paste PKCE flow against the provider
   you chose. Credentials are written to `~/.minimal-agent/auth.jsonc`.
2. **Fetches `mdstream`** (the Markdown renderer) into `~/.minimal-agent/bin/`.
3. **Fetches the extended plugins** into `~/.minimal-agent/plugins/`.

Every step is best-effort and degrades cleanly: no network, no `git`, or a
declined sign-in just means fewer features, never a crash. After the first run
none of this repeats.

## Host mode (`--host-mode`)

`--host-mode <id>` gives the whole process to a plugin host mode after full
boot. A plugin declares the mode in its manifest `hostModes[]`. stdin and
stdout carry the protocol, and logs go to stderr. Every argument after the id
goes to the host mode. You cannot combine it with `--prompt`, `-p`, or a stdin
prompt.

Run the agent as an ACP (Agent Client Protocol) server for an editor:

```sh
bun run src/index.ts --host-mode acp
bun run src/index.ts --host-mode acp --approval
```

The `acp` mode comes from `ma-acp-plugin` in the plugins repo. The plugin must
be loaded and enabled. `--approval` is a host-mode argument. It turns on the
approval gate (`session/request_permission`) before each tool call. It is off
by default. See the
[ma-acp-plugin README](https://github.com/gastonmorixe/minimal-agent-plugins/blob/main/ma-acp-plugin/README.md).

## System-prompt overrides

Each model-facing part of the system prompt can be replaced or omitted at
startup. Every part has three forms, resolved with precedence CLI > env >
config > default:

- **Replace inline:** `--system-<part> "<text>"`
- **Replace from file:** `--system-<part>-file <path.md>`
- **Omit:** `--no-system-<part>` (or pass an empty string `--system-<part> ""`)

The controllable parts:

| Part | Flag | Config key | Env var |
| --- | --- | --- | --- |
| Whole core prompt | `--system-prompt` | `systemPrompt.full` | `MINIMAL_AGENT_SYSTEM_PROMPT` |
| Neutral identity | `--system-identity` | `systemPrompt.identity` | `MINIMAL_AGENT_SYSTEM_IDENTITY` |
| Base instructions | `--system-instructions` | `systemPrompt.instructions` | `MINIMAL_AGENT_SYSTEM_INSTRUCTIONS` |
| Loop-safety paragraph | `--system-loop-safety` | `systemPrompt.loopSafety` | `MINIMAL_AGENT_SYSTEM_LOOP_SAFETY` |
| Tool-output conventions | `--system-tool-output-conventions` | `systemPrompt.toolOutputConventions` | `MINIMAL_AGENT_SYSTEM_TOOL_OUTPUT_CONVENTIONS` |
| Session context (plugin prompts) | `--system-session-context` | `systemPrompt.sessionContext` | `MINIMAL_AGENT_SYSTEM_SESSION_CONTEXT` |
| Provider preamble | `--provider-system-preamble` | `systemPrompt.providerPreamble` | `MINIMAL_AGENT_PROVIDER_SYSTEM_PREAMBLE` |

`--system-prompt` replaces the entire core-controllable body, so individual part
overrides are ignored when it is set (the provider preamble is unaffected).

The provider preamble is server-validated on some plans (e.g. Anthropic OAuth),
so replacing or omitting it is refused unless you also pass
`--unsafe-system-prompt-overrides`. In config, a `false` or `null` value means
omit, a string means replace, and `<part>File` names a file to read.

Conflicting flags (e.g. `--system-instructions` together with
`--system-instructions-file`, or a missing `--system-*-file` path) fail fast at
startup with exit code 2.

## Any OpenAI-compatible endpoint (no plugin)

To reach a local runtime (LM Studio, vLLM, MLX) or a custom proxy without
writing a plugin, use the `generic-endpoint` provider with flags:

```
minimal-agent --provider generic-endpoint \
  --model my-local-model \
  --format openai-chat-completions \
  --endpoint http://localhost:1234/v1/chat/completions \
  --auth-type api-key --api-key "$MY_KEY"
```

`--format` accepts any registered wire surface (today: `openai-chat-completions`).
`--auth-type` is `api-key` / `bearer` / `none` / `custom-header` (pair the last
with `--auth-header`). `--provider-model` overrides the wire model id, and
`--effort-levels "low,medium,high"` lets `--effort` pass through for a reasoning
backend. Every flag has a `MINIMAL_AGENT_*` env and config equivalent. A plaintext
`http://` endpoint is auto-routed to HTTP/1.1 (the default HTTP/2 transport can't
talk to a plain HTTP/1.1 server). See
[`docs/2026-07-09-generic-endpoint-and-surface-codecs.md`](https://github.com/gastonmorixe/minimal-agent-core/blob/main/docs/2026-07-09-generic-endpoint-and-surface-codecs.md).

## Config

User config lives at:

```txt
~/.minimal-agent/config.jsonc
```

Set `MINIMAL_AGENT_CONFIG` to point at another file. Edit it interactively with
the `/config` command.

Example:

```jsonc
{
  "model": "<model-id>",
  "provider": "<provider-id>",
  "effort": "high",
  "thinkingDisplay": "summarized",
  "spinner": "breathing-dot",
  "formatter": "mdstream",
  "autoAsk": true,
  "skipQuota": false,
  "systemPrompt": {
    "instructionsFile": "~/prompts/my-instructions.md",
    "loopSafety": false
  },
  "plugins": {
    "web-search": {
      "enabled": true,
      "providers": ["brave"],
      "defaults": {
        "count": 5,
        "safesearch": "moderate",
        "country": "ALL",
        "lang": "en"
      },
      "brave": {
        "apiKeyEnv": "BRAVE_API_KEY"
      }
    }
  }
}
```

Precedence is:

```txt
CLI flag > env var > config file > built-in default
```

Disable a plugin with its manifest id in config:

```jsonc
{
  "plugins": {
    "web-search": {
      "enabled": false
    }
  }
}
```

For a single run, use CLI flags (same precedence as other options: CLI > env > config):

```bash
minimal-agent --disable-plugin web-search,memory -p "review this"
minimal-agent --enable-plugin interleave-thinking
minimal-agent plugins list    # discover installed plugin ids (incl. the dev checkout root)
```

Environment mirrors:

- **`MINIMAL_AGENT_DISABLE_PLUGINS`:** Comma-separated ids to skip (same as `--disable-plugin`).
- **`MINIMAL_AGENT_ENABLE_PLUGINS`:** Comma-separated ids to force on (same as `--enable-plugin`).

### Platform whitelists

A plugin (or a single tool) can opt into a whitelist of platforms it works on
via a `platforms` field in `manifest.json`. It defaults to all platforms when
absent. Buckets are `macos`, `linux` (the POSIX/UNIX-like bucket, also covering
the BSDs, illumos, AIX), and `windows`.

```jsonc
{
  "id": "ma-chrome-cdp",
  "platforms": ["macos"],        // whole plugin only loads on macOS
  "tuis": [
    { "id": "t", "platforms": ["macos", "linux"], /* this tool gates separately */ }
  ]
}
```

A plugin-level whitelist gates the whole package (tools, modes, hooks, prompt).
A tool-level whitelist gates just that tool and is ANDed with the plugin's. The
host detects the platform from `process.platform`; override it for a run with
`--platform <macos|linux|windows|all>` or `MINIMAL_AGENT_PLATFORM` (CLI > env >
detected). `all` (also `any`/`*`) bypasses gating entirely. Platform gating is a
hard capability constraint, so unlike `--enable-plugin` it is not overridden by a
force-enable; name the right platform or use `all`.

## Environment

Common environment variables:

- **`DEBUG=1`:** Log request and response debug output as Debug diagnostics (session log file; stderr with `MINIMAL_AGENT_LOG_STDERR=1`).
- **`VERBOSE=1`:** Avoid truncating debug output.
- **`MINIMAL_AGENT_CONFIG`:** Use a custom config file.
- **`MINIMAL_AGENT_TRANSPORT`:** Select `http2` or `fetch`.
- **`MINIMAL_AGENT_ALLOW_FETCH_FALLBACK=1`:** Permit fetch fallback after an HTTP/2 failure.
- **`MINIMAL_AGENT_NET_DBG=1`:** Mirror raw HTTP traffic to `~/.minimal-agent/net-dbg/` (honors `MINIMAL_AGENT_HOME`).
- **`MINIMAL_AGENT_SPINNER`:** Select the spinner preset.
- **`MINIMAL_AGENT_MODEL`:** Select the model (same as `--model`).
- **`MINIMAL_AGENT_PROVIDER`:** Select the provider (same as `--provider`).
- **`MINIMAL_AGENT_EFFORT`:** Set reasoning effort (`low`…`max`).
- **`MINIMAL_AGENT_FAST=1`:** Opt into fast-mode dispatch where the model supports it.
- **`MINIMAL_AGENT_THINKING_DISPLAY`:** Set `summarized` or `omitted`.
- **`MINIMAL_AGENT_NO_LIVE_AREA=1`:** Use the legacy raw input path.
- **`MINIMAL_AGENT_AUTO_ASK=0`:** Disable automatic ASK mode detection.
- **`MINIMAL_AGENT_SHOW_HIDDEN_CHARS=1`:** Show spaces, tabs, and newlines in the editor.
- **`MINIMAL_AGENT_SKIP_QUOTA=1`:** Skip the startup quota check.
- **`MINIMAL_AGENT_NO_PLUGIN_SYNC=1`:** Skip the first-run plugin clone.
- **`MINIMAL_AGENT_PLUGINS_REPO`:** Git URL for the extended plugins repo (fork/mirror).
- **`MINIMAL_AGENT_GITHUB_TOKEN`:** Token for cloning a private plugins repo (falls back to `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token`).
- **`MINIMAL_AGENT_DISABLE_CRON=1`:** Disable the schedule plugin (heartbeat inert, cron tools refuse).
- **`MINIMAL_AGENT_CRON_DIR`:** Relocate the schedule store (default `~/.minimal-agent/sessions`).

## Extended plugins

The first-party plugins (providers, modes, tools, and UI extras) live in
[`minimal-agent-plugins`][map]. The CLI clones that repo once into
`~/.minimal-agent/plugins/` on the first interactive run. The clone is one-shot:
once that directory has plugins it is never auto-pulled, so you stay in control.
Update them yourself with `git -C ~/.minimal-agent/plugins pull`.

That repo also ships, among others: `Fetch` (JS-rendering web fetch),
`Skill` ([Agent Skills][as] support), `Speak` (text-to-speech), background jobs,
a Chrome DevTools driver, a Mac control helper, inter-session intercom, and a
slash-command palette.

[map]: https://github.com/gastonmorixe/minimal-agent-plugins
[as]: https://agentskills.io

Controls:

- **Disable the bootstrap:** `MINIMAL_AGENT_NO_PLUGIN_SYNC=1` (or
  `"pluginSync": false` in config).
- **Point at a fork / mirror:** `MINIMAL_AGENT_PLUGINS_REPO=<git-url>` (or
  `"pluginsRepo"` in config).
- **Private plugins repo:** the bootstrap authenticates with the first token it
  finds: `MINIMAL_AGENT_GITHUB_TOKEN`, then `GITHUB_TOKEN`, then `GH_TOKEN`,
  then `gh auth token`. The token is passed to `git` through an inline
  credential helper, so it never lands in `ps`, the clone URL, or the cloned
  `.git/config`.

Run WebSearch directly while debugging provider config:

```sh
bun run ../minimal-agent-plugins/ma-web-search-plugin/cli.ts "typescript 6 release notes" --limit 5
bun run ../minimal-agent-plugins/ma-web-search-plugin/cli.ts "EU AI act" --type news --format json
```

## Sessions

Sessions are append-only JSONL files in `~/.minimal-agent/sessions/`. The
session id shows at startup. Resume shows the previous conversation in
scrollback before it accepts new input.

```sh
bun run src/index.ts sessions
bun run src/index.ts resume last
bun run src/index.ts sessions dump last --dump-format md
```

### Compacting context (/compact)

Use `/compact` to shrink model-facing history. Manual compact blocks. It finishes before the next turn runs.

Syntax:

```sh
/compact [mode] [tail=N] [focus="..."]
```

Modes:

- **remote**: Use the provider compact endpoint. Falls back to local on error. Shows the remote error in the notice.
- **tail**: Keep the last N messages verbatim. Makes no LLM call. Use it offline.
- **local**: Blocking LLM summary plus tail. This is the default. Falls back to a stub checkpoint when the summary fails.
- **fork**: Not implemented. It leaves history untouched and reports an error with branch guidance.

Defaults: mode is `local`. Tail is `6`. Examples: `/compact`, `/compact remote`, `/compact tail tail=0`, `/compact local tail=10 focus="auth work"`.

Auto compact runs on `context_length_exceeded`. It tries remote first, else local. It retries the failed turn once. It is on by default. Set `MINIMAL_AGENT_AUTO_COMPACT=0` to turn it off.

Local summaries use a fixed 7-heading template: Goal, Constraints (verbatim), Decisions, Files and snippets, Errors and fixes, Pending tasks, Next step. The summarizer gets text only. It makes no tool calls.

## Debugging the wire

Use `--debug` when you want readable request and response summaries:

```sh
bun run src/index.ts --debug "what model are you"
```

The engine writes nothing to the terminal itself. The summaries are
Debug-severity diagnostics: they land in the session log file
(`~/.minimal-agent/logs/ma-session-<sid>.log`). Add `MINIMAL_AGENT_LOG_STDERR=1`
to mirror them to stderr as well.

Use network debug capture when you want raw request and response files:

```sh
MINIMAL_AGENT_NET_DBG=1 bun run src/index.ts
```

Captures are written under `~/.minimal-agent/net-dbg/` (or `$MINIMAL_AGENT_HOME/net-dbg/`
when the home is relocated), one file per request and response, for diffing
against real traffic.

Prompt cache behavior is documented in `src/cache/cache.ts` and `src/agent/cache.ts`. The short
version: tools, system blocks, and the rolling conversation tail are arranged so
a provider's prefix cache can pay off across turns in one process.

## Scripts and docs

- `scripts/test-all-models.sh`, `scripts/test-one-model.sh`: send one prompt
  to each model through the CLI bin and check the reply. Set `INSPECTOR` to
  capture network traffic.
- `scripts/stream-markdown.ts`: replay a Markdown file in random chunks, to
  test terminal Markdown rendering against a stream that looks real.
- `docs/tui/`: terminal renderer architecture, one file per layer.

## Quality gate

```sh
bun run check
```

The gate runs TypeScript, oxlint, Biome format and import checks, then Bun
tests. See [`AGENTS.md`](AGENTS.md) for the boundary and dependency rules.

## Commits

Commit subjects follow Conventional Commits. `bun install` configures the Husky `commit-msg` hook, which runs Commitlint and, during minimal-agent sessions, checks the required session-local `Co-authored-by` audit trailer.

## Releases

Stable releases are created by pushing an annotated `v<version>` tag that exactly matches `package.json`. The GitHub release workflow runs the full package gate first. This repository does not publish nightlies and is not published to a public package registry.

## License

Proprietary. All rights reserved. See [LICENSE](LICENSE).
