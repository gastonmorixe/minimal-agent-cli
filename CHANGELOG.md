---
project: "minimal-agent-cli"
title: "Changelog"
type: changelog
status: living
scope: cli
working-dir: "."
created-at: "2026-08-07T13:45:26-0400"
updated-at: "2026-10-31T00:00:00-0400"
format: "Keep a Changelog (pragmatic, date-stamped)"
---

# Changelog

All notable changes to the **minimal-agent-cli** terminal and process host are
documented here. This repository is the Program 3A scaffold for MA-394837: the
terminal client is being moved out of `minimal-agent-core` into this repo
(cutover lands at Program 3B).

## [Unreleased]

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
