# minimal-agent-cli

The terminal and process host for minimal-agent. This repo owns the
`minimal-agent` bin, argument parsing, the REPL and TUI, stdout and stderr
output, startup, plugin root discovery, process exit, and `--host-mode`.

The engine is the library package `@minimal-agent/core`, in
[gastonmorixe/minimal-agent-core](https://github.com/gastonmorixe/minimal-agent-core).
First-party plugins are in
[gastonmorixe/minimal-agent-plugins](https://github.com/gastonmorixe/minimal-agent-plugins).

## Work in the monorepo

This repo is a git submodule of
[gastonmorixe/minimal-agent](https://github.com/gastonmorixe/minimal-agent)
(the monorepo). Do the daily work there, not in a clone of this repo alone.
Its [README](https://github.com/gastonmorixe/minimal-agent#readme) has the
full workflow. The parts that matter for the cli:

- **Install once, at the monorepo root.** `bun install` there links the
  local core checkout into this repo, and the CLI loads the local plugins
  checkout. `bun run start` at the root runs the CLI on your local core and
  plugins. An edit in any of the three is live at the next start, with no
  commit and no pin to move. `bun install` in this folder is the same root
  install.
- **Run `bun run hooks` once after a clone**, at the monorepo root. It sets
  up the commit message hook. `bun install` does that too, but not when
  lifecycle scripts are off on your machine.
- **Make a branch before you commit.** The monorepo checks out each
  submodule at one recorded commit, on no branch (a "detached HEAD"). Run
  `git switch -c <name>` first. A commit on no branch is hard to find again.
- **Land here first, then record it.** Push the commit to `main` of this
  repo. Then, at the monorepo root, run `git add minimal-agent-cli`, commit
  and push. The monorepo CI is the full gate.
- **Do not edit the core pin by hand.** `package.json` and `bun.lock` name
  one core commit, for an install of this repo alone and for a release
  build. After a core change lands, `bun run pins:core` at the monorepo root
  moves it here, in plugins and in web together.
- **After a dependency change, run `bun run pins:lock`** at the monorepo
  root. The root install does not update the `bun.lock` of this repo.
  `pins:lock` does. Commit that file here.
- **`bun run pins`** at the monorepo root shows the state of every pin and
  the next command to run.

In a clone of this repo alone, `bun install` gets core at the pinned commit,
and the commands below work the same. There is then no plugins checkout next
to the CLI, so the CLI clones the plugins repo (see "First run").

## Requirements

Requires Bun 1.4.4 or newer. The product itself runs on Bun. Architecture checks additionally require Node 22.18.0 or newer because they execute TypeScript source with Node's built-in type stripping. Set `NODE=/path/to/node` to select a compatible executable.

The architecture checker also imports the explicitly unstable `typescript/unstable/ast` and `typescript/unstable/sync` surfaces. TypeScript is therefore pinned exactly to 7.0.2. Updating TypeScript or the architecture-check Node baseline may require coordinated checker changes.

`bun install` reads private git dependencies (`@minimal-agent/core`,
`@minimal-agent/config`), so it needs `git` and SSH access to GitHub.

Optional at run time: `git`, for the first-run clone of the extended
plugins, and `mdstream` for Markdown rendering (the CLI downloads it on
first run).

## Run the CLI

```sh
bun install                  # at the monorepo root: links the local core. In a clone of this repo alone: core at the pinned commit
bun run src/index.ts --help  # show every command and flag
bun run src/index.ts         # interactive REPL
bun run start -- --help      # the same entry point, through package.json
./ma --help                  # the same entry point, through the root script
```

`./ma` resolves its own location through symlinks and keeps your working
directory, so `ln -sf "$PWD/ma" ~/.local/bin/ma` makes it runnable anywhere.

The bin is `src/index.ts` (`package.json#bin`, name `minimal-agent`). It calls
`src/main.ts`, which does the startup work.

One prompt, then exit:

```sh
bun run src/index.ts "explain this repo in five bullets"
bun run src/index.ts --prompt "list the files touched in the last commit"
echo "summarize stdin" | bun run src/index.ts -
bun run src/index.ts -p "hi" --output-format stream-json
```

Other commands (`--help` anywhere prints the full help):

- **Resume:** `resume <sid|last>` (alias `--resume`), `resume-same <sid|last>`
- **Sessions:** `sessions [query]`, `sessions dump <sid|last>` (alias `--dump`)
- **Usage:** `usage [today|last-day|last-month|ytd|year|all]`
- **Providers and models:** `providers`, `providers models` (alias
  `--list-models`), `providers models-live`
- **Plugins:** `plugins list`
- **Login:** `login [provider]`, `logout [provider]` (also
  `provider <id> login`, `provider <id> logout`), `auth-status`
- **Credentials:** `auth-status plan`, `auth-status refresh`,
  `auth-status refresh-all`, `auth-status prune --dry-run`
- **Local:** `version`, `spinners`, `flags`, `help <command>`
- **Update:** `update` replaces a compiled binary with a newer release (see
  "Releases")

Useful flags:

- **Model:** `--model <id>` (alias `-m`, use with `--provider <id>`)
- **Effort:** `--effort <low|medium|high|xhigh|max>` (alias `-e`)
- **Fast mode:** `--fast` (alias `-F`)
- **Non-interactive output:** `-p <text>` with
  `--output-format <text|json|stream-json>`
- **Tools:** `--tools <names>` to offer only these tools, `--no-tools` for none
- **Mode:** `--mode <id|none>`
- **Dry run:** `--dry-run` prints the model request as JSON and does not send it
- **Debug logging:** `--debug`
- **Skip quota check:** `--skip-quota`

### First run

On a clean machine (no `~/.minimal-agent/` yet), sign in first:

```sh
bun run src/index.ts providers        # the provider ids
bun run src/index.ts login <provider> # or: provider <id> login
```

Credentials are written to `~/.minimal-agent/auth.jsonc`. With no credential,
a start stops with `fatal: no provider credentials found` and names the login
command. It does not start a sign-in for you. A first interactive start can
show a setup card that lists a sign-in step: that step is the `login` command
above.

The CLI does two setup steps by itself, one time:

- **The extended plugins.** A run from source with no plugins checkout next
  to it (install mode) clones the plugins repo into
  `~/.minimal-agent/plugins/`. An interactive start does it, and so does a
  command that lists plugins or providers (`providers`, `plugins list`). A
  `-p` run does not. In the monorepo (dev mode) and in a compiled binary
  there is no clone.
- **`mdstream`**, the Markdown renderer. An interactive start downloads it
  into `~/.minimal-agent/bin/`. `MINIMAL_AGENT_NO_BINARY_SETUP=1` skips it.

The two steps are best-effort: with no network or no `git`, the CLI does not
crash. But the providers are in the plugins repo, so a run from source with
no clone and no checkout has no provider.

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

```sh
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
  "spinner": "breathing",
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
  "headless": {
    "tools": [
      { "id": "t", "platforms": ["macos", "linux"], /* this tool gates separately */ }
    ]
  }
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

- **`DEBUG=1`:** Log request and response debug output as Debug diagnostics (session log file, or stderr with `MINIMAL_AGENT_LOG_STDERR=1`).
- **`MINIMAL_AGENT_LOG_STDERR=1`:** Mirror every diagnostic to stderr.
- **`VERBOSE=1`:** Avoid truncating debug output.
- **`MINIMAL_AGENT_CONFIG`:** Use a custom config file.
- **`MINIMAL_AGENT_TRANSPORT`:** Select `http2` or `fetch`.
- **`MINIMAL_AGENT_ALLOW_FETCH_FALLBACK=1`:** Permit fetch fallback after an HTTP/2 failure.
- **`MINIMAL_AGENT_NET_DBG=1`:** Mirror raw HTTP traffic to `~/.minimal-agent/net-dbg/` (honors `MINIMAL_AGENT_HOME`).
- **`MINIMAL_AGENT_STREAM_IDLE_TIMEOUT_MS`:** Mid-stream idle limit in ms (default 30 s; minimum 1 s).
- **`MINIMAL_AGENT_SILENT_BLOCK_IDLE_TIMEOUT_MS`:** Idle limit in ms while a thinking or tool-input block is open (default 300 s, or 90 s after a keepalive ping inside the block; minimum 1 s).
- **`MINIMAL_AGENT_RESPONSE_HEADERS_TIMEOUT_MS`:** Base limit in ms before the response headers arrive (default 60 s for a remote host; it doubles for each retry, up to 240 s). After the headers arrive, or for a local or LAN host, the default is 120 s. Minimum 5 s. Increase it for big uploads on a slow link.
- **`MINIMAL_AGENT_SPINNER`:** Select the spinner preset (`minimal-agent spinners` lists them).
- **`MINIMAL_AGENT_MODEL`:** Select the model (same as `--model`).
- **`MINIMAL_AGENT_PROVIDER`:** Select the provider (same as `--provider`).
- **`MINIMAL_AGENT_EFFORT`:** Set reasoning effort (`low`…`max`).
- **`MINIMAL_AGENT_FAST=1`:** Opt into fast-mode dispatch where the model supports it.
- **`MINIMAL_AGENT_THINKING_DISPLAY`:** Set `summarized` or `omitted`.
- **`MINIMAL_AGENT_NO_LIVE_AREA=1`:** Use the legacy raw input path.
- **`MINIMAL_AGENT_AUTO_ASK=0`:** Disable automatic ASK mode detection.
- **`MINIMAL_AGENT_AUTO_COMPACT=0`:** Disable auto compact on a context overflow.
- **`MINIMAL_AGENT_SHOW_HIDDEN_CHARS=1`:** Show spaces, tabs, and newlines in the editor.
- **`MINIMAL_AGENT_SKIP_QUOTA=1`:** Skip the startup quota check.
- **`MINIMAL_AGENT_NO_PLUGIN_SYNC=1`:** Skip the first-run plugin clone.
- **`MINIMAL_AGENT_NO_BINARY_SETUP=1`:** Skip the `mdstream` download.
- **`MINIMAL_AGENT_PLUGIN_SIBLINGS`:** Plugin checkout dirs for dev mode, colon separated.
- **`MINIMAL_AGENT_PLUGINS_REPO`:** Git URL for the extended plugins repo (fork/mirror).
- **`MINIMAL_AGENT_GITHUB_TOKEN`:** Token for cloning a private plugins repo (falls back to `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token`).
- **`MINIMAL_AGENT_DISABLE_CRON=1`:** Disable the schedule plugin (heartbeat inert, cron tools refuse).
- **`MINIMAL_AGENT_CRON_DIR`:** Relocate the schedule store (default `~/.minimal-agent/sessions`).

`minimal-agent --help` prints more. A plugin can read variables that are not
in that list: the README of the plugin has them.

## Extended plugins

The first-party plugins (providers, modes, tools, and UI extras) live in
[`minimal-agent-plugins`][map]. Where the CLI gets them depends on how it
runs:

- **In the monorepo (dev mode):** from the `minimal-agent-plugins/` checkout
  next to this repo. No clone, no symlink.
- **A compiled binary:** all of them are built in. It needs no clone, and
  `~/.minimal-agent/plugins/` only holds your overrides.
- **From source with no plugins checkout next to it (install mode):** the
  CLI clones that repo once into `~/.minimal-agent/plugins/` (see "First
  run" for which commands do it). The clone is one-shot: once that directory
  has plugins it is never auto-pulled, so you stay in control. Update them
  yourself with `git -C ~/.minimal-agent/plugins pull`.

The CLI reads 3 plugin roots. Precedence: project, then user, then embedded.

- **Project:** `<cwd>/.agents/minimal-agent/plugins/`.
- **User:** `~/.minimal-agent/plugins/`, the clone above (install mode only).
- **Embedded:** the `../minimal-agent-plugins` checkout next to the CLI, or
  the dirs in `MINIMAL_AGENT_PLUGIN_SIBLINGS` (colon separated). A compiled
  binary also has its built-in plugins, below every disk root, so a project
  or user copy of a plugin id wins.

Dev mode: when a checkout dir holds at least one plugin package (a subdir with
`manifest.json` or `provider.json`), the user tier is empty and the CLI does
not clone. The CLI does not read `~/.agents/plugins/` or
`<cwd>/.agents/plugins/`. If one of them holds plugin packages, the CLI prints
an "ignored legacy plugin root" warning and moves nothing.

That repo also ships, among others: `Fetch` (JS-rendering web fetch),
`Skill` ([Agent Skills][as] support), `Speak` (text-to-speech), background jobs,
a Chrome DevTools driver, a Mac control helper, inter-session intercom, and a
slash-command palette. Its
[README](https://github.com/gastonmorixe/minimal-agent-plugins#readme) lists
every plugin with its id.

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

Run WebSearch directly while debugging provider config (the paths are for
the monorepo layout):

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

The engine writes nothing to the terminal itself and formats no debug text.
Before each request, core publishes a typed `llm.requestWillSend` event
(`@minimal-agent/core/host/request-inspector`). Core builds the event only
when a host subscribes, so a run without `--debug` costs nothing. With
`--debug`, the CLI subscribes and renders the event:

- The REPL paints a colored request block above the prompt.
- Every mode writes the plain-text dump as Debug-severity
  `transport.request-dump` rows to the session log file
  (`~/.minimal-agent/logs/ma-session-<sid>.log`).
- In print and protocol mode, `--debug` also mirrors the rows to stderr.
  `MINIMAL_AGENT_LOG_STDERR=1` mirrors them in every mode.

Add `--verbose` to show the full text of each part, with line gutters,
instead of the 80-character previews.

Use network debug capture when you want raw request and response files:

```sh
MINIMAL_AGENT_NET_DBG=1 bun run src/index.ts
```

Captures are written under `~/.minimal-agent/net-dbg/` (or `$MINIMAL_AGENT_HOME/net-dbg/`
when the home is relocated), one file per request and response, for diffing
against real traffic.

Prompt cache behavior is documented in core, in `src/agent/cache.ts` and `src/cache/cache-ttl.ts`. The short
version: tools, system blocks, and the rolling conversation tail are arranged so
a provider's prefix cache can pay off across turns in one process.

## Standalone binary

Build one `minimal-agent` executable with Bun's `--compile`:

```sh
bun run compile:dev          # core from ../minimal-agent-core (working tree, uncommitted edits included)
bun run compile:release      # core from the commit pinned in package.json
bun run compile:release:all  # release build for all 7 macOS and Linux targets in scripts/release/targets.ts
```

From the monorepo root, use `bun run cli:compile:dev` or
`bun run cli:compile:release`. The output is `dist/minimal-agent` (a
cross target gets a suffix, for example `dist/minimal-agent-linux-x64`).
Both modes need the core checkout at `../minimal-agent-core` and the
plugins checkout at `../minimal-agent-plugins`, so build in the monorepo. A
release build reads the pinned core commit, and the plugins commit that is
checked out, with `git archive`: uncommitted edits in core or plugins do not
go into a release. A release build stops when this repo has uncommitted
tracked changes.

Options go after the script name, for example
`bun run compile:dev -- --outfile /path/to/minimal-agent`:

- `--target <target>`: cross-compile. A target id (`linux-x64-musl`) or its
  Bun name (`bun-linux-x64-musl`).
- `--all`: build every release target (release only).
- `--outfile <path>`: output path (one target only).
- `--bytecode`, `--no-bytecode`: off for dev, on for release by default.
- `--no-smoke`: skip the smoke run and the end-to-end checks.

Each native build is smoke-tested (`--help` and `plugins`), then checked by
`scripts/compile-e2e.sh`. Only a build that passes replaces the file at the
output path. A build for another target (`--target`, or the other targets of
`--all`) skips these checks, because this machine cannot run that binary. The
binary does not read `bunfig.toml` or `.env` from its cwd.

Run the end-to-end checks by hand on any binary:

```sh
scripts/compile-e2e.sh [BINARY]   # default: dist/minimal-agent
```

It copies the binary to a temp dir outside the repo and runs it with a
fresh HOME. It checks `--help` (the command map and the `package.json`
version), `plugins` with a disk plugin that imports core, a hostile
`bunfig.toml` and `.env` in the cwd, `-p` with no credentials, and the REPL
in tmux (skipped without tmux). It also checks that the built-in plugins
load with an empty HOME, that a user copy of a plugin id wins, and that the
binary can start itself as a background job and as a sub-agent with no `bun`
on the PATH. Exit 0 means all checks passed, 1 means a check failed, and 2
means bad usage or environment.

## Scripts and docs

- `scripts/compile.ts`, `scripts/compile-e2e.sh`: the standalone binary
  build and its end-to-end checks (see above).
- `scripts/install.sh`: installs a released binary (see "Releases").
- `scripts/release/`: the release targets, packaging, and macOS signing that
  the release workflow uses.
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

The gate runs TypeScript, oxlint, Biome format and import checks, then the
architecture preflight (it checks the Node version) and the Bun tests. See
[`AGENTS.md`](AGENTS.md) for the boundary and dependency rules.

The CI of this repo checks only the commit messages. It cannot install the
private git dependencies. The full gate runs in the monorepo CI, on the
commit that the monorepo records for this repo.

## Commits

Commit subjects follow Conventional Commits. The Husky `commit-msg` hook runs Commitlint and, during minimal-agent sessions, checks the required session-local `Co-authored-by` audit trailer. `bun install` sets up the hook, but not when lifecycle scripts are off on your machine (`ignore-scripts` in `~/.npmrc`). Run `bun run hooks` at the monorepo root once after a clone: it sets up the hook in every repo.

## Releases

The release workflow builds the standalone binary for every macOS and Linux target and publishes it on the GitHub Releases of this repo. The repo is private, so a download needs a GitHub token.

- **Stable:** push an annotated `v<version>` tag that exactly matches `package.json`.
- **Nightly:** a daily run makes a pre-release tagged `v<version>-nightly.<UTC stamp>`. It skips a day when the cli, core and plugins commits did not change. The newest 7 nightlies are kept.

The workflow does not run the package gate. A build takes `main` of this repo, the core commit that `package.json` pins, and the newest `main` of the plugins repo. So a nightly can hold commits that the monorepo CI did not gate yet. Each native build does run the smoke run and the end-to-end checks of the binary. This repo is not published to a package registry.

Install a released binary with `scripts/install.sh` (`--channel stable|nightly`, `--version <x.y.z|tag>`, `--dir <dir>`). The header of that file has the full command. Update an installed binary in place with `minimal-agent update` (`--check`, `--channel nightly`, `--to <version>`, `--rollback`). Both read the token from `MINIMAL_AGENT_GITHUB_TOKEN`, then `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`.

## License

Proprietary. All rights reserved. See [LICENSE](LICENSE).
