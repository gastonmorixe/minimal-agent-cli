/**
 * `--help` text + embedded-package-version helper for the CLI entry
 * point.
 *
 * Root help comes from the built-in registry: `buildHelpModel` makes the
 * help model (SPEC-HELP 8.3), and `renderLegacyRoot` draws it in today's
 * layout (plan M-8c). Command help (a non-empty path) uses the same model
 * builder and `renderModel` (spec 8.5, plan M-9c). An unknown help path
 * prints an error on stderr (R-17, R-32). Pure presentation, no startup
 * state.
 *
 * @module startup/help
 */

import pkg from "../../package.json" with { type: "json" }
import { builtinRegistry } from "../cli/registry/index.ts"
import type { HelpRequest } from "../cli/registry/resolve.ts"
import { type CommandOutput, writeCommandRows } from "../ui/command-output.ts"
import { renderLegacyRoot } from "../ui/help/legacy-root.ts"
import { buildHelpModel } from "../ui/help/model.ts"
import { resolveHelpPolicy } from "../ui/help/policy.ts"
import { renderModel } from "../ui/help/render-model.ts"
import { c } from "../ui/style/ansi.ts"

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
  /** Command path (canonical names). Empty or absent: root help. */
  readonly path?: readonly string[]
}

/** Inputs of {@link printHelpError} that the policy reads (SPEC-HELP R-29, R-32). */
export interface PrintHelpErrorOptions {
  /** `--no-color` was passed. */
  readonly noColor?: boolean
  /** Environment for `NO_COLOR` and `TERM`. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** The `unknown` kind of {@link HelpRequest}. */
export type UnknownHelpRequest = Extract<HelpRequest, { kind: "unknown" }>

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
 * Render command help for `path` (spec 8.5) without writing it. Pure: the
 * default is color off and no wrapping. {@link printHelp} resolves the policy.
 */
export function renderCommandHelp(path: readonly string[], opts: RenderHelpOptions = {}): string[] {
  return renderModel(buildHelpModel(builtinRegistry(), { path }), opts)
}

/**
 * Print help: root help when `opts.path` is empty or absent, else command
 * help for that path. Width and color come from {@link resolveHelpPolicy}
 * for `output`: color only on a TTY with no `NO_COLOR`, no `TERM=dumb`, and
 * no `--no-color`.
 */
export function printHelp(output: HelpOutput = process.stdout, opts: PrintHelpOptions = {}): void {
  const policy = resolveHelpPolicy({
    env: opts.env ?? process.env,
    isTTY: output.isTTY,
    columns: { explicit: opts.columns, output: output.columns, stdout: process.stdout.columns },
    flags: { noColor: opts.noColor },
  })
  const path = opts.path ?? []
  writeCommandRows(path.length === 0 ? renderHelp(policy) : renderCommandHelp(path, policy), output)
}

/** `"a"`, `"a" or "b"`, `"a", "b", or "c"`. */
function quotedOrList(items: readonly string[]): string {
  const quoted = items.map((item) => `"${item}"`)
  if (quoted.length <= 2) return quoted.join(" or ")
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted.at(-1)}`
}

/**
 * The lines of a help error (R-17, R-32), with no color. Exactly 2 lines:
 * line 1 starts with `error:`, line 2 is the one hint line. The hint names
 * the suggestions first when there are some (at most 3, from the resolver),
 * then tells the user to run `minimal-agent help`.
 */
export function helpErrorLines(req: UnknownHelpRequest, program = "minimal-agent"): string[] {
  const at = [program, ...req.at].join(" ")
  const helpCmd = [program, "help", ...req.at].join(" ")
  const run = `"${helpCmd}" to see the commands.`
  const suggestions = req.suggestions.slice(0, 3)
  const hint =
    suggestions.length > 0
      ? `hint: did you mean ${quotedOrList(suggestions)}? Run ${run}`
      : `hint: run ${run}`
  return [`error: unknown command "${req.token}" for "${at}"`, hint]
}

/**
 * Print a help error to `output` (stderr). Color is decided for `output`
 * itself (R-29): the `error:` label is bold red only on a color stream.
 * The caller exits 2.
 */
export function printHelpError(
  output: HelpOutput,
  req: UnknownHelpRequest,
  opts: PrintHelpErrorOptions = {},
): void {
  const policy = resolveHelpPolicy({
    env: opts.env ?? process.env,
    isTTY: output.isTTY,
    flags: { noColor: opts.noColor },
  })
  const lines = helpErrorLines(req)
  if (policy.color) {
    lines[0] = `${c.boldRed("error:")}${(lines[0] ?? "").slice("error:".length)}`
  }
  writeCommandRows(lines, output)
}
