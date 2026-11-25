/**
 * A device-code login that shows the user no code must print no code line.
 *
 * Google Antigravity (the `antigravity` provider) runs a loopback login inside
 * the device-code hook. The browser gets the code through the redirect, so the
 * provider returns an empty `userCode` on purpose. The old text printed
 * "Enter this one-time code:" with nothing under it, and told the user to share
 * a code that does not exist.
 *
 * A real device-code provider (grok, clinepass, openai) keeps the full text:
 * the code is what the user types into the browser.
 */
import { describe, expect, test } from "bun:test"

import { loginEventText } from "./core-text.ts"

const URL = "https://accounts.example.test/authorize?state=s1"

describe("device-code login text with no user code", () => {
  test("a loopback login prints the URL and no code line", () => {
    const text = loginEventText({ kind: "device-code", verificationUrl: URL, userCode: "" })
    expect(text).toContain(URL)
    expect(text).not.toContain("one-time code")
    expect(text).not.toContain("Never share this code")
  })

  test("a device-code login with a code keeps the full text", () => {
    const text = loginEventText({
      kind: "device-code",
      verificationUrl: URL,
      userCode: "ABCD-1234",
    })
    expect(text).toContain("Enter this one-time code:")
    expect(text).toContain("ABCD-1234")
    expect(text).toContain("Never share this code with anyone.")
  })

  test("a loopback login is not an empty line", () => {
    const text = loginEventText({ kind: "device-code", verificationUrl: URL, userCode: "" })
    expect(text.trim().length).toBeGreaterThan(0)
  })
})
