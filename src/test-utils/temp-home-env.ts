// Test support for a spawned `bun` child that gets its own temp HOME.
//
// A fresh HOME makes two slow first-run jobs, and both grow with machine load:
//
// 1. Bun keeps its runtime transpiler cache in `$HOME/.bun/install/cache/@t@`.
//    With a fresh HOME the cache is empty. The child transpiles the CLI and
//    core source again and writes about 350 cache files into the temp home.
// 2. The CLI copies the extended plugins into `$HOME/.minimal-agent/plugins`
//    on its first run (plugin sync). That is about 1500 files and 19 MB.
//
// On a busy machine one spawn then took about 3 s instead of 0.3 s. Removing
// the 1900 files in an `afterAll` hook took more than the 5 s hook limit.
//
// Spread `tempHomeSpawnEnv()` into the env of each such child. The child uses
// the transpiler cache of the test process and skips the plugin sync. Provider
// plugins still load from the sibling plugins repo.

import { homedir } from "node:os"
import { join } from "node:path"

/** The transpiler cache dir of the test process. */
export const SHARED_BUN_TRANSPILER_CACHE: string =
  process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ??
  join(homedir(), ".bun", "install", "cache", "@t@")

/** Env entries for a spawned `bun` child that runs with its own temp HOME. */
export function tempHomeSpawnEnv(): {
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: string
  MINIMAL_AGENT_NO_PLUGIN_SYNC: "1"
} {
  return {
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: SHARED_BUN_TRANSPILER_CACHE,
    MINIMAL_AGENT_NO_PLUGIN_SYNC: "1",
  }
}
