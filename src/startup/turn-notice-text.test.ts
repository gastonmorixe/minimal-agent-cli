import { describe, expect, it } from "bun:test"

import { turnNoticePlainText } from "./turn-notice-text.ts"

describe("turnNoticePlainText stop_hook_capped", () => {
  it("names the hook and the cap", () => {
    expect(turnNoticePlainText({ kind: "stop_hook_capped", severity: "warn", cap: 8 })).toBe(
      "[stop hook] A turn.willStop hook blocked the stop more than 8 times in a row; ended the turn.",
    )
  })
})

describe("turnNoticePlainText model_adopted", () => {
  const base = {
    kind: "model_adopted",
    severity: "info",
    from: "m1",
    to: "m1",
    effortReset: false,
    effortFrom: null,
  } as const
  const A = { credentialName: "full", providerId: "alpha", model: "m1", effort: "high" }

  it("an automatic adoption (no targets) keeps the old text", () => {
    expect(turnNoticePlainText({ ...base, to: "m2" })).toBe(
      '[model] Adopted model "m2" (was "m1").',
    )
    expect(turnNoticePlainText({ ...base, to: "m2", effortReset: true, effortFrom: "high" })).toBe(
      '[model] Adopted model "m2" (was "m1") (effort reset from "high").',
    )
  })

  it("a credential-only switch names the credential, not the model two times", () => {
    const notice = { ...base, fromTarget: A, toTarget: { ...A, credentialName: "second" } }
    expect(turnNoticePlainText(notice)).toBe(
      '[target] Changed credential to "second" (was "full").',
    )
  })

  it("names each changed value in the order credential, provider, model, effort", () => {
    const toTarget = { credentialName: "second", providerId: "beta", model: "m2", effort: "low" }
    expect(turnNoticePlainText({ ...base, to: "m2", fromTarget: A, toTarget })).toBe(
      '[target] Changed credential to "second" (was "full"), provider to "beta" (was "alpha"), model to "m2" (was "m1"), effort to "low" (was "high").',
    )
  })

  it("a value that is not set has words, not the text undefined", () => {
    const toTarget = { providerId: "alpha", model: "m1" }
    expect(turnNoticePlainText({ ...base, fromTarget: A, toTarget })).toBe(
      '[target] Changed credential to the provider default (was "full"), effort to the model default (was "high").',
    )
  })

  it("only one of the two targets, or two equal targets: the old text", () => {
    expect(turnNoticePlainText({ ...base, to: "m2", fromTarget: A })).toBe(
      '[model] Adopted model "m2" (was "m1").',
    )
    expect(turnNoticePlainText({ ...base, to: "m2", fromTarget: A, toTarget: A })).toBe(
      '[model] Adopted model "m2" (was "m1").',
    )
  })
})
