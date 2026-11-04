/**
 * Tests of the suggestion helper (SPEC-HELP R-17, plan M-9a).
 *
 * @module cli/registry/suggest.test
 */

import { describe, expect, test } from "bun:test"

import type { CommandSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

import { builtinRegistry } from "./index.ts"
import { editDistance, SUGGEST_LIMIT, suggest, suggestChildren } from "./suggest.ts"

describe("editDistance", () => {
  // Reference values: https://en.wikipedia.org/wiki/Levenshtein_distance
  // ("kitten" to "sitting" is 3).
  const cases: readonly (readonly [string, string, number])[] = [
    ["", "", 0],
    ["", "abc", 3],
    ["abc", "", 3],
    ["same", "same", 0],
    ["kitten", "sitting", 3],
    ["flaw", "lawn", 2],
    ["plan", "plna", 2],
    ["prun", "prune", 1],
    ["sesions", "sessions", 1],
  ]
  for (const [a, b, d] of cases) {
    test(`${JSON.stringify(a)} ${JSON.stringify(b)} = ${d}`, () => {
      expect(editDistance(a, b)).toBe(d)
      expect(editDistance(b, a)).toBe(d)
    })
  }
})

describe("suggest", () => {
  test("keeps distance <= 2 only", () => {
    expect(suggest("plan", ["plan", "plans", "planet", "zzzz"])).toEqual([
      "plan",
      "plans",
      "planet",
    ])
    expect(suggest("abc", ["abcdef"])).toEqual([])
  })

  test("caps at 3", () => {
    expect(SUGGEST_LIMIT).toBe(3)
    expect(suggest("ab", ["ab", "abc", "abd", "abe", "abf"])).toHaveLength(3)
  })

  test("sorts by distance, then by name, independent of input order", () => {
    const names = ["abf", "abe", "abd", "ab", "abc"]
    expect(suggest("ab", names)).toEqual(["ab", "abc", "abd"])
    expect(suggest("ab", [...names].reverse())).toEqual(["ab", "abc", "abd"])
    expect(suggest("prun", ["plan", "prune", "refresh"])).toEqual(["prune", "plan"])
  })

  test("ignores case of the token, removes duplicates", () => {
    expect(suggest("Sessions", ["sessions", "sessions"])).toEqual(["sessions"])
  })

  test("options override distance and limit", () => {
    expect(suggest("ab", ["ab", "abc", "abcd"], { maxDistance: 1 })).toEqual(["ab", "abc"])
    expect(suggest("ab", ["ab", "abc"], { limit: 1 })).toEqual(["ab"])
    expect(suggest("ab", ["ab"], { limit: 0 })).toEqual([])
  })
})

describe("suggestChildren", () => {
  test("hidden children are excluded, aliases are candidates", () => {
    const node: CommandSpec = {
      name: "top",
      summary: "T",
      commands: [
        { name: "alpha", summary: "A" },
        { name: "alphb", summary: "B", hidden: true },
        { name: "gamma", summary: "G", aliases: ["alphc"] },
      ],
    }
    expect(suggestChildren(node, "alphx")).toEqual(["alpha", "alphc"])
  })

  test("no children gives no suggestions", () => {
    expect(suggestChildren({ name: "leaf", summary: "L" }, "x")).toEqual([])
  })

  test("root of the built-in registry never suggests hidden `models`", () => {
    const root = builtinRegistry().root
    expect(suggestChildren(root, "model")).not.toContain("models")
    expect(suggestChildren(root, "sesions")).toEqual(["sessions"])
  })
})
