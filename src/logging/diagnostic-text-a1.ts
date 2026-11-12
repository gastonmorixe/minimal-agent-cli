/**
 * Renderers for the A1 sources (net, config, auth) of S14.2. Core now sends
 * the old message AND attrs (dual-write), so these renderers do not run yet.
 * They render when the message is empty, which is the later step. Each one
 * rebuilds the text core used to set.
 *
 * @module logging/diagnostic-text-a1
 */

import { type DiagnosticAttrs, registerDiagnosticText } from "./diagnostic-text.ts"

const str = (a: DiagnosticAttrs, k: string): string => String(a[k] ?? "")

const REFRESH_TEXT: Readonly<Record<string, string>> = {
  "peer-rotated": "peer-process rotated token; retrying with fresh stored value",
  refreshing: "access token expired (401); refreshing",
  stale: "401 persists after token refresh; credentials are stale",
}

/** Register the A1 renderers. Safe to call more than once. */
export function registerA1DiagnosticText(): void {
  registerDiagnosticText(
    "net-dbg.logger-failure",
    (a) => `logger failure (further errors suppressed): ${str(a, "detail")}`,
  )
  registerDiagnosticText("config.parse-error", (a) => `${str(a, "path")}: ${str(a, "detail")}`)
  registerDiagnosticText(
    "network.http3-mode",
    (a) =>
      `MINIMAL_AGENT_HTTP3="${str(a, "mode")}" unrecognized (expected off/opt/force); h3 disabled.`,
  )
  registerDiagnosticText("auth.login", (a) => str(a, "line"))
  registerDiagnosticText("auth.refresh", (a) => REFRESH_TEXT[str(a, "code")] ?? "")
}
