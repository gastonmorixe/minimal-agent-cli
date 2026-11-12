#!/usr/bin/env bun
/**
 * The `minimal-agent` bin. It runs {@link main} and sets
 * `process.exitCode` from its result. It never calls `process.exit` itself,
 * so queued stdout (stream-json lines) drains before the process ends.
 * All startup logic lives in `./main.ts`.
 *
 * Two things happen first, before `./main.ts` is even loaded:
 *
 *   1. The embedded plugin table (`#embedded-plugins`) is registered with
 *      core. From source it is the empty stub, so this is a no-op.
 *   2. A compiled binary started as `__run <plugin-id>/<script> [args]`
 *      runs that embedded script and nothing else (see
 *      `startup/embedded-plugins.ts`). A number from its `main` is the exit
 *      code. `undefined` leaves the process running (a daemon). From
 *      source `__run` exits 64 with a "compiled only" message, so it never
 *      reaches a session as a prompt.
 *
 * @module index
 */

import { isStandaloneExecutable } from "@minimal-agent/core/plugin-api/utils/self-spawn"
import { TABLE } from "#embedded-plugins"

import { registerEmbeddedTable, runEmbeddedScript, runRequest } from "./startup/embedded-plugins.ts"

if (import.meta.main) {
  const run = runRequest(process.argv)
  registerEmbeddedTable(TABLE, run === undefined)
  if (run !== undefined) {
    // From source this prints "compiled only" and exits 64.
    const code = await runEmbeddedScript(run.id, run.args, isStandaloneExecutable(), {
      stderr: (text) => process.stderr.write(text),
    })
    // The bg runner keeps a stdin watcher open, so exit explicitly.
    if (code !== undefined) process.exit(code)
  } else {
    const { main } = await import("./main.ts")
    process.exitCode = await main()
  }
}
