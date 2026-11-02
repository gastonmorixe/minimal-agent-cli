/**
 * Host-owned auth-status command chrome.
 *
 * The command layer reads credentials and returns exit codes; this module owns
 * the terminal rows shown to the user.
 *
 * @module ui/chrome/auth-status
 */

import type { AuthCredentialInfo } from "@minimal-agent/core/host/provider-plugin"
import type { ProviderAuth } from "@minimal-agent/core/sdk/provider"
import { renderCommandTable } from "../command-table.ts"
import { c } from "../style/ansi.ts"

export interface AuthStatusProviderView {
  readonly providerId: string
  readonly displayName: string
  readonly authKind: "oauth" | "api-key"
  readonly source: "store"
  readonly credentialLabel?: string
  readonly credentialName?: string
  readonly credentialInfo?: AuthCredentialInfo
  /** ISO-8601 time of the last store write (login or refresh). */
  readonly updatedAt?: string
  readonly auth: ProviderAuth | null
}

export interface AuthStatusRenderInput {
  readonly providers: readonly AuthStatusProviderView[]
  readonly now: number
}

/**
 * Group providers by providerId so multi-credential providers render as a
 * tree under one heading.
 */
function groupByProvider(
  providers: readonly AuthStatusProviderView[],
): Map<string, AuthStatusProviderView[]> {
  const map = new Map<string, AuthStatusProviderView[]>()
  for (const p of providers) {
    const list = map.get(p.providerId)
    if (list) list.push(p)
    else map.set(p.providerId, [p])
  }
  return map
}

function safeText(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove terminal controls from external metadata
  return value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").trim()
}

function renderCredentialName(p: AuthStatusProviderView, index: number): string {
  return (
    safeText(p.credentialName ?? "") ||
    safeText(p.credentialLabel ?? "") ||
    `Credential ${index + 1}`
  )
}

function renderCredentialStatus(p: AuthStatusProviderView): string {
  const info = p.credentialInfo
  if (!p.auth || info?.usable === false) return c.boldRed("✗")
  return c.boldGreen("✔")
}

function renderDetailLines(info: AuthCredentialInfo | undefined, now: number): string[] {
  if (!info) return []
  const lines: string[] = []
  if (info.accountId) lines.push(c.dim(`account: ${safeText(info.accountId)}`))
  if (info.organizationId) lines.push(c.dim(`org: ${safeText(info.organizationId)}`))
  if (info.scopes && info.scopes.length > 0) {
    lines.push(c.dim(`scopes: ${safeText(info.scopes.join(" "))}`))
  }
  if (typeof info.expiresAt === "number" && Number.isFinite(new Date(info.expiresAt).getTime())) {
    const expired = info.expiresAt <= now
    const expiryLabel = expired
      ? c.boldRed(`expired ${formatRelative(now - info.expiresAt)} ago`)
      : `${new Date(info.expiresAt).toISOString().replace("T", " ").slice(0, 19)} UTC ${c.dim(
          `(in ${formatRelative(info.expiresAt - now)})`,
        )}`
    lines.push(c.dim(`expires: ${expiryLabel}`))
  }
  if (typeof info.hasRefreshToken === "boolean") {
    lines.push(
      c.dim(`refresh: ${info.hasRefreshToken ? c.boldGreen("present") : c.boldYellow("missing")}`),
    )
  }
  for (const detail of info.details ?? []) {
    lines.push(c.dim(`${safeText(detail.label)}: ${safeText(detail.value)}`))
  }
  return lines
}

/**
 * "stored: 4d 2h ago" from the entry's last store write (login or refresh).
 * An expired ACCESS token is normal for an idle slot and refreshes on first
 * use. A long-idle slot is the one whose REFRESH token the server may reject
 * (`invalid_grant`), which needs a new login. Showing the age makes that
 * difference visible.
 */
function renderStoredLine(updatedAt: string | undefined, now: number): string | undefined {
  if (!updatedAt) return undefined
  const ts = Date.parse(updatedAt)
  if (!Number.isFinite(ts)) return undefined
  return c.dim(`stored: ${formatRelative(Math.max(0, now - ts))} ago`)
}

