import { describe, expect, test } from "bun:test"

import {
  GenericEndpointAuthError,
  InvalidAuthorizationCodeError,
  NoOAuthLoginProviderError,
  NoProviderCredentialsError,
  NoProviderSelectedError,
  SignInTimeoutError,
  TokenExchangeError,
  UnhandledAuthTypeError,
} from "@minimal-agent/core/errors"

import {
  contextNoticeText,
  errorText,
  isNoCredentials,
  renderCoreError,
  storedProvidersHintText,
} from "./core-text.ts"

const EMPTY_HINT =
  "No provider credentials found. Run `minimal-agent provider <id> login` (e.g. `minimal-agent provider example-provider login`)."
const FACTS = [
  { providerId: "acme", labels: ["Work", "Home"], exampleModels: ["m1", "m2"] },
  { providerId: "zed", labels: ["Main"], exampleModels: [] },
]

describe("core-text", () => {
  test("hint with no providers", () => {
    expect(storedProvidersHintText([])).toBe(EMPTY_HINT)
  })

  test("hint with providers keeps the old bytes", () => {
    expect(storedProvidersHintText(FACTS)).toBe(
      'Logged in: acme (Work, Home) — e.g. "m1", "m2"; zed (Main). ' +
        'Set "model" and "provider" in ~/.minimal-agent/config.jsonc or pass --provider <id> --model <id>.',
    )
  })

  test("no provider selected", () => {
    expect(errorText(new NoProviderSelectedError("model-a", []))).toBe(
      `no provider selected for model "model-a". ${EMPTY_HINT}`,
    )
  })

  test("no provider credentials", () => {
    expect(errorText(new NoProviderCredentialsError("acme", "model-a", []))).toBe(
      `no credentials for provider "acme" (model "model-a"). Run minimal-agent provider acme login. ${EMPTY_HINT}`,
    )
  })

  test("generic endpoint flags", () => {
    expect(errorText(new GenericEndpointAuthError("bearer", "api-key"))).toBe(
      "generic-endpoint auth-type bearer requires --api-key",
    )
    expect(errorText(new GenericEndpointAuthError("custom-header", "auth-header"))).toBe(
      "generic-endpoint auth-type custom-header requires --auth-header",
    )
  })

  test("unhandled auth type", () => {
    expect(errorText(new UnhandledAuthTypeError("x"))).toBe(
      "unhandled generic-endpoint auth-type: x",
    )
  })

  test("oauth errors keep the old bytes", () => {
    expect(errorText(new SignInTimeoutError())).toBe("Sign-in timed out. Run login again.")
    expect(errorText(new InvalidAuthorizationCodeError())).toBe(
      "Authentication failed: invalid authorization code",
    )
    expect(errorText(new TokenExchangeError(503, "service unavailable"))).toBe(
      "Token exchange failed (503): service unavailable",
    )
    expect(errorText(new NoOAuthLoginProviderError())).toBe(
      "No OAuth login provider is registered.",
    )
  })

  test("a timeout error keeps the TimeoutError name check working", () => {
    expect(new SignInTimeoutError().name).toBe("SignInTimeoutError")
  })

  test("other kinds decline, plain errors keep their message", () => {
    expect(renderCoreError({ kind: "Other", fields: {} })).toBeUndefined()
    expect(errorText(new Error("boom"))).toBe("boom")
    expect(errorText("s")).toBe("s")
  })

  test("isNoCredentials checks kind and cause", () => {
    const e = new NoProviderCredentialsError("a", "m", [])
    expect(isNoCredentials(e)).toBe(true)
    expect(isNoCredentials(new Error("x", { cause: e }))).toBe(true)
    expect(isNoCredentials(new Error("x"))).toBe(false)
  })

  test("recovery notices keep the old bytes", () => {
    expect(
      contextNoticeText({
        kind: "auto_compacted",
        compactKind: "remote",
        messagesBefore: 40,
        messagesAfter: 3,
      }),
    ).toBe("Auto-compacted context (remote): 40 -> 3 messages.")
    expect(contextNoticeText({ kind: "retrying_failed_turn" })).toBe(
      "Retrying the failed user turn once.",
    )
    expect(contextNoticeText({ kind: "auto_compact_failed", cause: { message: "boom" } })).toBe(
      "Auto-compact failed: boom",
    )
  })

  test("auto-compact failed with a CoreError cause renders through errorText", () => {
    const e = new UnhandledAuthTypeError("weird")
    expect(contextNoticeText({ kind: "auto_compact_failed", cause: e.toJSON() })).toBe(
      `Auto-compact failed: ${errorText(e)}`,
    )
    expect(
      contextNoticeText({
        kind: "auto_compact_failed",
        cause: { kind: "SomeUnknownError", fields: {} },
      }),
    ).toBe("Auto-compact failed: SomeUnknownError")
  })
})
