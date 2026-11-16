import { describe, expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { join, sep } from "node:path"

import { cleanSpawnEnv } from "../e2e/clean-spawn-env.ts"
import { isolatedCliEnv } from "./isolated-cli-env.ts"
import { tempHomeSpawnEnv } from "./temp-home-env.ts"

const REAL_HOME = "/real/home/of/the/user"
const REAL_AGENT_HOME = "/real/home/of/the/user/.minimal-agent"
const PARENT = {
  HOME: REAL_HOME,
  MINIMAL_AGENT_HOME: REAL_AGENT_HOME,
  MINIMAL_AGENT_DISABLE_PLUGINS: "x",
  PATH: "/usr/bin",
}

describe("isolatedCliEnv", () => {
  test("HOME and MINIMAL_AGENT_HOME point inside a fresh temp dir", () => {
    const iso = isolatedCliEnv({ base: PARENT })
    try {
      expect(statSync(iso.home).isDirectory()).toBe(true)
      expect(iso.env.HOME).toBe(iso.home)
      expect(iso.env.MINIMAL_AGENT_HOME).toBe(join(iso.home, ".minimal-agent"))
      expect(iso.agentHome).toBe(join(iso.home, ".minimal-agent"))
      expect(iso.env.MINIMAL_AGENT_HOME?.startsWith(iso.home + sep)).toBe(true)
      expect(iso.env.HOME).not.toBe(REAL_HOME)
      expect(iso.env.MINIMAL_AGENT_HOME).not.toBe(REAL_AGENT_HOME)
    } finally {
      iso.cleanup()
    }
  })

  test("never equals the real values of the test process", () => {
    const iso = isolatedCliEnv()
    try {
      if (process.env.HOME !== undefined) expect(iso.env.HOME).not.toBe(process.env.HOME)
      if (process.env.MINIMAL_AGENT_HOME !== undefined) {
        expect(iso.env.MINIMAL_AGENT_HOME).not.toBe(process.env.MINIMAL_AGENT_HOME)
      }
      expect(iso.env.MINIMAL_AGENT_HOME?.startsWith(iso.home + sep)).toBe(true)
    } finally {
      iso.cleanup()
    }
  })

  test("keeps the base env and adds the temp-home spawn keys", () => {
    const iso = isolatedCliEnv({ base: cleanSpawnEnv(PARENT) })
    try {
      expect(iso.env.PATH).toBe("/usr/bin")
      expect(iso.env.MINIMAL_AGENT_DISABLE_PLUGINS).toBeUndefined()
      expect(iso.env).toMatchObject(tempHomeSpawnEnv())
      expect(iso.env.MINIMAL_AGENT_NO_BINARY_SETUP).toBe("1")
    } finally {
      iso.cleanup()
    }
  })

  test("two calls get two dirs, and cleanup removes the dir", () => {
    const a = isolatedCliEnv()
    const b = isolatedCliEnv()
    expect(a.home).not.toBe(b.home)
    a.cleanup()
    b.cleanup()
    expect(existsSync(a.home)).toBe(false)
    expect(existsSync(b.home)).toBe(false)
    // A second cleanup does not throw.
    a.cleanup()
  })
})
