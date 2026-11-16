/**
 * The text stub fixture plugin must list every required synthetic kind. When
 * core adds a required kind, this test fails until the stub manifest has it,
 * so spawn tests do not fail the boot contract check with no clear reason.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { TEXT_CONTRACTS } from "@minimal-agent/core/host-kit/plugin-loader"

const MANIFEST = join(import.meta.dir, "plugins", "ma-text-stub-fixture-plugin", "manifest.json")

describe("text stub fixture plugin", () => {
  it("lists exactly the required synthetic kinds of core", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
      syntheticText: { kinds: string[] }[]
    }
    const required = TEXT_CONTRACTS.filter((c) => c.startsWith("synthetic:"))
      .map((c) => c.slice("synthetic:".length))
      .sort()
    expect([...(manifest.syntheticText[0]?.kinds ?? [])].sort()).toEqual(required)
  })
})
