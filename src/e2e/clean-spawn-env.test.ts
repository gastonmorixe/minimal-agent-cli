import { describe, expect, it } from "bun:test"

import { cleanSpawnEnv } from "./clean-spawn-env.ts"

describe("cleanSpawnEnv", () => {
  it("drops every MINIMAL_AGENT_ key and keeps the other keys", () => {
    const out = cleanSpawnEnv({
      PATH: "/bin",
      HOME: "/home/x",
      MINIMAL_AGENT_DISABLE_PLUGINS: "intercom",
      MINIMAL_AGENT_FOO: "1",
    })
    expect(out).toEqual({ PATH: "/bin", HOME: "/home/x" })
    expect("MINIMAL_AGENT_DISABLE_PLUGINS" in out).toBe(false)
    expect("MINIMAL_AGENT_FOO" in out).toBe(false)
  })
})
