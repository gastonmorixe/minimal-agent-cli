---
project: "minimal-agent-cli"
title: "Changelog"
type: changelog
status: living
scope: cli
working-dir: "."
created-at: "2026-08-07T13:45:26-0400"
updated-at: "2026-11-18T00:00:00-0500"
format: "Keep a Changelog (pragmatic, date-stamped)"
---

# Changelog

All notable changes to the **minimal-agent-cli** terminal and process host are
documented here. This repository is the Program 3A scaffold for MA-394837: the
terminal client is being moved out of `minimal-agent-core` into this repo
(cutover lands at Program 3B).

## [Unreleased]

### Changed

- 2026-11-18: **The prompt-cache anchor marker is on by default.** With the
  new core default, every run (`-p` and the REPL) sends the anchor marker on
  the message before the latest assistant turn. Turn it off with
  `--no-cache-anchor`, `MINIMAL_AGENT_CACHE_ANCHOR=0` or the config key
  `"cacheAnchor": false`. A sub-agent inherits an explicit off from the lead
  through the startup profile. `--thinking-history` is unchanged and stays
  `strip` by default.

### Added

- 2026-11-18: **The TUI writes one scrollback row for each prompt-cache
  break** (`src/ui/status/cache-break-row.ts`). The row comes from the
  `cache.didBreak` plugin bus event, not from the diagnostic severity, so an
  expected cache expiry is shown too. Before, the scrollback sink dropped
  info, and a 63 min idle turn that rewrote 26,426 tokens showed nothing.
  For example:
  `◇ cache rewrote 26,426 tok · ttl expired · idle 63 min > 5 min TTL · turn 5 · 16:49:36`.
  A break that someone can act on is gold (`◆`); an expected one is dim
  (`◇`). The row names the changed part, the request id of a likely server
  miss, the run of breaks, and the session of a break that is not this
  session (an in-process sub-agent). It goes through the compositor's
  `writeBlock` and is never wider than the terminal. `ReplCompositor`
  declares the optional `writeBlock`.

- 2026-11-18: **New flags `--cache-anchor` and `--thinking-history
  strip|keep`, also for the REPL** (`d01f4ce`, Matthew). They set the
  prompt-cache fix of core (`00b1ac1`): a second rolling cache marker and
  append-only thinking for models that keep it. Both are OFF by default, so
  requests are unchanged. A live A/B on Haiku 5.5 found keep + anchor at 40 to
  44 percent of the cost, with 0 cache misses.
- 2026-11-18: **A sanitizer for untrusted text that a plugin writes to the
  scrollback** (`ac6b555`, `src/ui/sanitize-scrollback.ts`, Frank). It has no
  caller yet.

- 2026-11-18: the live tool preview and the session replay cut the body of a
  tool result with the stored `outcome` of the result (`bodyEnd`, or the core
  `viewPersistedOutcome`), not only with the annotation regex
  (`src/ui/tool-transcript/format.ts`, `tool-view.ts`, `src/session-replay.ts`,
  `src/session-replay-derivers.ts`). The regex stays as the fallback for a
  result with no or a bad `outcome`. The terminal text is the same for the same
  content. One intended fix, display only: a body that itself holds the text
  `\n\n[note:` (for example a log line) is no longer cut at that text. Model
  bytes do not change.
- 2026-11-17: the notice of a target switch names each value that changed
  (`src/startup/turn-notice-text.ts`, `src/ui/turn-notice.ts`), in the order
  credential, provider, model, effort: `[target] Changed credential to
  "second" (was "full")`. Before, it named only the model, so a
  credential-only switch said `Adopted model "m" (was "m")`. This is the text
  of print mode, of host mode and of a sub-agent that follows its lead; the
  `/provider`, `/model` and `/effort` commands of the TUI print their own
  lines, as before. An automatic model adoption keeps its text.
- 2026-11-17: `--resume` starts on the target that the session last used
  (`src/startup/resume-target.ts`). After a `/provider`, `/model` or
  `/effort` in a session, a resume of it uses the provider, credential and
  model of the newest `target_switch` record. Precedence: the `--provider`,
  `--model` and `--credential-name` flags, then the record, then the env,
  then the config. With one of those flags the record is not used. A record
  is checked first: the provider must be installed, the model must be one of
  its models, a named credential must be stored, and the effort of the run
  must be a level of the model. A record of the generic endpoint is used
  only when this run configures an endpoint and a format (flag, env or
  config): the record never gives them. A check that throws (an auth store
  that cannot be read) counts as a record that cannot be used. If not, the
  session starts on the usual target with one notice. The effort of the
  record is not restored.
