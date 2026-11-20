/**
 * The open tool calls of one run: the one source of truth for the live tool
 * tree (see `./tool-tree.ts`). Terms: `GLOSSARY.md` (tool call, batch, wave,
 * concurrency cap).
 *
 * A call goes through two steps:
 * - `queue`: the model asked for it (`item_started`, `tool_use`). Core sends
 *   these events as one burst at the end of a round, before any call runs.
 * - `start`: the call got a run slot (tool view event `started`). It runs now.
 *
 * `end` removes a call in any state. The host calls `reset` when a run ends,
 * so a call that never got an event (an abort) cannot stay open.
 *
 * @module ui/status/tool-calls
 */

/** One open tool call. */
export interface LiveToolCall {
  readonly id: string
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  /** `queued`: waits for a slot. `running`: has started. */
  state: "queued" | "running"
  /** When the call started (epoch ms). `0` while it is queued. */
  startedAt: number
  /** True when core marks the call as one that runs in a wave. */
  concurrent: boolean
  /**
   * The blink phase, `0` or `1`. Set once, when the call starts, and never
   * changed. A row of phase `p` shows `●` in the seconds where
   * `floor(now / 1000) + p` is even.
   */
  phase: 0 | 1
}

/** What the tree shows now. Both lists are in call order. */
export interface ToolCallsSnapshot {
  readonly running: readonly LiveToolCall[]
  /**
   * The calls that wait for a run slot. Empty unless a wave runs and its
   * running calls fill the concurrency cap: a serial call that waits for
   * the calls before it is not "queued" for the user.
   */
  readonly queued: readonly LiveToolCall[]
}

/** The phase of the header dot. Row 1 takes the opposite. */
export const HEADER_PHASE = 0

/**
 * Hooks that make a scrollback write and a live area change one frame.
 * `begin` holds the scrollback bytes. `end` paints them with the live area.
 */
export interface FrameHooks {
  begin(): void
  end(): void
}

/** Options of {@link ToolCallTracker}. */
export interface ToolCallTrackerOptions {
  /** The clock for the start time of each call. Default: `Date.now`. */
  now?: () => number
}

/** Tracks the open tool calls of the run in progress. */
export class ToolCallTracker {
  private readonly now: () => number
  /** Insertion order is call order. */
  private readonly calls = new Map<string, LiveToolCall>()
  private readonly listeners = new Set<() => void>()
  private version = 0
  private cap: number | undefined
  private frame: FrameHooks | null = null
  private frameHeld = false

  constructor(opts: ToolCallTrackerOptions = {}) {
    this.now = opts.now ?? Date.now
  }

  /** The model asked for a call. A known id changes nothing. */
  queue(id: string, name: string, input: Readonly<Record<string, unknown>> = {}): void {
    if (this.calls.has(id)) return
    this.calls.set(id, {
      id,
      name,
      input,
      state: "queued",
      startedAt: 0,
      concurrent: false,
      phase: 0,
    })
    this.changed()
  }

  /**
   * The call runs now. The row takes the opposite blink phase of the row
   * above it: the nearest running call before it in call order, or the
   * header. An id with no earlier `queue` joins at the end.
   */
  start(
    id: string,
    name: string,
    input: Readonly<Record<string, unknown>> = {},
    concurrent = false,
  ): void {
    let call = this.calls.get(id)
    if (!call) {
      this.queue(id, name, input)
      call = this.calls.get(id)
    }
    if (!call || call.state === "running") return
    let above: LiveToolCall | undefined
    for (const other of this.calls.values()) {
      if (other === call) break
      if (other.state === "running") above = other
    }
    call.state = "running"
    call.startedAt = this.now()
    call.concurrent = concurrent
    call.phase = (above ? 1 - above.phase : 1 - HEADER_PHASE) as 0 | 1
    this.changed()
  }

  /** The call ended, was refused, or was skipped. An unknown id changes nothing. */
  end(id: string): void {
    try {
      if (this.calls.delete(id)) this.changed()
    } finally {
      this.releaseFrame()
    }
  }

  /**
   * The concurrency cap (see the glossary). A call counts as queued for the
   * user only when the running calls fill the cap. Unknown: a wave of 2 or
   * more running calls is enough.
   */
  setConcurrencyCap(cap: number | undefined): void {
    this.cap = cap !== undefined && cap >= 2 ? cap : undefined
  }

  /** The host sets the frame hooks (or `null`). */
  setFrameHooks(hooks: FrameHooks | null): void {
    this.frame = hooks
  }

  /**
   * Call before the block of an ended call goes to the scrollback. Call
   * `end` after it. The block and the removal of the row are then one frame.
   * A call with no later `end` is released by the next `end` or `reset`.
   */
  holdFrame(): void {
    if (this.frameHeld || !this.frame) return
    this.frameHeld = true
    this.frame.begin()
  }

  private releaseFrame(): void {
    if (!this.frameHeld) return
    this.frameHeld = false
    this.frame?.end()
  }

  /** Forget every call (the run ended). */
  reset(): void {
    try {
      if (this.calls.size > 0) {
        this.calls.clear()
        this.changed()
      }
    } finally {
      this.releaseFrame()
    }
  }

  /** True when at least one call runs. */
  hasRunning(): boolean {
    for (const call of this.calls.values()) if (call.state === "running") return true
    return false
  }

  /** Every open call, in call order, queued or running. */
  openCalls(): readonly LiveToolCall[] {
    return [...this.calls.values()]
  }

  snapshot(): ToolCallsSnapshot {
    const running: LiveToolCall[] = []
    const queued: LiveToolCall[] = []
    for (const call of this.calls.values()) {
      if (call.state === "running") running.push(call)
      else queued.push(call)
    }
    const wave = running.length >= 2 || running.some((call) => call.concurrent)
    const full = this.cap === undefined || running.length >= this.cap
    return { running, queued: wave && full ? queued : [] }
  }

  /** Call `listener` after each change. Returns the function that stops it. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Counts the changes. A host can compare it to skip an unchanged frame. */
  get revision(): number {
    return this.version
  }

  private changed(): void {
    this.version++
    for (const listener of [...this.listeners]) listener()
  }
}
