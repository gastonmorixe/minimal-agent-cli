import { expect, test } from "bun:test"
import {
  credentialError,
  formatProviderStartupError,
  selectionError,
  unknownTargetError,
} from "./provider-startup-error.ts"
import { resolveSingleStoredProviderBootModel } from "./resolve-boot-model.ts"

test("shows one row per saved provider without printing credential labels", () => {
  const selection = resolveSingleStoredProviderBootModel(
    [{ providerId: "first" }, { providerId: "second" }],
    () => undefined,
  )
  if (selection.kind !== "invalid") throw new Error("expected ambiguous credentials")
  const err = selectionError(selection, [
    {
      providerId: "first",
      labels: ["work@example.test"],
      exampleModels: ["first-small", "first-large"],
    },
    { providerId: "second", labels: ["personal"], exampleModels: [] },
  ])
  expect(formatProviderStartupError(err)).toBe(
    [
      "fatal: multiple usable credentials found",
      "  Choose a provider and model: --provider <id> --model <id>",
      '  To set defaults, add "provider" and "model" to your config.jsonc.',
      "",
      "  Saved credentials (example model IDs):",
      "    first: first-small, first-large",
      "    second",
      "  List credentials: minimal-agent auth-status",
    ].join("\n"),
  )
  expect(err.message).toContain("first (work@example.test)")
})

test("a named credential: the protocol message is the stderr summary, not the store hint", () => {
  // The core text says "no credentials" and lists the store, which is false
  // when the store holds other credentials. stream-json reads `message`.
  const coreText =
    'no credentials for provider "openai" (model "gpt-4.1"). Run minimal-agent provider openai login. No provider credentials found.'
  const err = credentialError(new Error("core"), coreText, "openai", "gpt-4.1", "missing", true)
  expect(err.summary).toBe('no usable credential "missing" for provider "openai"')
  expect(err.message).toBe(err.summary)
  expect(err.cause).toBeInstanceOf(Error)
  // No name, but a saved credential of the provider: "no credentials" is false.
  expect(
    credentialError(new Error("core"), coreText, "openai", "gpt-4.1", undefined, true).message,
  ).toBe('no usable credentials for provider "openai" (model "gpt-4.1")')
  // No name and no saved credential: the core text is true and stays.
  expect(
    credentialError(new Error("core"), coreText, "openai", "gpt-4.1", undefined, false),
  ).toMatchObject({ message: coreText })
})

test("shows a close model match for the selected provider", () => {
  const err = unknownTargetError("model-smal", ["model-small", "model-large"], "first", "[1m]")
  expect(formatProviderStartupError(err)).toContain('Did you mean "model-small[1m]"?')
})
