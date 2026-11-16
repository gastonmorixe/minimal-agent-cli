/**
 * The hidden `--startup-profile <path>` flag (subagent inherit, CONTRACT 4):
 * it takes a value, it is a known flag, and its value is never the prompt.
 *
 * @module cli/startup-profile-flag.test
 */

import { describe, expect, test } from "bun:test"

import { extractPromptFromArgs, FLAGS_NO_VALUE, FLAGS_WITH_VALUES } from "./extract-prompt.ts"
import { builtinRegistry } from "./registry/index.ts"
import { findUnknownFlag } from "./unknown-flags.ts"

const reg = builtinRegistry()

describe("--startup-profile flag", () => {
  test("is a value flag", () => {
    expect(FLAGS_WITH_VALUES.has("--startup-profile")).toBe(true)
    expect(FLAGS_NO_VALUE.has("--startup-profile")).toBe(false)
  })

  test("is a known flag in both forms", () => {
    expect(findUnknownFlag(["--startup-profile", "/s/x.profile.json"], reg)).toBeUndefined()
    expect(findUnknownFlag(["--startup-profile=/s/x.profile.json"], reg)).toBeUndefined()
  })

  test("its value never leaks as the prompt", () => {
    expect(extractPromptFromArgs(["--startup-profile", "/s/x.profile.json"])).toEqual({
      kind: "none",
    })
    expect(
      extractPromptFromArgs(["--startup-profile", "/s/x.profile.json", "--prompt", "hi"]),
    ).toEqual({
      kind: "literal",
      text: "hi",
    })
  })
})
