import { describe, expect, it } from "bun:test"

import type { AccountPlanInfo } from "../ui/chrome/auth-status.ts"
import { runAuthStatusPlanCommand } from "./auth-status.ts"

function noAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI is the point
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

function capture(): { out: { write: (s: string) => void }; text(): string } {
  const lines: string[] = []
  return { out: { write: (s) => lines.push(s) }, text: () => noAnsi(lines.join("")) }
}

const NOW = Date.parse("2026-11-01T21:50:00Z")

function entry(credentialName: string, authKind: "oauth" | "api-key" = "oauth") {
  return {
    providerId: "anthropic",
    displayName: "Anthropic",
    authKind,
    source: "store" as const,
    credentialName,
  }
}

const SEATED: AccountPlanInfo = {
  accountId: "acct-1",
  email: "a@example.com",
  organizationId: "org-1",
  organizationName: "Example Org",
  role: "membership_admin",
  plan: "Team · Max 5x seat",
  hasPlan: true,
  windows: [
    { id: "5h", utilization: 0.21, resetAtMs: Date.parse("2026-11-01T23:00:00Z") },
    { id: "7d", utilization: 0.95 },
  ],
  overage: { enabled: false, reason: "org_level_disabled" },
  details: [{ key: "rate_limit_tier", label: "rate tier", value: "default_claude_max_5x" }],
}

