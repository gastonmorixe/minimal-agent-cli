/**
 * The data of the `--debug` request dump header: the dim facts after the
 * model. The frame, the icon and the paint come from the shared tool
 * transcript frame (`ui/tool-transcript/format.ts`).
 *
 * @module logging/request-dump-header
 */

import type { DumpView } from "./request-dump-model.ts"
import { sizeLabel } from "./request-dump-size.ts"

/** The label of the frame header, at the place of the tool name. */
export const DUMP_FRAME_LABEL = "request"

/** Local time `HH:MM:SS` of an epoch-ms value. */
function clock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** The facts: stream, tool count, message count, time. */
export function dumpFacts(view: DumpView): string {
  const stream = view.fields.find(([k]) => k === "stream")?.[1]
  const count = (name: string): number =>
    view.sections.find((s) => s.name === name)?.parts.length ?? 0
  const facts = [
    stream === "false" ? "no stream" : "stream",
    `${count("tools")} tools`,
    `${count("messages")} msgs`,
  ]
  if (view.size !== undefined) facts.push(sizeLabel(view.size))
  if (view.ts !== undefined) facts.push(clock(view.ts))
  return facts.join(" · ")
}

/** The model text of the header. */
export function dumpModel(view: DumpView): string {
  return view.model ?? "(default model)"
}