- 2026-11-17: A RUNNING sub-agent follows a target switch of its lead, in
  place (`src/startup/target-control-worker.ts`). A worker reads its control
  file path and key from its env at boot and removes them, so its own tools
  never see the key. It polls the file each second, checks each line (mac,
  lead session id, sequence number), and applies the follow rule: it
  follows only when it uses the lead's old credential and provider, keeps
  its own model when the new provider has it, and keeps its own effort when
  the model has it. It resolves the auth from the store and switches its
  own core. A line that fails a check gives one diagnostic and changes
  nothing. The worker removes the file when it ends. Its own sub-agents
  follow the same way. Any tool can put a file at the control path, so the
  open does not block and does not follow a symlink, and only a regular
  file of this user is read: a FIFO, a symlink or a directory there is
  ignored with one diagnostic and cannot stop the worker.
- 2026-11-17: Switch the credential, provider, model or effort at any time
  in the TUI, also during a turn or a quota wait, with no restart.
  - `/provider [credential] [model]` (alias `/credential-name`): the
    credential gives the provider. The model stays when the new provider
    has it. If not, the command asks for a model and changes nothing.
  - `/model [model-id]`: a model of the live provider.
  - `/effort [level|default]`: a level of the live model.
  - With no argument, each command lists the valid values. A value on the
    right that is not valid any more resets, and the command says so.
  - The core ends the wait, builds the system prompt again, and discards
    the old thinking. The prompt cache starts again after a switch.
  - `src/startup/live-target.ts` follows each change for the TUI and for
    host mode (ACP): it writes `MINIMAL_AGENT_MODEL`,
    `MINIMAL_AGENT_PROVIDER`, `MINIMAL_AGENT_CREDENTIAL_NAME` and
    `MINIMAL_AGENT_EFFORT`, sets `ctx.queryTarget`, and emits the plugin
    bus event `target.didSwitch` with `{from, to}`.
  - The ModelInfo tool and new sub-agents now get the live provider. Before,
    they kept the boot provider after a switch.
  - The TUI session gives the core the stored credential names, so an
    unknown credential name is refused.
- 2026-11-12: A compiled binary carries every first-party plugin.
  `scripts/gen-embedded-plugins.ts` writes a table of literal `import()`
  thunks plus text and file imports for each plugin dir with a
  `manifest.json` or `provider.json`. `scripts/compile.ts` maps
  `#embedded-plugins` to it (from source, `package.json#imports` names an
  empty stub), and `src/index.ts` registers it with core. User and
  project copies still win by id. A release embeds a `git archive` of the
  plugins HEAD (or `MA_PLUGINS_SHA`), not the working tree. The hidden
  `<binary> __run <plugin-id>/<script> [args]` runs an embedded entry
  script (manifest `scripts`): a path or an unknown id exits 64.
  `compile-e2e.sh` checks the plugin and provider counts from an empty
  HOME, the user shadow, `__run`, and a BackgroundRun job plus a
  SpawnAgent child against a mock model with no bun on PATH. Removed:
  `scripts/bundle-plugins.ts`, `plugins.bundle.json`, the
  `<cli>/plugins` root and `compiledPluginsRoot`.
- 2026-11-04: Root help reads the core plugin catalog (manifest JSON only,
  no plugin module import). A new HOST MODES section lists usable host
  modes with their plugin id. PLUGIN NOTES keeps the static block first,
  then the plugin `cli.helpSections`, by plugin id, then declared order.
  `--help --all` also shows disabled host modes and off plugins with the
  reason (`cli`, `env`, `config`, `manifest`, `platform`, `invalid`,
  `permission`, `collision`). `--all` keeps its meaning outside help
  (`auth-status plan --all`). `--host-mode <id> --help` prints help for
  that host mode (description, plugin id, args, examples). An unknown id
  exits 2 with the help error format. JSON help has the new sections.
- 2026-11-04: `--help --json` and `--help --output-format json` print the
  help model as JSON (with `contractVersion`) for root help and for every
  command help form (`<cmd> --help --json`, `help <cmd> --json`). No color,
  no wrap. `--format` still selects the endpoint surface, so `--help
  --format json` prints text help. An unknown help path still prints the
  text error on stderr and exits 2. LEARN MORE names the new form.
- 2026-11-02: `auth-status plan [<credential>] [--all] [--table] [--parallel <n>]`.
  It shows the plan, seat, role, usage windows with reset times, and
  overage for each stored credential whose provider plugin has a
  `fetchAccountPlan` hook. It calls account endpoints only, so it spends no
  model quota. It refreshes an expired OAuth token first and retries once
  on HTTP 401. It marks credentials that share one account and
  organization, because they share one quota. Rows with no plan lookup are
  hidden unless you pass `--all` or name one credential. `--parallel` is 4
  by default, 8 at most.
