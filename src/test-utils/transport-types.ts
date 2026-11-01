/**
 * Test-only transport types for fake transports in CLI tests.
 *
 * Core does not export the legacy transport types by name (spec 2.7,
 * decision 21). `LEGACY_CORE_TRANSPORT_CONTRACTS` in
 * `src/architecture/core-public-contract.ts` lists them. These aliases
 * derive the same shapes from core's public `SessionOptions["sendFn"]`.
 * A change to the real signature then fails typecheck here. Production code must not import this file.
 *
 * @module test-utils/transport-types
 */

import type { SessionOptions } from "@minimal-agent/core"

/** The transport function shape that `SessionOptions.sendFn` takes. */
export type TestTransport = NonNullable<SessionOptions["sendFn"]>

/** The options one send gets. */
export type TestSendParams = Parameters<TestTransport>[0]

/** What one send returns when streaming ends. */
export type TestSendResult =
  ReturnType<TestTransport> extends AsyncGenerator<string, infer R, undefined> ? R : never
