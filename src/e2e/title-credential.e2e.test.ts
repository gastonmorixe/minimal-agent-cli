/**
 * The title side call uses the credential of the session (REPL, real CLI).
 *
 * The test spawns the REAL CLI (`src/index.ts`) in a real PTY, so the live
 * area REPL runs and emits `prompt.submitted` (the only path where the
 * title plugin runs). The temp auth file has 2 fake API keys of the fixture
 * provider (`fixtures/ma-llm-title-cred-fixture-plugin`). The store default
 * is `<slug>-1`. The session pins `<slug>-2` with `--credential-name`. The
 * fixture accepts only the pinned key, as the real API refuses a credential
 * of an other account.
 *
 * Assert: (a) the title request reaches the provider with the pinned key,
 * and (b) a `kind:"title"` line is in `index-meta.jsonl` of the temp
 * sessions dir. Before the fix the title call sent the store default.
 *
 * Plugins: the fixture provider, the text stub, the real ma-title-plugin and
 * ma-sideband-plugin of the sibling checkout (skip when absent).
 *
 * @module e2e/title-credential.e2e.test
 */

import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs"
import { join } from "node:path"

import { AuthStore } from "@minimal-agent/core/host/auth-store"

import { isolatedCliEnv } from "../test-utils/isolated-cli-env.ts"
import { SIBLING_REPO_ROOT, siblingPluginPresent } from "../test-utils/sibling-repo.ts"
import { cleanSpawnEnv } from "./clean-spawn-env.ts"

const HAVE_PLUGINS =
  siblingPluginPresent("ma-title-plugin") && siblingPluginPresent("ma-sideband-plugin")
const HAVE_PTY = process.platform !== "win32"

const PROVIDER = "title-cred-fixture"
const MODEL = "title-cred-fixture-model"
const NAME_DEFAULT = `${PROVIDER}-1`
const NAME_PINNED = `${PROVIDER}-2`
const KEY_DEFAULT = "test-token-default"
const KEY_PINNED = "test-token-pinned"
const PROMPT = "fix the login page bug please"

const CLI_ROOT = join(import.meta.dir, "..", "..")
const ISO = isolatedCliEnv({ base: cleanSpawnEnv(), prefix: "ma-title-cred-home-" })
const PLUGINS = join(ISO.home, "plugins")
const LOG = join(ISO.home, "requests.jsonl")
const INDEX_META = join(ISO.agentHome, "sessions", "index-meta.jsonl")

afterAll(() => ISO.cleanup())

/** Link the plugins of the run into one checkout dir. */
function linkPlugins(): void {
  mkdirSync(PLUGINS, { recursive: true })
  for (const [name, dir] of [
    [
      "ma-llm-title-cred-fixture-plugin",
      join(import.meta.dir, "fixtures", "ma-llm-title-cred-fixture-plugin"),
    ],
    [
      "ma-text-stub-fixture-plugin",
      join(CLI_ROOT, "src", "startup", "fixtures", "plugins", "ma-text-stub-fixture-plugin"),
    ],
    ["ma-title-plugin", join(SIBLING_REPO_ROOT, "ma-title-plugin")],
    ["ma-sideband-plugin", join(SIBLING_REPO_ROOT, "ma-sideband-plugin")],
  ] as const) {
    if (existsSync(dir)) symlinkSync(dir, join(PLUGINS, name))
  }
}

/** Seed the temp auth file with 2 fake keys. The first one is the store default. */
function seedAuth(): void {
  const store = new AuthStore({ path: join(ISO.agentHome, "auth.jsonc") })
  store.set(PROVIDER, NAME_DEFAULT, { tokenType: "api-key", apiKey: KEY_DEFAULT })
  store.set(PROVIDER, NAME_PINNED, { tokenType: "api-key", apiKey: KEY_PINNED })
}

interface Seen {
  round: string
  key: string
}

function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll `done` every 100 ms until it is true or `ms` passed. */
async function waitFor(done: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (done()) return true
    await sleep(100)
  }
  return done()
}

describe.skipIf(!HAVE_PLUGINS || !HAVE_PTY)("title side call: session credential (REPL)", () => {
  it("sends the pinned credential and writes the title line", async () => {
    linkPlugins()
    seedAuth()
    let screen = ""
    const p = Bun.spawn(
      [
        "bun",
        "src/index.ts",
        "--skip-quota",
        "--formatter",
        "cat",
        "--credential-name",
        NAME_PINNED,
      ],
      {
        cwd: CLI_ROOT,
        timeout: 60_000,
        terminal: {
          cols: 100,
          rows: 30,
          data(_t: unknown, d: Uint8Array) {
            screen += new TextDecoder().decode(d)
          },
        },
        env: {
          ...ISO.env,
          TERM: "xterm-256color",
          NODE_ENV: "test",
          MINIMAL_AGENT_PROVIDER: PROVIDER,
          MINIMAL_AGENT_MODEL: MODEL,
          MINIMAL_AGENT_PLUGIN_SIBLINGS: PLUGINS,
          MINIMAL_AGENT_TITLE: "1",
          MINIMAL_AGENT_NO_UPDATE_CHECK: "1",
          TITLE_CRED_LOG: LOG,
          TITLE_CRED_ACCEPT_KEY: KEY_PINNED,
        },
      },
    )
    try {
      // The REPL is ready when the prompt arrow is on the screen.
      const ready = await waitFor(() => screen.includes("❯"), 30_000)
      expect(ready).toBe(true)
      p.terminal?.write(`${PROMPT}\r`)

      const titleSeen = () => readLines<Seen>(LOG).some((s) => s.round === "title")
      const titleLine = () =>
        readLines<{ kind?: string }>(INDEX_META).some((r) => r.kind === "title")
      await waitFor(titleSeen, 30_000)
      // Give the title plugin time to write after the call.
      await waitFor(titleLine, 5_000)

      const seen = readLines<Seen>(LOG)
      // The main turn uses the pinned credential (control).
      expect(seen.filter((s) => s.round === "main").map((s) => s.key)).toContain(KEY_PINNED)
      // (a) The title call uses the pinned credential, never the store default.
      const titleKeys = seen.filter((s) => s.round === "title").map((s) => s.key)
      expect(titleKeys.length).toBeGreaterThan(0)
      expect(titleKeys).toEqual(titleKeys.map(() => KEY_PINNED))
      // (b) The title line is in the index sidecar.
      const titles = readLines<{ kind?: string; title?: string; source?: string }>(
        INDEX_META,
      ).filter((r) => r.kind === "title")
      expect(titles.map((t) => [t.title, t.source])).toEqual([["Fix the login page", "ai"]])
    } finally {
      p.kill()
      await p.exited
      p.terminal?.close()
    }
  }, 90_000)
})
