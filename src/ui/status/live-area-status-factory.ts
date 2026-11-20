/**
 * Build the live-area status controller of the REPL, with the live tool tree
 * when the agent has a tool call tracker. Kept out of `repl-live-area.ts` to
 * keep that file under its line budget.
 *
 * @module ui/status/live-area-status-factory
 */

import type { StatusBus } from "@minimal-agent/core/host/status-bus"
import { TOOL_PRESENTATION } from "../../plugins-ui/tool-presentation.ts"
import type { Spinner } from "../spinner/index.ts"
import type { StatusSpinnerTheme } from "./line-renderer.ts"
import { LiveAreaStatusController } from "./live-area-controller.ts"
import type { ToolCallTracker } from "./tool-calls.ts"

/** The editor methods the status controller needs. */
export interface StatusEditor {
  setStatus?(text: string | readonly string[] | null): void
  beginFrame?(): void
  endFrame?(): void
}

/**
 * The status controller. With a `tracker`, the open tool calls show as rows
 * of the status slot, and a call row goes away in the same frame as the
 * block of that call.
 */
export function createLiveAreaStatus(opts: {
  bus: StatusBus
  editor: StatusEditor
  spinner: Spinner<StatusSpinnerTheme> | undefined
  tracker: ToolCallTracker | null
}): LiveAreaStatusController {
  const { bus, editor, spinner, tracker } = opts
  if (tracker) {
    tracker.setFrameHooks({
      begin: () => editor.beginFrame?.(),
      end: () => editor.endFrame?.(),
    })
  }
  return new LiveAreaStatusController(
    bus,
    { setStatus: (text) => editor.setStatus?.(text) },
    {
      spinner,
      ...(tracker ? { toolTree: { tracker, presentation: TOOL_PRESENTATION } } : {}),
    },
  )
}
