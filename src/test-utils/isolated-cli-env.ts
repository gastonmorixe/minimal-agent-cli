// Env for a test that spawns the real CLI (`src/index.ts` / `src/main.ts`).
//
// The CLI writes sessions, logs and history under its agent home.
// `resolveAgentHome` takes `MINIMAL_AGENT_HOME` first, then
// `$HOME/.minimal-agent`. A spawn with `{ ...process.env }` carries the real
// values of both into the child, so the child writes into the real
// `~/.minimal-agent` of the developer. `cleanSpawnEnv()` drops
// `MINIMAL_AGENT_HOME` but keeps the real `HOME`, so it leaks the same way.
//
// `isolatedCliEnv()` makes a fresh temp HOME and points both keys inside it.
// It also spreads `tempHomeSpawnEnv()` (shared transpiler cache, no plugin
// sync), so the fresh HOME stays fast. Provider plugins still load from the
// sibling plugins repo, not from HOME.
//
// It also sets `MINIMAL_AGENT_NO_BINARY_SETUP=1`. A `--header` run provisions
// the plugin binaries into `<agent home>/bin` (main.ts:806). In a fresh home
// every binary is "missing", so the child installs them again: slow, and it
// can reach the network. Measured: e2e-smoke "one-shot prompt" (`--header`)
// timed out at 5 s with it on, and took about 1 s with it off.
//
// Spread `env` first and the test keys after it. Do not override `HOME` or
// `MINIMAL_AGENT_HOME` after it. Call `cleanup()` in `afterAll`.
// The ratchet `spawn-home-isolation.ratchet.test.ts` enforces this.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { tempHomeSpawnEnv } from "./temp-home-env.ts"

/** The env and the temp dirs of one isolated CLI home. */
export interface IsolatedCliEnv {
  /** The temp HOME of the child. */
  readonly home: string
  /** `<home>/.minimal-agent`, the agent home of the child. */
  readonly agentHome: string
  /** The child env: base, then the temp home keys. */
  readonly env: Record<string, string | undefined>
  /** Remove the temp HOME. Best effort, never throws. */
  cleanup(): void
}

/** Options for {@link isolatedCliEnv}. */
export interface IsolatedCliEnvOptions {
  /** The env to start from. Default `process.env`. Pass `cleanSpawnEnv()` to drop `MINIMAL_AGENT_*`. */
  readonly base?: Record<string, string | undefined>
  /** The mkdtemp prefix. Default `ma-cli-home-`. */
  readonly prefix?: string
}

/** Make a fresh temp HOME and the env of a CLI child that uses it. */
export function isolatedCliEnv(options: IsolatedCliEnvOptions = {}): IsolatedCliEnv {
  const home = mkdtempSync(join(tmpdir(), options.prefix ?? "ma-cli-home-"))
  const agentHome = join(home, ".minimal-agent")
  const env: Record<string, string | undefined> = {
    ...(options.base ?? process.env),
    ...tempHomeSpawnEnv(),
    MINIMAL_AGENT_NO_BINARY_SETUP: "1",
    HOME: home,
    MINIMAL_AGENT_HOME: agentHome,
  }
  return {
    home,
    agentHome,
    env,
    cleanup(): void {
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {
        // Best effort: a leftover temp dir is harmless.
      }
    },
  }
}
