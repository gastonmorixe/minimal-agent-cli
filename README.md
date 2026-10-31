# minimal-agent-cli

The terminal and process host for minimal-agent.

This package is the Program 3A standalone scaffold from MA-394837. It owns command-line startup, process exit behavior, terminal interaction, output projection, and local plugin discovery. Runtime composition and the full terminal executable remain in core until the Program 3B cutover.

## Development

Requires Bun 1.4.2 or newer. The product itself runs on Bun. Architecture checks additionally require Node 22.18.0 or newer because they execute TypeScript source with Node's built-in type stripping. Set `NODE=/path/to/node` to select a compatible executable.

The architecture checker also imports the explicitly unstable `typescript/unstable/ast` and `typescript/unstable/sync` surfaces. TypeScript is therefore pinned exactly to 7.0.2. Updating TypeScript or the architecture-check Node baseline may require coordinated checker changes.

```sh
bun install
bun run check
bun run start -- --help
```

The package has one runtime dependency, `@minimal-agent/core`, installed from git and pinned to a commit or tag. It must consume only declared public package exports and must never import sibling repositories or `minimal-agent-core/src/**`.

Current scaffold behavior:

- no arguments, `-h`, or `--help` print help and exit 0
- `-V` or `--version` print the package version and exit 0
- unknown arguments print a diagnostic to stderr and exit 2

## Commits

Commit subjects follow Conventional Commits. `bun install` configures the Husky `commit-msg` hook, which runs Commitlint and, during minimal-agent sessions, checks the required session-local `Co-authored-by` audit trailer.

## Releases

Stable releases are created by pushing an annotated `v<version>` tag that exactly matches `package.json`. The GitHub release workflow runs the full package gate first. This repository does not publish nightlies and is not published to a public package registry.

Creating the GitHub repository, pushing it, and adding its umbrella submodule pin require explicit user authorization and are intentionally outside this scaffold change.

## License

Proprietary. All rights reserved. See [LICENSE](LICENSE).
