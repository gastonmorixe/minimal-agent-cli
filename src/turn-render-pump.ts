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
 *
 * @module turn-render-pump
 */

type MaybePromise<T> = T | Promise<T>

/** One render step: write a row, feed a formatter, end a block. */
export type RenderStep = () => MaybePromise<void>

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
  private failed = false
  private failure: unknown

  /** Add a text chunk for the consumer. */
  text(text: string): void {
    if (this.abandoned) return
    this.items.push({ kind: "text", text })
    this.notify()
  }

  /** Run a render step now, or after the items before it. */
  step(run: RenderStep): void {
    if (this.abandoned || (!this.busy && this.items.length === 0)) {
      this.runNow(run)
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
   * Yield each text chunk in order, and run the queued steps between them.
   * Ends after {@link close} and the last item. Throws the first step
   * failure or the close error.
   */
  async *drain(): AsyncGenerator<string, void, undefined> {
    for (;;) {
      if (this.running) {
        await this.running
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
            await item.run()
          } catch (error) {
            this.fail(error)
          }
        }
      } finally {
        this.busy = false
      }
    }
    if (this.failed) throw this.failure
  }

  private runNow(run: RenderStep): void {
    let result: unknown
    try {
      result = run()
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
  }
}
