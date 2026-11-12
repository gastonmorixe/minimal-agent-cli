# minimal-agent-cli

`minimal-agent-cli` owns the terminal and process host for minimal-agent. It is a standalone Bun package and repository, not a workspace nested inside `minimal-agent-core`. It owns the `minimal-agent` bin.

## Run the CLI

```sh
bun install
bun run src/index.ts --help          # every command and flag
bun run src/index.ts                 # interactive REPL
bun run src/index.ts -p "hi"         # one prompt, then exit
bun run src/index.ts --host-mode acp # hand the process to the ACP plugin host mode
```

`src/index.ts` is the bin (`package.json#bin`). It calls `src/main.ts`, which does the startup work. `--host-mode <id>` needs a loaded, enabled plugin that declares that `hostModes[]` id. The `acp` mode comes from `ma-acp-plugin` in `minimal-agent-plugins`. Its host-mode argument `--approval` (off by default) turns on the approval gate. See that plugin's README. Terminal renderer docs are in `docs/tui/`. User-facing usage is in [`README.md`](README.md).

## Ownership

- CLI-owned concerns: the `minimal-agent` bin, argument parsing, stdout/stderr projection, terminal UI, interactive input, local startup orchestration, host-mode dispatch, plugin root discovery, and process exit behavior.
- Core-owned concerns: agent loop, canonical model/provider contracts, durable session records and repair, auth/network implementations, and SDK ports.
- Shared contracts belong in published package exports: the `@minimal-agent/core/*` subpaths listed in `src/architecture/core-public-contract.ts`. The plugin contract is `@minimal-agent/core/plugin-api/*`.

## Boundary rule

Never import `minimal-agent-core/src/**` or any other repository's source tree. Do not make cross-repository relative imports, path aliases, symlinks, or vendored copies to bypass this rule.

Only consume declared public package exports. In particular, do not expose or import legacy transport compatibility types (`TransportFn`, `SendOptions`, `StreamedResponse`) across the CLI/core boundary. CLI integration must use stable SDK ports, `AgentEvent`/`EventSink`, canonical DTOs, and future named core runtime factories.

## Dependencies

Runtime dependencies stay empty by policy, with one approved exception: `@minimal-agent/core`. Use Bun's standard library and local TypeScript. Add any other dependency only with explicit product approval and a matching test.

`@minimal-agent/core` installs from a `git+ssh` URL pinned to a full commit SHA or a release tag, never a branch. Keep the `git+ssh` form: Bun turns `git+https://github.com/...` into a GitHub API tarball download that ignores git credentials, while for `git+ssh` it runs `git clone` (HTTPS first, then SSH). `src/architecture/core-dependency.test.ts` enforces the pin and proves every contract subpath resolves. To bump core, change the SHA or tag in `package.json` and run `bun install`. For live development against a local core checkout, use the umbrella `bun run link:dev` (and `bun run link:reset` to return to the pin). All repos are private, and the GitHub Actions token can read only this repo, so this repo's CI cannot install core. Its `ci.yml` runs commitlint only, and `release.yml` validates the tag and publishes without re-running the gate. The full gate runs in the umbrella monorepo CI against this repo's pin.

## Quality gate

```sh
bun run check
```

The gate runs TypeScript, oxlint, Biome format/import checks, then Bun tests. Keep tests colocated as `src/**/*.test.ts`.

The three config files extend `@minimal-agent/config`:

- `biome.json` extends `@minimal-agent/config/biome` and keeps `$schema` and `files.includes`. It also keeps a local `assist` block, because this repo uses the default `organizeImports` groups while core and plugins use a custom order. Write that block in OBJECT form. The shorthand `"organizeImports": "on"` does not override the base groups.
- `.oxlintrc.json` extends `./node_modules/@minimal-agent/config/oxlintrc.json` and keeps `categories`, `jsPlugins`, `overrides`, the jsdoc rules and `max-lines`. A bare package name in `extends` fails to parse.
- `tsconfig.json` extends `@minimal-agent/config/tsconfig.json` and keeps `include` only.
- `tsconfig.scripts.json` extends the local `tsconfig.json` for `scripts/compile.ts`.

The product runs on Bun, but architecture checks currently execute TypeScript source under Node using built-in type stripping. Keep Node at 22.18.0 or newer, or set `NODE` to a compatible executable. The checker imports the explicitly unstable `typescript/unstable/ast` and `typescript/unstable/sync` surfaces, so TypeScript is exact-pinned to 7.0.2. Treat TypeScript or Node baseline updates as coordinated checker changes.

## Git and release posture

This is proprietary software. Keep `package.json` license `UNLICENSED` and preserve the proprietary `LICENSE`. Use Conventional Commit subjects. Do not publish, create a GitHub remote, add an umbrella submodule pin, or edit sibling repositories without explicit authorization.
