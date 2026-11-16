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

  test("drops every MINIMAL_AGENT_* key of the base, so no harness key leaks", () => {
    const real = "/real/.minimal-agent"
    const iso = isolatedCliEnv({
      base: {
        HOME: "/real",
        MINIMAL_AGENT_HOME: "/real",
        MINIMAL_AGENT_SUBAGENT_RESULT_PATH: `${real}/sessions/x.result.json`,
        MINIMAL_AGENT_BIN_DIR: `${real}/bin`,
        MINIMAL_AGENT_MODEL: "some-model",
        PATH: "/usr/bin",
      },
    })
    try {
      expect(iso.env.MINIMAL_AGENT_SUBAGENT_RESULT_PATH).toBeUndefined()
      expect(iso.env.MINIMAL_AGENT_BIN_DIR).toBeUndefined()
      expect(iso.env.MINIMAL_AGENT_MODEL).toBeUndefined()
      expect(iso.env.PATH).toBe("/usr/bin")
      expect(iso.env.HOME).toBe(iso.home)
      expect(iso.env.MINIMAL_AGENT_HOME).toBe(iso.agentHome)
      expect(iso.env.MINIMAL_AGENT_HOME?.startsWith(iso.home + sep)).toBe(true)
      for (const value of Object.values(iso.env)) {
        expect(value?.startsWith("/real") ?? false).toBe(false)
      }
      // The only MINIMAL_AGENT_* keys left are the ones the helper sets.
      const own = new Set([
        ...Object.keys(tempHomeSpawnEnv()),
        "MINIMAL_AGENT_NO_BINARY_SETUP",
        "MINIMAL_AGENT_HOME",
      ])
      const left = Object.keys(iso.env).filter((k) => k.startsWith("MINIMAL_AGENT_"))
      expect(left.filter((k) => !own.has(k))).toEqual([])
    } finally {
      iso.cleanup()
    }
  })

  test("the default base (process.env) also loses its MINIMAL_AGENT_* keys", () => {
    const key = "MINIMAL_AGENT_ISOLATION_PROBE_KEY"
    process.env[key] = "/real/.minimal-agent"
    try {
      const iso = isolatedCliEnv()
      try {
        expect(iso.env[key]).toBeUndefined()
        expect(iso.env.HOME).toBe(iso.home)
      } finally {
        iso.cleanup()
      }
    } finally {
      delete process.env[key]
    }
  })

  test("a caller key set after the spread still wins", () => {
    const iso = isolatedCliEnv({ base: PARENT })
    try {
      const env: Record<string, string | undefined> = {
        ...iso.env,
        MINIMAL_AGENT_PROVIDER: "opencode-go",
      }
      expect(env.MINIMAL_AGENT_PROVIDER).toBe("opencode-go")
      expect(env.HOME).toBe(iso.home)
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
