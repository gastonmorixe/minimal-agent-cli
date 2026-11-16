import { describe, expect, it } from "bun:test"

import { turnNoticePlainText } from "./turn-notice-text.ts"

describe("turnNoticePlainText stop_hook_capped", () => {
  it("names the hook and the cap", () => {
    expect(turnNoticePlainText({ kind: "stop_hook_capped", severity: "warn", cap: 8 })).toBe(
      "[stop hook] A turn.willStop hook blocked the stop more than 8 times in a row; ended the turn.",
    )
  })
})
