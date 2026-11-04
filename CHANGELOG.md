---
project: "minimal-agent-cli"
title: "Changelog"
type: changelog
status: living
scope: cli
working-dir: "."
created-at: "2026-08-07T13:45:26-0400"
updated-at: "2026-11-03T00:00:00-0500"
format: "Keep a Changelog (pragmatic, date-stamped)"
---

# Changelog

All notable changes to the **minimal-agent-cli** terminal and process host are
documented here. This repository is the Program 3A scaffold for MA-394837: the
terminal client is being moved out of `minimal-agent-core` into this repo
(cutover lands at Program 3B).

## [Unreleased]

### Added

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

- 2026-11-02: the CLI version comes from a static import of its
  `package.json`. A compiled binary now shows the same version as a run
  from source. Before, it read `package.json` from disk and a binary
  showed `0.0.0`.
- 2026-11-01: a second `--resume` keeps each tool call that a kill cut off,
  with its note, once and in place. Before, the second resume dropped the
  cut-off `tool_use`. The fix needs core `c0a35af`.
- 2026-11-01: plugin `ui` modules load by the path text. Under a linked
  path (for example macOS `/var` to `/private/var`), plugin styles from
  `ui.setup` now reach the handler.
- 2026-11-01: a plain Edit or Write diff from core gets diff colors when no
  code highlighter is active (S41).

### Changed

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
  Core is pinned to main `57181d5`, which splits the system-prompt override
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
