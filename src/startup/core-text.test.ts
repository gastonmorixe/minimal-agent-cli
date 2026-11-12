import { describe, expect, test } from "bun:test"

import {
  GenericEndpointAuthError,
  NoProviderCredentialsError,
  NoProviderSelectedError,
  UnhandledAuthTypeError,
} from "@minimal-agent/core/errors"

import {
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
})