- 2026-11-02: `bun run compile:dev`, `bun run compile:release`, and
  `bun run compile:release:all` build a standalone binary into `dist/`
  (`scripts/compile.ts`). `compile:dev` bundles the core working tree at
  `../minimal-agent-core`. `compile:release` bundles a `git archive` of the
  core commit pinned in `package.json`. `compile:release:all` builds every
  release target (darwin-arm64, darwin-x64, linux-x64, linux-arm64). The
  binary does not read `bunfig.toml` or `.env` from its cwd. Each native
  build is smoke-tested (`--help`, `plugins`) and then checked by
  `scripts/compile-e2e.sh`. Only a build that passes replaces the binary at
  the output path. `compile:release` fails its checks until the core pin
  holds the core embedded-prompts and host-core-modules commits.
- 2026-11-02: `scripts/compile-e2e.sh [BINARY]` runs a compiled binary the
  way a user does: a copy outside the repo, a fresh HOME, a hostile
  `bunfig.toml` and `.env` in the cwd, a disk plugin that imports core,
  `-p`, and the REPL in tmux (skipped without tmux). The default binary is
  `dist/minimal-agent`.

### Fixed

- 2026-11-18: **Tests that start the CLI in a temp home no longer download
  plugin binaries.** `tempHomeSpawnEnv()` now also sets
  `MINIMAL_AGENT_NO_BINARY_SETUP=1`. A run with the startup header (the REPL)
  in a fresh home installed every plugin binary again: in
  `plugin-ui-routes.test.ts` that download was 6.6 s of a 7 s test, and on a
  busy machine the child hit its 30 s limit. The test now takes about 0.3 s.
  Only test support changes.
- 2026-11-18: a `⚠ warn` or `✗ error` block no longer starts on the row of
  the response that is streaming. Before, the diagnostic sink wrote to
  stderr, the stdio interceptor turned that into `writeStream`, and the
  block began where the last response row ended: `Hi again! What would
  you like to work on? …  ⚠ warn  cache.anomaly · 08:08:25`. Now the sink
  writes through the new `Compositor.writeBlock`. It holds the block
  until the row ends (the next line feed of the response, or the end of
  the turn) and then writes it on rows of its own. It does not end the
  row itself: mdstream rewrites its open row at the line feed, so a line
  feed in between left the raw text in scrollback twice. Print mode and
  runs without the live area still write the sink to stderr.

- 2026-11-18: `/provider` (and `/credential-name`) take a credential name
  that has spaces, such as `anthropic:Anthropic Plan (OAuth)`. Before, the
  argument was split on each space, so such a credential could not be
  selected, also not in quotes. Now the credential is the longest start of
  the argument that names a stored credential, and the rest is the model;
  a quoted name (`"..."` or `'...'`) also works. The list from `/provider`
  shows a name with spaces in quotes, so a copied line is a working
  argument. `/model` and `/effort` accept a quoted value too.

- 2026-11-13: a live area taller than the terminal no longer repeats in
  scrollback. The compositor now clips the frame to the terminal rows
  minus 2, drops footer rows first, and shows `… +N more rows`. Before,
  a tall footer (for example a 6-worker fleet panel in a 13-row window)
  left a copy of the status and queue rows in scrollback on each spinner
  frame, a blank row on each footer tick, and blank rows between tool
  output rows. With no row count from the terminal, the compositor reads
  `$LINES`.
- 2026-11-02: the CLI version comes from a static import of its
  `package.json`. A compiled binary now shows the same version as a run
  from source. Before, it read `package.json` from disk and a binary
  showed `0.0.0`.
- 2026-11-01: a second `--resume` keeps each tool call that a kill cut off,
  with its note, once and in place. Before, the second resume dropped the
  cut-off `tool_use`. The fix needs core `cdbb483`.
- 2026-11-01: plugin `ui` modules load by the path text. Under a linked
  path (for example macOS `/var` to `/private/var`), plugin styles from
  `ui.setup` now reach the handler.
- 2026-11-01: a plain Edit or Write diff from core gets diff colors when no
  code highlighter is active (S41).

### Changed

- 2026-11-18: Docs only. `AGENTS.md` no longer points to the umbrella
  `bun run link:reset`, which is removed: inside the umbrella, an install in
  this repo is the root workspace install, so that command put the local core
  link back and did not test the pin. To test the committed pin and
  `bun.lock`, use the umbrella `bun run pins:verify cli`. To update
  `bun.lock` after a dependency change, use `bun run pins:lock cli`.

