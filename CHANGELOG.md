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

- 2026-10-31: Runtime dependency on `@minimal-agent/core`, installed from git
  and pinned to a commit. `core-public-contract.ts` is now `exported`: every
  contract subpath, including `./plugin-api`, resolves from the installed
  package. `core-dependency.test.ts` enforces the pin and smoke-tests the
  public subpaths. CI and release configure git with `SUBMODULES_PAT` before
  `bun install`, because core is private.

- 2026-08-07 (commit `1309859`): Standalone scaffold. Bun package with
  package/tooling/CI/release workflows, commit hooks, injected I/O smoke tests,
  and AST-enforced core import ratchets backed by a genuine-Node preflight for
  the TypeScript 7 `typescript/unstable/*` API (exact-pinned 7.0.2,
  `engines.node >=22.18.0`). Zero runtime dependencies. Proprietary license.
