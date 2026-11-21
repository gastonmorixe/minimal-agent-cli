/**
 * The headless `--debug` request dump: plain-text rows as Debug diagnostics.
 *
 * {@link attachRequestDumpLog} subscribes to core's typed `llm.requestWillSend`
 * channel and re-emits each row of the dump as one Debug diagnostic under
 * `transport.request-dump`, on the request's OWN diagnostics handle
 * (`event.diagnostics`). Under a runtime that handle is the session scope, so
 * the rows keep the routing that core's old dump had: the `sessionId` stamp,
 * the session event log (`ch:"diag"`), the `--diagnostics` output, and the
 * process sinks (file log, stderr mirror).
 *
 * The host attaches it only with `--debug` (see `startup/diagnostic-sinks.ts`).
 * With no subscriber, core builds no event: zero cost.
 *
 * @module logging/request-dump-log
 */

import type {
  RequestInspector,
  RequestWillSendEvent,
} from "@minimal-agent/core/host/request-inspector"

import { dumpView } from "./request-dump-model.ts"
import { type RequestDumpRowData, requestDumpTextRows } from "./request-dump-text.ts"

/** Diagnostics source of every dump row. */
export const REQUEST_DUMP_SOURCE = "transport.request-dump"

/** Inputs of {@link attachRequestDumpLog}. */
export interface RequestDumpLogOptions {
  /** The channel to subscribe to. Production: `processRequestInspector()`. */
  readonly inspector: RequestInspector
  /** Read at each event: verbose rows (no preview cap, typed row data). */
  readonly verbose: () => boolean
}

/**
 * Emit the rows of one request on its diagnostics handle.
 *
 * Each row carries `row` (its index) and the final row carries `last: true`,
 * so a reader can rebuild the whole request.
 *
 * @param event - The `llm.requestWillSend` event.
 * @param verbose - Verbose rows.
 */
export function emitRequestDump(event: RequestWillSendEvent, verbose: boolean): void {
  const rows = requestDumpTextRows(
    dumpView(event.request, { lines: verbose, ts: event.ts }),
    verbose,
  )
  const last = rows.length - 1
  for (let i = 0; i < rows.length; i++) {
    const data = {
      row: i,
      ...rows[i].data,
      ...(i === last ? { last: true as const } : {}),
    } satisfies RequestDumpRowData
    event.diagnostics.debug(REQUEST_DUMP_SOURCE, rows[i].text, data)
  }
}

/**
 * Subscribe the plain-text dump to the request channel.
 *
 * @param opts - The channel and the verbose switch.
 * @returns An idempotent unsubscribe.
 */
export function attachRequestDumpLog(opts: RequestDumpLogOptions): () => void {
  return opts.inspector.subscribe((event) => emitRequestDump(event, opts.verbose()))
}