- 2026-11-11: Plugin roots are now 3 tiers: project
  (`<cwd>/.agents/minimal-agent/plugins`), user (`~/.minimal-agent/plugins`),
  and embedded (`<cli>/plugins` plus the `../minimal-agent-plugins` checkout or
  the `MINIMAL_AGENT_PLUGIN_SIBLINGS` dirs). Precedence: project, user,
  embedded. The home tier `~/.agents/plugins` is removed, and the CLI no
  longer reads `<cwd>/.agents/plugins`. If one of these old roots holds plugin
  packages, the CLI prints an "ignored legacy plugin root" warning (scrollback
  and file log) and moves nothing. When a checkout holds a plugin package (dev
  mode), the user tier is empty and the CLI does not clone the plugins repo.
  Install mode keeps the first-run clone (`pluginSync`,
  `MINIMAL_AGENT_NO_PLUGIN_SYNC=1`).
- 2026-11-04: root `--help` uses the new layout: USAGE, EXAMPLES,
  COMMANDS, FLAGS, ENVIRONMENT, PLUGIN NOTES, LEARN MORE. COMMANDS lists
  each top-level command with its summary, under its group. FLAGS lists
  the global flags under their group headings. Each row shows a short
  summary plus the default and the env name. Long notes moved to command
  help. The Auth and Info sections are gone: `--auth-method`, `--email`,
  and `--name` are in `login --help`, `--print-format` is in
  `providers models --help`. ENVIRONMENT shows bare names (`DEBUG`, not
  `DEBUG=1`) with the value in the summary. The URL moved to LEARN MORE.
- 2026-11-04: `<cmd> --help`, `<cmd> -h` and `help <cmd>` now print command
  help instead of root help. `help --help` and `help -h` print the help
  command's own help. `help <unknown>` and `<cmd> <unknown> --help` print an
  error and one hint line with suggestions on stderr and exit 2 (before:
  root help, exit 0).
- 2026-11-03: `--help` text fixes. The `Start here` and `Command map`
  columns line up. The `Docs` section names the real paths (this repo has
  `CHANGELOG.md` and `docs/tui/`, the other docs are in core). New env
  rows: `MINIMAL_AGENT_LOG_STDERR`, `MINIMAL_AGENT_PLUGIN_SIBLINGS`,
  `MINIMAL_AGENT_AUTO_ASK`, `MINIMAL_AGENT_AUTO_COMPACT`. The `NERD_FONT`
  row is gone (no code reads it). `--print-format` says it applies to
  `providers models`. The disabled-plugin row lists every plugin that ships
  off.
- 2026-11-01: `--list-plugins` (`plugins list`) also lists the plugins in the
  dev checkout root: `../minimal-agent-plugins` next to the CLI repo, or the
  dirs in `MINIMAL_AGENT_PLUGIN_SIBLINGS` (S40). Before, it did not show them.
- 2026-11-01: only the interactive REPL loads plugin `ui` modules and passes
  the terminal handler env (S35). Host mode, `--prompt`, and the json routes
  import no `ui` module.
- 2026-11-01: the plugin module loader checks real paths (S35). It refuses
  core code (the installed core package, or any dir whose `package.json`
  names `@minimal-agent/core`) and any module outside the plugin root.

### Added

- 2026-10-31: `src/architecture/flag-ownership.test.ts` (spec S26). No flag
  name is defined both in core config and in the CLI flag specs. Core's
  migration manifest classifies both sides: core config is the installed
  core's `src/config/` (plus files the manifest keeps there), and the CLI
  flag specs are this repo's `src/` plus the installed core files the
  manifest sends to the CLI. Core files are read through the installed
  `@minimal-agent/core` package, so the check holds after the group move.
  Core is pinned to main `bb2d318`, which splits the system-prompt override
  keys (core config) from their CLI flags.

- 2026-10-31: Runtime dependency on `@minimal-agent/core`, installed from a
  `git+ssh` URL and pinned to a commit. `core-public-contract.ts` is now `exported`: every
  contract subpath, including `./plugin-api`, resolves from the installed
  package. `core-dependency.test.ts` enforces the pin and smoke-tests the
  public subpaths. Core is private, so CI and release clone it with a
  read-only deploy key on minimal-agent-core (secret `CORE_DEPLOY_KEY`, no
  personal access token), with GitHub's SSH host key pinned. The `git+ssh`
  form matters: Bun fetches `git+https` GitHub URLs as API tarballs, which
  ignore git credentials.

- 2026-08-07 (commit `1309859`): Standalone scaffold. Bun package with
  package/tooling/CI/release workflows, commit hooks, injected I/O smoke tests,
  and AST-enforced core import ratchets backed by a genuine-Node preflight for
  the TypeScript 7 `typescript/unstable/*` API (exact-pinned 7.0.2,
  `engines.node >=22.18.0`). Zero runtime dependencies. Proprietary license.
