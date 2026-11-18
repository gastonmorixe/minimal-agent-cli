// Test support for a spawned `bun` child that gets its own temp HOME.
//
// A fresh HOME makes three slow first-run jobs. The first two grow with machine
// load, and the third needs the network:
//
// 1. Bun keeps its runtime transpiler cache in `$HOME/.bun/install/cache/@t@`.
//    With a fresh HOME the cache is empty. The child transpiles the CLI and
//    core source again and writes about 350 cache files into the temp home.
// 2. The CLI copies the extended plugins into `$HOME/.minimal-agent/plugins`
//    on its first run (plugin sync). That is about 1500 files and 19 MB.
//
// 3. A run that shows the startup header (the REPL, or `--header`) installs
//    the plugin binaries into `<agent home>/bin` (main.ts, "binary setup").
//    In a fresh home every binary is "missing", so the child downloads them
//    again. Measured in `plugin-ui-routes.test.ts`: 6.6 s of a 7 s REPL run
//    was the download of one binary, and under load the child hit its 30 s
//    limit. A test must not depend on a download.
//
// On a busy machine one spawn then took about 3 s instead of 0.3 s. Removing
// the 1900 files in an `afterAll` hook took more than the 5 s hook limit.
//
// Spread `tempHomeSpawnEnv()` into the env of each such child. The child uses
// the transpiler cache of the test process, skips the plugin sync, and skips
// the binary setup. Provider plugins still load from the sibling plugins repo.
// A test of the binary setup itself sets `MINIMAL_AGENT_NO_BINARY_SETUP: "0"`
// after the spread.

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
  MINIMAL_AGENT_NO_BINARY_SETUP: "1"
} {
  return {
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: SHARED_BUN_TRANSPILER_CACHE,
    MINIMAL_AGENT_NO_PLUGIN_SYNC: "1",
    MINIMAL_AGENT_NO_BINARY_SETUP: "1",
  }
}
