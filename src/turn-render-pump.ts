/**
 * Ordered render pump for one interactive turn (S36).
 *
 * The CLI renders a turn from its session entries. Text deltas go to the
 * consumer of the turn generator (the REPL's markdown pipeline). Every other
 * render step (thinking chunks, block edges, notices, tool transcript rows)
 * runs as a step. The pump keeps all of them in the order the session log
 * emitted them:
 *
 * - A step runs at once, inside the producer's call, when nothing waits
 *   before it. So a step has the same timing as the old core callback.
 * - A step waits when an earlier text chunk is still with the consumer, or
 *   an earlier step still runs (it returned a promise). The drain loop then
 *   runs it in order, between the text chunks.
 * - When the turn signal aborts, the pump runs the steps that wait, in
 *   order, and does not wait for them. It drops the text that waits. So a
 *   queue echo whose text core already took, and a formatter end, still
 *   show. The pump stops waiting for a step that runs. A stuck step cannot
 *   block the turn.
 * - Each step gets `live`. After the abort, `live()` is false for a step
 *   that started before or during the abort. Such a step checks `live()`
 *   after each await and skips its later writes.
 *
 * @module turn-render-pump
 */

type MaybePromise<T> = T | Promise<T>

/**
 * True while the writes of a step are current. False after the turn
 * aborts, for a step that started before or during the abort.
 */
export type StepLive = () => boolean

/** One render step: write a row, feed a formatter, end a block. */
export type RenderStep = (live: StepLive) => MaybePromise<void>

/** The `live` of a step that started after the abort. */
const ALWAYS_LIVE: StepLive = () => true

type Item = { kind: "text"; text: string } | { kind: "step"; run: RenderStep }

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  )
}

/** Orders text chunks and render steps for one turn. Use once. */
export class TurnRenderPump {
  private readonly items: Item[] = []
  /** True while a text chunk is with the consumer, or a step runs. */
  private busy = false
  /** The promise of a step that {@link step} started at once. */
  private running: Promise<void> | null = null
  private wake: (() => void) | null = null
  private closed = false
  private abandoned = false
  /** True after the turn signal aborts. */
  private signalAborted = false
  /** The `live` of a step that started before the abort. */
  private readonly liveBeforeAbort: StepLive = () => !this.signalAborted
  private failed = false
  private failure: unknown
  private readonly idleWaiters: Array<() => void> = []
  /** Resolves when the signal aborts. Never resolves with no signal. */
  private readonly aborted: Promise<void>

  /** `signal` is the turn signal. On abort, the pump calls {@link abandon}. */
  constructor(signal?: AbortSignal) {
    this.aborted = new Promise<void>((resolve) => {
      if (!signal) return
      const onAbort = () => {
        this.flushOnAbort()
        resolve()
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  /** Add a text chunk for the consumer. */
  text(text: string): void {
    if (this.abandoned) return
    this.items.push({ kind: "text", text })
    this.notify()
  }

  /** Run a render step now, or after the items before it. */
  step(run: RenderStep): void {
    if (this.abandoned || (!this.busy && this.items.length === 0)) {
      this.runNow(run, this.signalAborted ? ALWAYS_LIVE : this.liveBeforeAbort)
      return
    }
    this.items.push({ kind: "step", run })
    this.notify()
  }

  /** No more items come. `error` ends {@link drain} with that error. */
  close(error?: unknown): void {
    if (error !== undefined) this.fail(error)
    this.closed = true
    this.notify()
  }

  /**
   * The consumer stopped early. Steps from now on run at once, with no
   * order, and text is dropped.
   */
  abandon(): void {
    this.abandoned = true
    this.items.length = 0
    this.notify()
  }

  /**
   * The turn signal aborted. Run the steps that wait, in order, with no wait
   * for a promise they return. Drop the text that waits. Then act as
   * {@link abandon}.
   */
  private flushOnAbort(): void {
    this.signalAborted = true
    const waiting = this.items.splice(0)
    this.abandoned = true
    for (const item of waiting) {
      if (item.kind === "step") this.runNow(item.run, this.liveBeforeAbort)
    }
    this.notify()
  }

  /**
   * Resolves when no item waits and no step runs, or after {@link abandon}.
   * A host write that is not a step (for example a host status row)
   * waits for this, so it shows after the rows before it.
   */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve)
    })
  }

  /**
   * Yield each text chunk in order, and run the queued steps between them.
   * Ends after {@link close} and the last item. Throws the first step
   * failure or the close error.
   */
  async *drain(): AsyncGenerator<string, void, undefined> {
    for (;;) {
      if (this.abandoned) break
      if (this.running) {
        await this.untilAbort(this.running)
        continue
      }
      const item = this.items.shift()
      if (item === undefined) {
        if (this.closed || this.abandoned) break
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
        continue
      }
      this.busy = true
      try {
        if (item.kind === "text") {
          yield item.text
        } else {
          try {
            await this.untilAbort(item.run(this.liveBeforeAbort))
          } catch (error) {
            this.fail(error)
          }
        }
      } finally {
        this.busy = false
        this.notifyIdle()
      }
    }
    if (this.failed) throw this.failure
  }

  /** Wait for `value`, but stop waiting when the signal aborts. */
  private async untilAbort(value: MaybePromise<void>): Promise<void> {
    if (!isThenable(value)) return
    await Promise.race([value, this.aborted])
  }

  private isIdle(): boolean {
    return this.abandoned || (!this.busy && this.running === null && this.items.length === 0)
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  private runNow(run: RenderStep, live: StepLive): void {
    let result: unknown
    try {
      result = run(live)
    } catch (error) {
      this.fail(error)
      return
    }
    if (!isThenable(result)) return
    this.busy = true
    const running = Promise.resolve(result).then(
      () => {},
      (error: unknown) => this.fail(error),
    )
    this.running = running
    void running.then(() => {
      if (this.running === running) this.running = null
      this.busy = false
      this.notify()
      this.notifyIdle()
    })
  }

  private fail(error: unknown): void {
    if (this.failed) return
    this.failed = true
    this.failure = error
  }

  private notify(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
    this.notifyIdle()
  }
}
