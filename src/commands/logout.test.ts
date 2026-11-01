import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AuthStore } from "@minimal-agent/core/host/auth-store"
import { clearProviderCredentials } from "@minimal-agent/core/host/auth-strategies"
import {
  clearProviderPlugins,
  registerProviderPlugin,
} from "@minimal-agent/core/host/provider-plugin"

import { runLogoutCommand } from "./logout.ts"

function captureOut(): { out: { write: (s: string) => void }; text(): string } {
  const lines: string[] = []
  return {
    out: { write: (s) => lines.push(s) },
    text() {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip
      return lines.join("").replace(/\x1b\[[0-9;]*m/g, "")
    },
  }
}

describe("runLogoutCommand", () => {
  it("removes credentials and reports removed", async () => {
    const cap = captureOut()
    const code = await runLogoutCommand({ clearCredentials: () => true, output: cap.out })
    expect(code).toBe(0)
    const t = cap.text()
    expect(t).toContain("credentials  removed")
    expect(t).toContain("Logged out")
  })

  it("idempotent: nothing to remove still exits 0 with (no entry)", async () => {
    const cap = captureOut()
    const code = await runLogoutCommand({ clearCredentials: () => false, output: cap.out })
    expect(code).toBe(0)
    const t = cap.text()
    expect(t).toContain("(no entry)")
    expect(t).toContain("Logged out")
  })

  it("degrades gracefully when removal throws", async () => {
    const cap = captureOut()
    const code = await runLogoutCommand({
      clearCredentials: () => {
        throw new Error("store locked")
      },
      output: cap.out,
    })
    expect(code).toBe(0)
    expect(cap.text()).toContain("warn")
    expect(cap.text()).toContain("store locked")
  })

  it("end-to-end: clears a real store entry and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-logout-"))
    try {
      const store = new AuthStore({ path: join(dir, "auth.jsonc") })
      // A neutral provider plugin owns the slot (decision 39: core has no
      // provider OAuth client). Logout clears it through the plugin contract.
      clearProviderPlugins()
      registerProviderPlugin({
        id: "example",
        displayName: "Example",
        shortCode: "ex",
        register: () => {},
        oauthLogin: {
          serviceId: "example-oauth",
          displayName: "Example (OAuth)",
          config: () => ({
            clientId: "c",
            tokenUrl: "http://127.0.0.1/token",
            authorizeUrl: "http://127.0.0.1/authorize",
            redirectUri: "http://127.0.0.1/callback",
            scopes: [],
          }),
          buildCredential: () => {
            throw new Error("not used")
          },
        },
      })
      store.set("example-oauth", "Example (OAuth)", { accessToken: "AT", refreshToken: "RT" })
      expect(store.has("example-oauth", "Example (OAuth)")).toBe(true)

      expect(clearProviderCredentials("example", store)).toBe(true) // first removal succeeds
      expect(clearProviderCredentials("example", store)).toBe(false) // second is a no-op
      expect(store.has("example-oauth", "Example (OAuth)")).toBe(false)
      // the file still parses (banner preserved by the store on the write)
      expect(() => readFileSync(join(dir, "auth.jsonc"), "utf-8")).not.toThrow()
    } finally {
      clearProviderPlugins()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
