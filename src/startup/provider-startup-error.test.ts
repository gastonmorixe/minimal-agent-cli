import { expect, test } from "bun:test"
import {
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

test("shows a close model match for the selected provider", () => {
  const err = unknownTargetError("model-smal", ["model-small", "model-large"], "first", "[1m]")
  expect(formatProviderStartupError(err)).toContain('Did you mean "model-small[1m]"?')
})
