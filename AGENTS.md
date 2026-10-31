# minimal-agent-cli

`minimal-agent-cli` owns the terminal and process host for minimal-agent. It is a standalone Bun package and future repository, not a workspace nested inside `minimal-agent-core`.

## Ownership

- CLI-owned concerns: argument parsing, stdout/stderr projection, terminal UI, interactive input, local startup orchestration, plugin root discovery, and process exit behavior.
- Core-owned concerns: agent loop, canonical model/provider contracts, durable session records and repair, auth/network implementations, and SDK ports.
- Shared contracts belong in published package exports: the `@minimal-agent/core/*` subpaths listed in `src/architecture/core-public-contract.ts`. The plugin contract is `@minimal-agent/core/plugin-api/*`.

## Boundary rule

Never import `minimal-agent-core/src/**` or any other repository's source tree. Do not make cross-repository relative imports, path aliases, symlinks, or vendored copies to bypass this rule.

Only consume declared public package exports. In particular, do not expose or import legacy transport compatibility types (`TransportFn`, `SendOptions`, `StreamedResponse`) across the CLI/core boundary. CLI integration must use stable SDK ports, `AgentEvent`/`EventSink`, canonical DTOs, and future named core runtime factories.

## Dependencies

Runtime dependencies stay empty by policy, with one approved exception: `@minimal-agent/core`. Use Bun's standard library and local TypeScript. Add any other dependency only with explicit product approval and a matching test.

`@minimal-agent/core` installs from git and is pinned to a full commit SHA or a release tag, never a branch. `src/architecture/core-dependency.test.ts` enforces the pin and proves every contract subpath resolves. To bump core, change the SHA or tag in `package.json` and run `bun install`. For live development against a local core checkout, use the umbrella `bun run link:dev` (and `bun run link:reset` to return to the pin). All repos are private, so CI configures git with the `SUBMODULES_PAT` secret before `bun install`.

## Quality gate

```sh
bun run check
```

The gate runs TypeScript, oxlint, Biome format/import checks, then Bun tests. Keep tests colocated as `src/**/*.test.ts`.

The product runs on Bun, but architecture checks currently execute TypeScript source under Node using built-in type stripping. Keep Node at 22.18.0 or newer, or set `NODE` to a compatible executable. The checker imports the explicitly unstable `typescript/unstable/ast` and `typescript/unstable/sync` surfaces, so TypeScript is exact-pinned to 7.0.2. Treat TypeScript or Node baseline updates as coordinated checker changes.

## Git and release posture

This is proprietary software. Keep `package.json` license `UNLICENSED` and preserve the proprietary `LICENSE`. Use Conventional Commit subjects. Do not publish, create a GitHub remote, add an umbrella submodule pin, or edit sibling repositories without explicit authorization.
