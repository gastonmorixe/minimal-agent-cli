/**
 * `--help` text + embedded-package-version helper for the CLI entry
 * point.
 *
 * Root help and command help come from the built-in registry:
 * `buildHelpModel` makes the help model (SPEC-HELP 8.3), and `renderModel`
 * draws it (root: spec 8.4, plan M-8d. Command: spec 8.5, plan M-9c).
 * `renderHelpJson` prints the same model as JSON (R-30, plan M-11). An
 * unknown help path
 * prints an error on stderr (R-17, R-32). Pure presentation, no startup
 * state.
 *
 * @module startup/help
 */

import type { CatalogCliEntry } from "@minimal-agent/core/plugin-api/types/cli-contract"

import pkg from "../../package.json" with { type: "json" }
import { builtinRegistry } from "../cli/registry/index.ts"
import type { FoundHostMode } from "../cli/registry/plugins.ts"
import type { HelpRequest } from "../cli/registry/resolve.ts"
import { type CommandOutput, writeCommandRows } from "../ui/command-output.ts"
import { helpModelJson } from "../ui/help/json.ts"
import { buildHelpModel, buildHostModeHelpModel } from "../ui/help/model.ts"
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

/** Plugin data of root help (M-10). */
export interface HelpPluginOptions {
  /** Plugin catalog (`readHelpCatalog`). Absent: no plugin rows. */
  readonly catalog?: readonly CatalogCliEntry[]
  /** `--help --all`: also show disabled plugin entries (R-12). */
  readonly all?: boolean
}

/** Inputs of {@link printHelp} that the policy reads (SPEC-HELP R-28, R-29). */
export interface PrintHelpOptions extends HelpPluginOptions {
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
 * Render root help (spec 8.4) without writing to stdout. Pure: the default
 * is color on and no wrapping. {@link printHelp} resolves the policy.
 */
export function renderHelp(opts: RenderHelpOptions & HelpPluginOptions = {}): string[] {
  const model = buildHelpModel(builtinRegistry(), pluginModelOptions(opts))
  return renderModel(model, { width: opts.width, color: opts.color !== false })
}

/** The catalog and `--all` options of `buildHelpModel`, with no undefined keys. */
function pluginModelOptions(opts: HelpPluginOptions): HelpPluginOptions {
  return {
    ...(opts.catalog === undefined ? {} : { catalog: opts.catalog }),
    ...(opts.all === true ? { all: true } : {}),
  }
}

/**
 * Render host-mode help (R-19, plan M-10) without writing it. Pure: the
 * default is color off and no wrapping.
 */
export function renderHostModeHelp(found: FoundHostMode, opts: RenderHelpOptions = {}): string[] {
  return renderModel(buildHostModeHelpModel(builtinRegistry(), found), opts)
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
  const policy = helpPolicy(output, opts)
  const path = opts.path ?? []
  writeCommandRows(
    path.length === 0 ? renderHelp({ ...policy, ...opts }) : renderCommandHelp(path, policy),
    output,
  )
}

/** Width and color for `output` (R-28, R-29). */
function helpPolicy(
  output: HelpOutput,
  opts: Pick<PrintHelpOptions, "env" | "columns" | "noColor">,
): { width?: number; color: boolean } {
  return resolveHelpPolicy({
    env: opts.env ?? process.env,
    isTTY: output.isTTY,
    columns: { explicit: opts.columns, output: output.columns, stdout: process.stdout.columns },
    flags: { noColor: opts.noColor },
  })
}

/** Print host-mode help (R-19) to `output`, with the policy of {@link printHelp}. */
export function printHostModeHelp(
  output: HelpOutput,
  found: FoundHostMode,
  opts: Pick<PrintHelpOptions, "env" | "columns" | "noColor"> = {},
): void {
  writeCommandRows(renderHostModeHelp(found, helpPolicy(output, opts)), output)
}

/**
 * The help model for `path` as JSON (SPEC-HELP R-30, plan M-11): root help
 * when `path` is empty or absent, with the plugin sections from
 * `opts.catalog` (M-10). No color, no wrap.
 */
export function renderHelpJson(path: readonly string[] = [], opts: HelpPluginOptions = {}): string {
  return helpModelJson(buildHelpModel(builtinRegistry(), { path, ...pluginModelOptions(opts) }))
}

/** The host-mode help model (R-19) as JSON. */
export function renderHostModeHelpJson(found: FoundHostMode): string {
  return helpModelJson(buildHostModeHelpModel(builtinRegistry(), found))
}

/**
 * Print the help model for `path` as JSON to `output` (stdout). The policy
 * is not read: JSON has no color and no wrap at any width.
 */
export function printHelpJson(
  output: CommandOutput = process.stdout,
  path: readonly string[] = [],
  opts: HelpPluginOptions = {},
): void {
  output.write(renderHelpJson(path, opts))
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
  const hostMode = req.subject === "host-mode"
  const helpCmd = hostMode ? `${program} --help` : [program, "help", ...req.at].join(" ")
  const run = `"${helpCmd}" to see the ${hostMode ? "host modes" : "commands"}.`
  const suggestions = req.suggestions.slice(0, 3)
  const hint =
    suggestions.length > 0
      ? `hint: did you mean ${quotedOrList(suggestions)}? Run ${run}`
      : `hint: run ${run}`
  const what = hostMode ? "host mode" : "command"
  return [`error: unknown ${what} "${req.token}" for "${at}"`, hint]
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
