/**
 * `--help` text + embedded-package-version helper for the CLI entry
 * point.
 *
 * Root help comes from the built-in registry: `buildHelpModel` makes the
 * help model (SPEC-HELP 8.3), and `renderLegacyRoot` draws it in today's
 * layout (plan M-8c). Pure presentation, no startup state.
 *
 * @module startup/help
 */

import pkg from "../../package.json" with { type: "json" }
import { builtinRegistry } from "../cli/registry/index.ts"
import { type CommandOutput, writeCommandRows } from "../ui/command-output.ts"
import { renderLegacyRoot } from "../ui/help/legacy-root.ts"
import { buildHelpModel } from "../ui/help/model.ts"
import { resolveHelpPolicy } from "../ui/help/policy.ts"

/** Layout and color for {@link renderHelp}. */
export interface RenderHelpOptions {
  /** Wrap width in cells. Omit for no wrapping. */
  readonly width?: number
  /** `false` makes the renderer strip every SGR. Default `true`. */
  readonly color?: boolean
}

/** Inputs of {@link printHelp} that the policy reads (SPEC-HELP R-28, R-29). */
export interface PrintHelpOptions {
  /** Explicit wrap width. Wins over every other width source. */
  readonly columns?: number
  /** `--no-color` was passed. */
  readonly noColor?: boolean
  /** Environment for `COLUMNS`, `NO_COLOR`, and `TERM`. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** A help sink. `isTTY` and `columns` are read when the stream has them. */
export type HelpOutput = CommandOutput & { readonly isTTY?: boolean; readonly columns?: number }

/**
 * The CLI's semver from its own `package.json`, or `"0.0.0"` when the
 * field is missing. The manifest is a static JSON import, not a file read:
 * Bun inlines it at build time, so a `bun build --compile` binary (which has
 * no `package.json` on disk) reports the same version as a run from source.
 */
export function readEmbeddedPackageVersion(): string {
  const version: unknown = (pkg as { version?: unknown }).version
  return typeof version === "string" ? version : "0.0.0"
}

/**
 * Render the full `--help` usage text without writing to stdout. Pure: the
 * default is color on and no wrapping. {@link printHelp} resolves the policy.
 */
export function renderHelp(opts: RenderHelpOptions = {}): string[] {
  return renderLegacyRoot(buildHelpModel(builtinRegistry()), opts)
}

/**
 * Print the full `--help` usage text. Width and color come from
 * {@link resolveHelpPolicy} for `output`: color only on a TTY with no
 * `NO_COLOR`, no `TERM=dumb`, and no `--no-color`.
 */
export function printHelp(output: HelpOutput = process.stdout, opts: PrintHelpOptions = {}): void {
  const policy = resolveHelpPolicy({
    env: opts.env ?? process.env,
    isTTY: output.isTTY,
    columns: { explicit: opts.columns, output: output.columns, stdout: process.stdout.columns },
    flags: { noColor: opts.noColor },
  })
  writeCommandRows(renderHelp(policy), output)
}
