/**
 * Tests for the embedded table registration and the `__run` guard
 * (`startup/embedded-plugins.ts`), plus the source-run behavior of
 * `src/index.ts __run`.
 *
 * @module startup/embedded-plugins.test
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  clearEmbeddedPlugins,
  type EmbeddedPluginTable,
  hasEmbeddedPlugins,
} from "@minimal-agent/core/host-kit/embedded-plugins"
import { TABLE } from "#embedded-plugins"

import { cleanSpawnEnv } from "../e2e/clean-spawn-env.ts"

import {
  RUN_SOFTWARE_EXIT,
  RUN_USAGE_EXIT,
  registerEmbeddedTable,
  runEmbeddedScript,
  runRequest,
  tableHasPackages,
} from "./embedded-plugins.ts"

afterEach(() => clearEmbeddedPlugins())

/** Collect stderr writes. */
function sink(): { text: () => string; stderr: (t: string) => void } {
  let buf = ""
  return { text: () => buf, stderr: (t) => (buf += t) }
}

describe("#embedded-plugins from source", () => {
  test("is the empty stub, so a source run registers nothing", () => {
    expect(TABLE.packages).toEqual({})
    expect(tableHasPackages(TABLE)).toBe(false)
    expect(registerEmbeddedTable(TABLE, true)).toBe(false)
    expect(hasEmbeddedPlugins()).toBe(false)
  })
})

describe("registerEmbeddedTable", () => {
  test("registers a non-empty table", () => {
    const table: EmbeddedPluginTable = {
      buildId: "t1",
      packages: { "ma-x-plugin": { texts: { "manifest.json": "{}" }, modules: {}, files: {} } },
    }
    const home = mkdtempSync(join(tmpdir(), "ma-embedded-reg-"))
    const prev = process.env.MINIMAL_AGENT_HOME
    process.env.MINIMAL_AGENT_HOME = home
    try {
      expect(registerEmbeddedTable(table, true)).toBe(true)
      expect(hasEmbeddedPlugins()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = prev
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("runRequest", () => {
  test("argv[2] must be exactly __run; the id stays argv[3]", () => {
    expect(runRequest(["bun", "/$bunfs/root/minimal-agent", "__run", "ma-bg/runner", "a"])).toEqual(
      { id: "ma-bg/runner", args: ["a"] },
    )
    expect(runRequest(["b", "e", "__run"])).toEqual({ id: "", args: [] })
    expect(runRequest(["b", "e", "-p", "__run"])).toBeUndefined()
    expect(runRequest(["b", "e"])).toBeUndefined()
  })
})

describe("runEmbeddedScript", () => {
  const scripts: Record<string, () => Promise<unknown>> = {
    "ma-x/num": async () => ({ main: async (argv: string[]) => argv.length + 3 }),
    "ma-x/daemon": async () => ({ main: async () => undefined }),
    "ma-x/nomain": async () => ({}),
  }
  const find = (id: string) => (Object.hasOwn(scripts, id) ? scripts[id] : undefined)

  test("source run: compiled-only message, exit 64, nothing imported", async () => {
    const s = sink()
    let looked = false
    const code = await runEmbeddedScript("ma-x/num", [], false, {
      stderr: s.stderr,
      find: () => {
        looked = true
        return undefined
      },
    })
    expect(code).toBe(RUN_USAGE_EXIT)
    expect(looked).toBe(false)
    expect(s.text()).toContain("only in a compiled binary")
  })

  test.each(["../x", "/tmp/x.ts", "", "ma-x", "ma-x/unknown", "constructor"])(
    "unknown id %p exits 64 with a message",
    async (id) => {
      const s = sink()
      expect(await runEmbeddedScript(id, [], true, { stderr: s.stderr, find })).toBe(RUN_USAGE_EXIT)
      expect(s.text()).toContain("unknown embedded script")
    },
  )

  test("core's lookup rejects paths even with no table", async () => {
    const s = sink()
    expect(await runEmbeddedScript("../../etc/passwd", [], true, { stderr: s.stderr })).toBe(64)
    expect(await runEmbeddedScript("/tmp/x.ts", [], true, { stderr: s.stderr })).toBe(64)
  })

  test("a number from main is the exit code; args pass through", async () => {
    const s = sink()
    expect(await runEmbeddedScript("ma-x/num", ["a", "b"], true, { stderr: s.stderr, find })).toBe(
      5,
    )
  })

  test("undefined from main means stay alive", async () => {
    const s = sink()
    expect(
      await runEmbeddedScript("ma-x/daemon", [], true, { stderr: s.stderr, find }),
    ).toBeUndefined()
  })

  test("no main export exits 70", async () => {
    const s = sink()
    expect(await runEmbeddedScript("ma-x/nomain", [], true, { stderr: s.stderr, find })).toBe(
      RUN_SOFTWARE_EXIT,
    )
  })
})

describe("src/index.ts __run from source", () => {
  test("exits 64 with the compiled-only message, before any startup", async () => {
    const home = mkdtempSync(join(tmpdir(), "ma-run-src-"))
    try {
      const p = Bun.spawn(["bun", "run", "src/index.ts", "__run", "ma-bg/runner"], {
        cwd: join(import.meta.dir, "..", ".."),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30000,
        env: { ...cleanSpawnEnv(), MINIMAL_AGENT_HOME: home, MINIMAL_AGENT_NO_PLUGIN_SYNC: "1" },
      })
      const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
      expect(code).toBe(64)
      expect(err).toContain("only in a compiled binary")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
