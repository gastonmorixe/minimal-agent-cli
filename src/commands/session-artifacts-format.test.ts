import { describe, expect, test } from "bun:test"

import { formatSessionArtifacts } from "./session-artifacts-format.ts"

describe("formatSessionArtifacts", () => {
  test("prints one padded row per artifact with a trailing newline", () => {
    const text = formatSessionArtifacts({
      sid: "sid-123",
      sessionsDir: "/s",
      netDbgDir: "/n",
      artifacts: [
        { kind: "transcript", path: "/s/sid-123.jsonl", status: "present", isDirectory: false },
        { kind: "index", path: "/s/index.jsonl", status: "missing", isDirectory: false },
        {
          kind: "network",
          path: "/n/1-minimal-agent-sid-123",
          status: "unavailable",
          isDirectory: true,
        },
      ],
    })
    expect(text).toBe(
      "Session artifacts for sid-123\n" +
        "  transcript present     /s/sid-123.jsonl\n" +
        "  index      missing     /s/index.jsonl\n" +
        "  network    unavailable /n/1-minimal-agent-sid-123\n",
    )
  })

  test("prints only the header for an empty manifest", () => {
    expect(
      formatSessionArtifacts({ sid: "x", sessionsDir: "/s", netDbgDir: "/n", artifacts: [] }),
    ).toBe("Session artifacts for x\n")
  })
})
