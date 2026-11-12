/**
 * The `version` command (`version`, `--version`, `-V`), plan task 2.1.
 *
 * Runs before any startup side effect: no env write, no config load, no
 * network, no session, no credentials check. It reads only the build info
 * (`src/cli/build-info.ts`).
 *
 * @module commands/version
 */

import { type BuildInfo, buildInfo, formatVersionLine } from "../cli/build-info.ts"
import type { BuiltinRegistry } from "../cli/registry/types.ts"
import { flagTokens } from "../cli/unknown-flags.ts"
import { wantsJsonHelp } from "../ui/help/json.ts"

/**
 * True when raw argv asks for the version: `version` as the first token, or
 * a `--version` / `-V` flag token. A flag value (`--prompt --version`) and
 * the args after `--host-mode <id>` or `--` do not count.
 */
export function isVersionRequest(raw: readonly string[], reg: BuiltinRegistry): boolean {
  if (raw[0] === "version") return true
  return flagTokens(raw, reg).some((t) => t.name === "--version" || t.name === "-V")
}

/** The version output for `raw`: the one line, or the JSON object with `--json`. */
export function renderVersion(raw: readonly string[], info: BuildInfo = buildInfo()): string {
  if (wantsJsonHelp(raw)) return `${JSON.stringify(info, null, 2)}\n`
  return `${formatVersionLine(info)}\n`
}
