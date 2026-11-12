/**
 * Host text of a `retry-boundary` event (S14.4).
 *
 * Core emits the boundary as data. The CLI renders the same visible text that
 * core used to put on the text channel, so every host output stays byte-equal.
 *
 * @module logging/retry-boundary-text
 */

import type { RetryBoundaryEvent } from "@minimal-agent/core/sdk/events"

/** The marker text of the attempt that starts next. */
export function retryBoundaryText(event: Pick<RetryBoundaryEvent, "attempt">): string {
  return `\n↳ stream stalled — retrying (attempt ${event.attempt})…\n`
}
