#!/usr/bin/env bun
/**
 * The `minimal-agent` bin. It runs {@link main} and sets
 * `process.exitCode` from its result. It never calls `process.exit` itself,
 * so queued stdout (stream-json lines) drains before the process ends.
 * All startup logic lives in `./main.ts`.
 *
 * @module index
 */

import { main } from "./main.ts"

if (import.meta.main) process.exitCode = await main()
