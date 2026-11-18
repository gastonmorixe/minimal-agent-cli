/**
 * The stderr of a live-area slot subprocess, on the diagnostic bus.
 *
 * A slot that inherits the CLI's fd 2 writes its stderr straight onto the
 * terminal and tears the live area (the same hazard the markdown formatter
 * avoids with a pipe, see `ui/formatter/formatter.ts`). The slot's stderr is
 * piped instead. It is drained from spawn time, so the child never blocks on
 * a full pipe, and what it wrote is reported after it exited as one Warning
 * `plugins-ui.slot-stderr` per line.
 *
 * @module plugins-ui/slot-stderr
 */

import { Severity } from "@minimal-agent/core/host/diagnostics"
import { emitDiagnostic, plainDiagnosticText } from "../logging/emit-diagnostic.ts"

/** Most lines of one slot run that reach the bus. */
export const SLOT_STDERR_MAX_LINES = 20
/** Longest reported line, in characters. */
export const SLOT_STDERR_MAX_LINE_CHARS = 2000
/** Characters of stderr text kept for one run. The rest is read and dropped. */
const KEEP_CHARS = 64 * 1024
/** How long to wait for the pipe to end after the child exited (a grandchild may hold it). */
const EOF_GRACE_MS = 250

/** A running, bounded read of a slot's stderr pipe. */
export interface SlotStderrDrain {
  /** Settles when the pipe ended or broke. Never rejects. */
  readonly done: Promise<void>
  /** The text read so far, at most 64 KiB of characters. */
  text(): string
}

/**
 * Read `stream` to its end in the background and keep a bounded part of it.
 * Call it right after the spawn: the child must never block on a full pipe.
 */
export function drainSlotStderr(stream: ReadableStream<Uint8Array>): SlotStderrDrain {
  const decoder = new TextDecoder()
  let kept = ""
  const done = (async () => {
    try {
      for await (const chunk of stream) {
        if (kept.length < KEEP_CHARS) kept += decoder.decode(chunk, { stream: true })
      }
      if (kept.length < KEEP_CHARS) kept += decoder.decode()
    } catch {
      // A broken pipe: report what was read.
    }
  })()
  return { done, text: () => kept.slice(0, KEEP_CHARS) }
}

/** Cut `text` to `max` characters without leaving half of a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const end = text.charCodeAt(max - 1)
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? max - 1 : max)
}

/**
 * The lines of a slot's stderr text that are worth reporting: plain text (no
 * escape sequences or control characters), no empty line, at most 20 lines of
 * at most 2000 characters.
 */
export function slotStderrLines(text: string): string[] {
  const lines: string[] = []
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = cut(plainDiagnosticText(raw), SLOT_STDERR_MAX_LINE_CHARS)
    if (line === "") continue
    lines.push(line)
    if (lines.length === SLOT_STDERR_MAX_LINES) break
  }
  return lines
}

/**
 * Emit what the slot wrote to stderr as Warning `plugins-ui.slot-stderr`
 * events, one per line, each with the slot id and the plugin id.
 *
 * Waits a short grace for the pipe to end, so a grandchild that keeps the pipe
 * open cannot hold the slot's result back. Never throws.
 */
export async function reportSlotStderr(
  drain: SlotStderrDrain,
  who: { readonly slot: string; readonly plugin: string },
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      drain.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, EOF_GRACE_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  for (const line of slotStderrLines(drain.text())) {
    emitDiagnostic(Severity.Warning, "plugins-ui.slot-stderr", line, {
      slot: who.slot,
      plugin: who.plugin,
    })
  }
}
