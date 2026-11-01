/**
 * Map turn events to the REPL's render steps (S36).
 *
 * The REPLs render a turn from its session entries. Text deltas reach them
 * through the turn generator. Every other event comes to the function this
 * module builds. It picks the events the REPL shows and calls the matching
 * handler. The REPL shows no other kind here: tool rows come through the
 * transcript writer, and status rows come through the status port.
 *
 * @module turn-event-render
 */

import type { AgentEvent } from "@minimal-agent/core/sdk/events"
import type { TurnNotice } from "@minimal-agent/core/sdk/turn-notice"

type MaybePromise<T> = T | Promise<T>

/** What a REPL does for each shown event. */
export interface TurnRenderHandlers {
  /** A reasoning block opened (`block_started`, thinking). */
  thinkingStart(): MaybePromise<void>
  /** A reasoning chunk (`thinking_delta`). */
  thinkingChunk(chunk: string): MaybePromise<void>
  /** A reasoning block closed (`block_stopped`, thinking). */
  thinkingStop(): MaybePromise<void>
  /** A text block closed (`block_stopped`, text). End its markdown paragraph. */
  textStop(): MaybePromise<void>
  /** A turn notice (`notice`). */
  notice(notice: TurnNotice): MaybePromise<void>
}

/** Build the `onEvent` function a REPL passes to `ReplAgentLike.run`. */
export function turnEventRenderer(
  handlers: TurnRenderHandlers,
): (event: AgentEvent) => MaybePromise<void> {
  return (event) => {
    switch (event.type) {
      case "thinking_delta":
        return handlers.thinkingChunk(event.text)
      case "block_started":
        return event.itemType === "thinking" ? handlers.thinkingStart() : undefined
      case "block_stopped":
        return event.itemType === "thinking" ? handlers.thinkingStop() : handlers.textStop()
      case "notice":
        return handlers.notice(event.notice)
      default:
        return undefined
    }
  }
}
