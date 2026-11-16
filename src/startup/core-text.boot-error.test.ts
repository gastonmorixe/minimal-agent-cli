/**
 * The CLI renders `ContractCheckFailedError` (R-BOOT-2) with its own host
 * renderer: the text names every missing and duplicated contract.
 */
import { describe, expect, test } from "bun:test"

import { ContractCheckFailedError } from "@minimal-agent/core/errors"
import { TEXT_CONTRACTS } from "@minimal-agent/core/host-kit/plugin-loader"

import { formatFatalError } from "../ui/turn-error.ts"
import { contractCheckFailedText, errorText } from "./core-text.ts"

describe("ContractCheckFailedError CLI text", () => {
  test("errorText names the missing contracts", () => {
    const err = new ContractCheckFailedError(["text.tools", "synthetic:mode.change"], [])
    expect(err.message).toBe("")
    const text = errorText(err)
    expect(text).toContain("missing: text.tools, synthetic:mode.change")
    expect(text).not.toContain("duplicated")
  })

  test("names duplicates too, from the JSON form", () => {
    const json = new ContractCheckFailedError([], ["prompts.template"]).toJSON()
    expect(contractCheckFailedText(json)).toContain(
      "duplicated in one plugin tier: prompts.template",
    )
  })

  test("the fatal boot line holds every TEXT_CONTRACTS id of a bare boot", () => {
    const line = formatFatalError(new ContractCheckFailedError(TEXT_CONTRACTS, []))
    expect(line.startsWith("fatal: required plugin contracts are not met")).toBe(true)
    for (const c of TEXT_CONTRACTS) expect(line).toContain(c)
  })
})