function markdownCell(value: string): string {
  return safeText(value).replace(/\|/g, "/")
}

function plainExpiry(expiresAt: number | undefined, now: number): string {
  if (typeof expiresAt !== "number") return ""
  if (!Number.isFinite(new Date(expiresAt).getTime())) return ""
  if (expiresAt <= now) return `expired ${formatRelative(now - expiresAt)} ago`
  return `${new Date(expiresAt).toISOString().replace("T", " ").slice(0, 19)} UTC (in ${formatRelative(expiresAt - now)})`
}

function plainStored(updatedAt: string | undefined, now: number): string {
  if (!updatedAt) return ""
  const ts = Date.parse(updatedAt)
  if (!Number.isFinite(ts)) return ""
  return `${formatRelative(Math.max(0, now - ts))} ago`
}

function markdownPlan(info: AuthCredentialInfo | undefined): string {
  const detail = info?.details?.find((d) => d.key === "plan" || d.label.toLowerCase() === "plan")
  return detail ? markdownCell(detail.value) : ""
}

function markdownNote(p: AuthStatusProviderView): string {
  if (!p.auth || p.credentialInfo?.usable === false) return "credential unreadable"
  const parts: string[] = []
  if (p.credentialInfo?.hasRefreshToken === false) parts.push("refresh missing")
  if (p.credentialInfo?.scopes && p.credentialInfo.scopes.length > 0) {
    parts.push(`scopes: ${p.credentialInfo.scopes.join(" ")}`)
  }
  return parts.map(markdownCell).join("; ")
}

/**
 * Render the `auth-status --table` Markdown pipe table. Plain text, no ANSI.
 * Columns: provider, credential, kind, status, account, plan, expires,
 * stored, note.
 */
export function renderAuthStatusMarkdown(input: AuthStatusRenderInput): string[] {
  const header =
    "| provider | credential | kind | status | account | plan | expires | stored | note |"
  const separator = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  const rows: string[] = [header, separator]
  for (const [providerId, creds] of groupByProvider(input.providers)) {
    for (const [index, p] of creds.entries()) {
      const credential = p.credentialName ?? p.credentialLabel ?? `Credential ${index + 1}`
      const status = !p.auth || p.credentialInfo?.usable === false ? "unreadable" : "ok"
      const account = [p.credentialInfo?.accountId, p.credentialInfo?.organizationId]
        .filter((v): v is string => Boolean(v))
        .join(" / ")
      rows.push(
        `| ${markdownCell(providerId)} | ${markdownCell(credential)} | ${markdownCell(p.auth?.kind ?? p.authKind)} | ${status} | ${markdownCell(account)} | ${markdownPlan(p.credentialInfo)} | ${markdownCell(plainExpiry(p.credentialInfo?.expiresAt, input.now))} | ${markdownCell(plainStored(p.updatedAt, input.now))} | ${markdownNote(p)} |`,
      )
    }
  }
  return rows
}

/**
 * One credential row for `auth-status prune`.
 */
export interface AuthPruneRowView {
  readonly providerId: string
  readonly credentialName: string
  readonly kind: "oauth" | "api-key"
  readonly verdict: "dead" | "live" | "unknown"
  readonly note?: string
  /** API-key fingerprint (`abc12…34`). Never the full key. */
  readonly maskedKey?: string
}

/**
 * Render `auth-status prune` human rows. Plain text, no ANSI.
 * Mirrors the refresh-all `<provider> <name>: <status>` shape.
 */
export function renderAuthPruneRows(rows: readonly AuthPruneRowView[]): string[] {
  if (rows.length === 0) return ["", "  no stored credentials"]
  return rows.map((r) => {
    const key = r.maskedKey ? ` key ${r.maskedKey}` : ""
    const note = r.note ? ` ${r.note}` : ""
    return `${r.providerId} ${r.credentialName}: ${r.verdict}${key}${note}`
  })
}

/**
 * Render `auth-status prune --table` as a Markdown pipe table.
 * Plain text, no ANSI. Columns: provider, credential, kind, verdict, note.
 */
