/**
 * Terminal settings from the user config file.
 *
 * Core `loadUserConfig` reads the runtime keys (model, provider, effort,
 * plugin sync, and so on). The keys below only change how the terminal
 * looks or behaves, so the CLI owns them (S41 follow-up). This module reads
 * the same file (`configPath()` from core) with the same JSONC parser and
 * the same lenient rules: a missing, unreadable, or malformed file gives
 * `{}`, a bad value is dropped, unknown keys are ignored. It never throws.
 *
 * Keys and their readers:
 * - `spinner`: spinner preset (`cli/parse-argv.ts`).
 * - `formatter`: formatter command. Parsed for completeness, no reader now.
 * - `formatterArgs`: extra args for the markdown formatter (`cli/parse-argv.ts`).
 * - `header`: startup tree on or off (`cli/non-interactive-defaults.ts`).
 * - `autoAsk`: the editor auto-ASK heuristic (`startup/live-repl.ts`).
 * - `skipQuota`: skip the startup quota row (`main.ts`).
 * - `nerdGlyphCells`: Nerd Font glyph width, 1, 2, or "auto" (`startup/live-repl.ts`).
 * - `scrollback.submittedAt`: the prompt timestamp style (`ui/scrollback-submitted-at.ts`).
 * - `diffWrapLines`: wrap cap for diff rows (`ui/tool-transcript/diff-rows.ts`, set in `main.ts`).
 *
 * `statusBar` is not here: the quota-status plugin reads it from the file
 * itself.
 *
 * @module config/terminal-config
 */

import { existsSync, readFileSync } from "node:fs"

import { configPath, loadUserConfig, type UserConfig } from "@minimal-agent/core/host/config"
import { parseJsonc } from "@minimal-agent/core/plugin-api/utils/jsonc"
import { parseFormatterCommand } from "@minimal-agent/core/plugin-api/utils/shell-args"

/**
 * Configured rendering style for submitted prompt timestamps.
 *
 * - `"inline-locale"`: a dim stamp before the prompt arrow (the default).
 * - `"off"` / `false`: no stamp.
 */
export type SubmittedAtStyle = false | "off" | "inline-locale"

/** The terminal keys of the user config file. */
export interface TerminalConfig {
  /** Spinner preset name. */
  spinner?: string
  /** Formatter command. */
  formatter?: string
  /**
   * Extra args appended to the formatter command after resolution (for
   * example `["--table-fit"]`). Accepts a string array (preferred) or a
   * shell-style string. Override with `--formatter-args` or
   * `MINIMAL_AGENT_FORMATTER_ARGS`.
   */
  formatterArgs?: string[]
  /**
   * Show the startup tree. Unset: on for interactive sessions, off for
   * non-interactive ones. Override with `--header` / `--no-header` or
   * `MINIMAL_AGENT_HEADER=0|1`.
   */
  header?: boolean
  /**
   * Header template (`%%name%%` placeholders) that replaces the startup
   * tree. A plugin renders it. Override with `--header-format` or
   * `MINIMAL_AGENT_HEADER_FORMAT`.
   */
  headerFormat?: string
  /**
   * Auto-ASK heuristic. `true` or unset: on. `false`: off. Override with
   * `MINIMAL_AGENT_AUTO_ASK=0`.
   */
  autoAsk?: boolean
  /** Skip the startup quota check. */
  skipQuota?: boolean
  /**
   * Cell width of a Nerd Font private-use glyph: `1`, `2`, or `"auto"`
   * (probe at startup). Override with `MINIMAL_AGENT_NERD_GLYPH_CELLS`.
   */
  nerdGlyphCells?: 1 | 2 | "auto"
  /**
   * Transcript rows one Edit/Write/ShowDiff diff line may wrap onto before
   * it is cut with a `...(+Nch)` hint. Positive integer, default 5.
   * Override with `MINIMAL_AGENT_DIFF_WRAP_LINES`.
   */
  diffWrapLines?: number
  /** Scrollback settings for submitted user prompts. */
  scrollback?: {
    submittedAt?: SubmittedAtStyle
  }
}

/** The config the CLI uses: the core runtime keys plus the terminal keys. */
export type CliUserConfig = UserConfig & TerminalConfig

/**
 * Normalize the raw `scrollback.submittedAt` value. Returns the value when
 * it is an accepted literal, otherwise `undefined`. Never throws.
 */
export function normalizeSubmittedAtStyle(value: unknown): SubmittedAtStyle | undefined {
  if (value === false || value === "off" || value === "inline-locale") return value
  return undefined
}

/** True for a plain JSON object. */
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x)
}

/** Read and parse the config file. `undefined` for any failure. */
function readConfigObject(): Record<string, unknown> | undefined {
  const path = configPath()
  if (!existsSync(path)) return undefined
  try {
    const parsed = parseJsonc(readFileSync(path, "utf-8"))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Pick and validate the terminal keys from a parsed config object. */
export function parseTerminalConfig(obj: Record<string, unknown>): TerminalConfig {
  const out: TerminalConfig = {}
  if (typeof obj.spinner === "string" && obj.spinner.length > 0) out.spinner = obj.spinner
  if (typeof obj.formatter === "string" && obj.formatter.length > 0) out.formatter = obj.formatter
  // formatterArgs: a string[] (empty and non-string entries dropped) or a
  // shell-style string. Any other shape is ignored.
  if (Array.isArray(obj.formatterArgs)) {
    const arr = obj.formatterArgs.filter((a): a is string => typeof a === "string" && a.length > 0)
    if (arr.length > 0) out.formatterArgs = arr
  } else if (typeof obj.formatterArgs === "string" && obj.formatterArgs.length > 0) {
    const parsed = parseFormatterCommand(obj.formatterArgs)
    if (parsed.length > 0) out.formatterArgs = parsed
  }
  if (typeof obj.header === "boolean") out.header = obj.header
  if (typeof obj.headerFormat === "string" && obj.headerFormat.trim() !== "") {
    out.headerFormat = obj.headerFormat
  }
  if (typeof obj.autoAsk === "boolean") out.autoAsk = obj.autoAsk
  if (typeof obj.skipQuota === "boolean") out.skipQuota = obj.skipQuota
  // nerdGlyphCells: the numbers 1 or 2, or the string "auto". The strings
  // "1" / "2" are rejected to keep the surface tight.
  if (obj.nerdGlyphCells === 1 || obj.nerdGlyphCells === 2 || obj.nerdGlyphCells === "auto") {
    out.nerdGlyphCells = obj.nerdGlyphCells
  }
  if (
    typeof obj.diffWrapLines === "number" &&
    Number.isInteger(obj.diffWrapLines) &&
    obj.diffWrapLines >= 1
  ) {
    out.diffWrapLines = obj.diffWrapLines
  }
  if (isRecord(obj.scrollback)) {
    const submittedAt = normalizeSubmittedAtStyle(obj.scrollback.submittedAt)
    if (submittedAt !== undefined) out.scrollback = { submittedAt }
  }
  return out
}

/** Read the terminal keys from the user config file. Never throws. */
export function loadTerminalConfig(): TerminalConfig {
  const obj = readConfigObject()
  return obj ? parseTerminalConfig(obj) : {}
}

/** Read the full CLI config: core runtime keys plus the terminal keys. */
export function loadCliUserConfig(): CliUserConfig {
  return { ...loadUserConfig(), ...loadTerminalConfig() }
}