describe("runAuthStatusPlanCommand", () => {
  it("prints plan, identity, windows, overage, and details without tokens", async () => {
    const cap = capture()
    const code = await runAuthStatusPlanCommand({
      discover: () => [entry("work")],
      resolveAuth: () => ({ kind: "oauth", token: "secret-token" }),
      fetchPlan: async () => SEATED,
      output: cap.out,
      now: () => NOW,
    })
    const text = cap.text()
    expect(code).toBe(0)
    expect(text).toContain("work (anthropic) Team · Max 5x seat")
    expect(text).toContain("a@example.com @ Example Org (membership_admin)")
    expect(text).toContain("5h 21% resets in 1h 10m")
    expect(text).toContain("7d 95%")
    expect(text).toContain("overage off (org_level_disabled)")
    expect(text).toContain("rate tier default_claude_max_5x")
    expect(text).not.toContain("secret-token")
  })

  it("flags credentials that share one account and organization", async () => {
    const cap = capture()
    await runAuthStatusPlanCommand({
      discover: () => [entry("oauth-8"), entry("oauth-11"), entry("oauth-12")],
      resolveAuth: (_id, name) => ({ kind: "oauth", token: name ?? "" }),
      fetchPlan: async (_id, auth) =>
        auth.kind === "oauth" && auth.token === "oauth-12"
          ? { ...SEATED, accountId: "acct-2" }
          : SEATED,
      output: cap.out,
      now: () => NOW,
    })
    const text = cap.text()
    expect(text).toContain("shares quota with oauth-11")
    expect(text).toContain("shares quota with oauth-8")
    expect(text.match(/shares quota/g)?.length).toBe(2)
  })

  it("hides skipped credentials unless --all or a name is given", async () => {
    const deps = {
      discover: () => [entry("work"), entry("key", "api-key")],
      resolveAuth: (_id: string, name?: string) =>
        name === "key"
          ? ({ kind: "api-key", key: "k" } as const)
          : ({ kind: "oauth", token: "t" } as const),
      fetchPlan: async (_id: string, auth: { kind: string }) =>
        auth.kind === "oauth" ? SEATED : null,
      now: () => NOW,
    }
    const hidden = capture()
    await runAuthStatusPlanCommand({ ...deps, output: hidden.out })
    expect(hidden.text()).not.toContain("key (anthropic)")

    const all = capture()
    await runAuthStatusPlanCommand({ ...deps, all: true, output: all.out })
    expect(all.text()).toContain("key (anthropic) no plan lookup for api-key")

    const named = capture()
    await runAuthStatusPlanCommand({ ...deps, credential: "key", output: named.out })
    expect(named.text()).toContain("no plan lookup for api-key")
  })

  it("refreshes an expired token before the lookup", async () => {
    const cap = capture()
    let token = "old"
    const seen: string[] = []
    const code = await runAuthStatusPlanCommand({
      discover: () => [{ ...entry("work"), credentialInfo: { usable: true, expiresAt: NOW - 1 } }],
      resolveAuth: () => ({
        kind: "oauth",
        token,
        refresh: async () => {
          token = "new"
          return { token }
        },
      }),
      fetchPlan: async (_id, auth) => {
        seen.push(auth.kind === "oauth" ? auth.token : "")
        return SEATED
      },
      output: cap.out,
      now: () => NOW,
    })
    expect(code).toBe(0)
    expect(seen).toEqual(["new"])
  })

  it("retries once after a refresh when the lookup returns 401", async () => {
    const cap = capture()
    let token = "stale"
    const code = await runAuthStatusPlanCommand({
      discover: () => [entry("work")],
      resolveAuth: () => ({
        kind: "oauth",
        token,
        refresh: async () => {
          token = "fresh"
          return { token }
        },
      }),
      fetchPlan: async (_id, auth) => {
        if (auth.kind === "oauth" && auth.token === "stale") {
          throw new Error("/api/oauth/profile returned HTTP 401")
        }
        return SEATED
      },
      output: cap.out,
      now: () => NOW,
    })
    expect(code).toBe(0)
    expect(cap.text()).toContain("Team · Max 5x seat")
  })

  it("returns 1 with a login hint when the refresh token is rejected", async () => {
    const cap = capture()
    const code = await runAuthStatusPlanCommand({
      discover: () => [{ ...entry("dead"), credentialInfo: { usable: true, expiresAt: NOW - 1 } }],
      resolveAuth: () => ({
        kind: "oauth",
        token: "t",
        refresh: async () => {
          throw new Error("Anthropic OAuth refresh failed (400): invalid_grant")
        },
      }),
      fetchPlan: async () => SEATED,
      output: cap.out,
      now: () => NOW,
    })
    expect(code).toBe(1)
    expect(cap.text()).toContain("provider anthropic login --name dead")
  })

  it("never refreshes credentials of providers without a plan lookup", async () => {
    const cap = capture()
    let refreshed = 0
    const code = await runAuthStatusPlanCommand({
      discover: () => [
        { ...entry("other"), providerId: "other", credentialInfo: { usable: true, expiresAt: 0 } },
      ],
      resolveAuth: () => ({
        kind: "oauth",
        token: "t",
        refresh: async () => {
          refreshed += 1
          return { token: "t2" }
        },
      }),
      supportsPlan: (id) => id === "anthropic",
      fetchPlan: async () => SEATED,
      all: true,
      output: cap.out,
      now: () => NOW,
    })
    expect(code).toBe(0)
    expect(refreshed).toBe(0)
    expect(cap.text()).toContain("other (other) provider has no plan lookup")
  })

  it("returns 1 for an unknown credential name", async () => {
    const cap = capture()
    const code = await runAuthStatusPlanCommand({
      credential: "missing",
      discover: () => [entry("work")],
      output: cap.out,
    })
    expect(code).toBe(1)
    expect(cap.text()).toContain('no stored credential "missing"')
  })

  it("renders a Markdown table with --table", async () => {
    const cap = capture()
    await runAuthStatusPlanCommand({
      discover: () => [entry("work")],
      resolveAuth: () => ({ kind: "oauth", token: "t" }),
      fetchPlan: async () => SEATED,
      table: true,
      output: cap.out,
      now: () => NOW,
    })
    const lines = cap.text().trim().split("\n")
    expect(lines[0]).toBe(
      "| provider | credential | plan | seat | account | role | usage | overage | note |",
    )
    expect(lines[2]).toContain("| anthropic | work | Team · Max 5x seat | yes |")
    expect(lines[2]).toContain("5h 21% (resets in 1h 10m); 7d 95%")
  })
})