export function renderAuthPruneMarkdown(rows: readonly AuthPruneRowView[]): string[] {
  const header = "| provider | credential | kind | verdict | note |"
  const separator = "| --- | --- | --- | --- | --- |"
  const out: string[] = [header, separator]
  for (const r of rows) {
    const note = [r.maskedKey ? `key ${r.maskedKey}` : "", r.note ?? ""]
      .filter((v) => v.length > 0)
      .join("; ")
    out.push(
      `| ${markdownCell(r.providerId)} | ${markdownCell(r.credentialName)} | ${markdownCell(r.kind)} | ${r.verdict} | ${markdownCell(note)} |`,
    )
  }
  return out
}

/** Render the `minimal-agent --auth-status` rows. */
export function renderAuthStatusRows(input: AuthStatusRenderInput): string[] {
  if (input.providers.length === 0) {
    return renderCommandTable({
      columns: [{ key: "status" }],
      sections: [],
      empty: "not logged in. Run `minimal-agent provider <id> login`",
    })
  }

  const rows: string[] = [""]
  for (const [providerId, creds] of groupByProvider(input.providers)) {
    if (rows.length > 1) rows.push("")
    rows.push(`  ${c.bold(safeText(creds[0]!.displayName))} ${c.sky(`(${safeText(providerId)})`)}`)
    for (const [index, p] of creds.entries()) {
      if (index > 0) rows.push("")
      const status = renderCredentialStatus(p)
      const kind = c.dim(p.auth?.kind ?? p.authKind)
      const diagnostic =
        !p.auth || p.credentialInfo?.usable === false ? ` ${c.dim("credential unreadable")}` : ""
      rows.push(`    ${c.bold(renderCredentialName(p, index))} ${status} ${kind}${diagnostic}`)
      for (const detail of renderDetailLines(p.credentialInfo, input.now)) {
        rows.push(`      ${detail}`)
      }
      const stored = renderStoredLine(p.updatedAt, input.now)
      if (stored) rows.push(`      ${stored}`)
    }
  }
  return rows
}

/**
 * Format a duration in ms as a short human-readable string.
 * 60s · 5m 20s · 3h 12m · 4d 6h.
 */
export function formatRelative(ms: number): string {
  const abs = Math.abs(ms)
  const sec = Math.round(abs / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`
  const day = Math.floor(hr / 24)
  const remHr = hr % 24
  return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`
}

/**
 * Plan view for one credential. Mirrors core's plugin-api `AccountPlanInfo`
 * field for field. Declared here because the pinned core predates that type;
 * switch to the core import when the pin moves past it.
 */
export interface AccountPlanInfo {
  readonly accountId?: string
  readonly email?: string
  readonly organizationId?: string
  readonly organizationName?: string
  readonly role?: string
  readonly plan?: string
  readonly hasPlan?: boolean
  readonly windows?: readonly { id: string; utilization: number; resetAtMs?: number }[]
  readonly overage?: { enabled: boolean; reason?: string }
  readonly details?: readonly { key: string; label: string; value: string }[]
}

/**
 * One credential row for `auth-status plan`. `plan` is set on success,
 * `error` on failure, and neither when the provider has no plan hook or
 * the credential kind cannot be inspected (`skipped`).
 */
export interface AuthPlanRowView {
  readonly providerId: string
  readonly credentialName: string
  readonly kind: "oauth" | "api-key"
  readonly plan?: AccountPlanInfo
  readonly error?: string
  readonly skipped?: string
  /** Other credential names that share this account and organization. */
  readonly sameAccountAs?: readonly string[]
}

function percent(utilization: number): string {
  return `${Math.round(utilization * 100)}%`
}

function resetIn(resetAtMs: number | undefined, now: number): string {
  if (resetAtMs === undefined) return ""
  const delta = resetAtMs - now
  return delta > 0 ? `resets in ${formatRelative(delta)}` : "reset due"
}

function colorUse(utilization: number, text: string): string {
  if (utilization >= 0.9) return c.red(text)
  if (utilization >= 0.7) return c.yellow(text)
  return c.green(text)
}

function planHeadline(plan: AccountPlanInfo): string {
  const label = safeText(plan.plan ?? "unknown plan")
  if (plan.hasPlan === true) return c.green(label)
  if (plan.hasPlan === false) return c.red(label)
  return label
}

function planIdentity(plan: AccountPlanInfo): string {
  const org = plan.organizationName ?? plan.organizationId
  const parts = [plan.email, org ? `@ ${org}` : undefined, plan.role ? `(${plan.role})` : undefined]
  return safeText(parts.filter((v): v is string => Boolean(v)).join(" "))
}

function planWindows(plan: AccountPlanInfo, now: number): string {
  return (plan.windows ?? [])
    .map((w) => {
      const reset = resetIn(w.resetAtMs, now)
      const use = colorUse(w.utilization, percent(w.utilization))
      return `${safeText(w.id)} ${use}${reset ? ` ${c.dim(reset)}` : ""}`
    })
    .join(c.dim(" · "))
}

function planOverage(plan: AccountPlanInfo): string {
  if (!plan.overage) return ""
  if (plan.overage.enabled) return "on"
  return plan.overage.reason ? `off (${safeText(plan.overage.reason)})` : "off"
}

/** Render `auth-status plan` human rows. */
export function renderAuthPlanRows(rows: readonly AuthPlanRowView[], now: number): string[] {
  if (rows.length === 0) return ["", "  no stored credentials"]
  const out: string[] = [""]
  for (const r of rows) {
    const name = c.bold(safeText(r.credentialName))
    const provider = c.sky(`(${safeText(r.providerId)})`)
    if (r.error) {
      out.push(`  ${name} ${provider} ${c.red("error")} ${c.dim(safeText(r.error))}`)
      continue
    }
    if (!r.plan) {
      out.push(`  ${name} ${provider} ${c.dim(safeText(r.skipped ?? "no plan info"))}`)
      continue
    }
    out.push(`  ${name} ${provider} ${planHeadline(r.plan)}`)
    const identity = planIdentity(r.plan)
    if (identity) out.push(`    ${identity}`)
    const windows = planWindows(r.plan, now)
    if (windows) out.push(`    ${windows}`)
    const overage = planOverage(r.plan)
    if (overage) out.push(`    ${c.dim("overage")} ${overage}`)
    for (const d of r.plan.details ?? []) {
      out.push(`    ${c.dim(safeText(d.label))} ${safeText(d.value)}`)
    }
    if (r.sameAccountAs && r.sameAccountAs.length > 0) {
      out.push(
        `    ${c.yellow("shares quota with")} ${r.sameAccountAs.map((n) => safeText(n)).join(", ")}`,
      )
    }
  }
  return out
}

/**
 * Render `auth-status plan --table` as a Markdown pipe table. Plain text, no
 * ANSI. Columns: provider, credential, plan, seat, account, role, usage,
 * overage, note.
 */
export function renderAuthPlanMarkdown(rows: readonly AuthPlanRowView[], now: number): string[] {
  const out = [
    "| provider | credential | plan | seat | account | role | usage | overage | note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ]
  for (const r of rows) {
    const p = r.plan
    const seat = p?.hasPlan === true ? "yes" : p?.hasPlan === false ? "no" : ""
    const account = p
      ? [p.email, p.organizationName ?? p.organizationId].filter(Boolean).join(" @ ")
      : ""
    const usage = (p?.windows ?? [])
      .map((w) => {
        const reset = resetIn(w.resetAtMs, now)
        return `${w.id} ${percent(w.utilization)}${reset ? ` (${reset})` : ""}`
      })
      .join("; ")
    const note = [
      r.error ? `error: ${r.error}` : "",
      r.skipped ?? "",
      r.sameAccountAs?.length ? `shares quota with ${r.sameAccountAs.join(", ")}` : "",
    ]
      .filter((v) => v.length > 0)
      .join("; ")
    out.push(
      `| ${markdownCell(r.providerId)} | ${markdownCell(r.credentialName)} | ${markdownCell(p?.plan ?? "")} | ${seat} | ${markdownCell(account)} | ${markdownCell(p?.role ?? "")} | ${markdownCell(usage)} | ${markdownCell(p ? planOverage(p) : "")} | ${markdownCell(note)} |`,
    )
  }
  return out
}
