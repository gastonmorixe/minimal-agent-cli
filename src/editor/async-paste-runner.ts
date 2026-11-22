/**
 * The async step of a paste (paste plugin v3, D4). It was
 * `AsyncClipboardImage`.
 *
 * A paste hook can give a `defer` outcome: an async function that resolves to
 * the text to insert (for example an `[Image #id …]` token from the native
 * clipboard reader, which is async), or `null`. The hook reports a failed read
 * itself; the editor stays silent on `null`.
 *
 * Rules (J2, binding):
 * - One step runs at a time. A second `run` while one waits is ignored, so a
 *   second paste gives no second token.
 * - A result that arrives after `stop()` (or after a stop/start cycle) is
 *   dropped. The epoch goes up in `stop()` and in `dispose()`, so a late
 *   result never lands in a dead or new session buffer.
 * - A function that rejects resets the pending flag; the result is `null`.
 *
 * @module editor/async-paste-runner
 */

export interface AsyncPasteRunnerHost {
  /** True while the controller accepts input. */
  isStarted(): boolean
  /** Insert text at the cursor (through the sanitizing paste path) and repaint. */
  insertAndRepaint(text: string): void
}

/** Runs one async paste step at a time and inserts its result. */
export class AsyncPasteRunner {
  private pending = false
  private epoch = 0

  constructor(private readonly host: AsyncPasteRunnerHost) {}

  /** True while one step waits. */
  get busy(): boolean {
    return this.pending
  }

  /** Call on `stop()` and `dispose()` so a late result is dropped. */
  bumpEpoch(): void {
    this.epoch++
  }

  /** Start a step. No-op while a step is pending. */
  run(fn: () => Promise<string | null>): void {
    if (this.pending) return
    this.pending = true
    const epoch = this.epoch
    void (async () => {
      let text: string | null = null
      try {
        text = await fn()
      } catch {
        text = null
      } finally {
        this.pending = false
      }
      if (!text || !this.host.isStarted() || epoch !== this.epoch) return
      this.host.insertAndRepaint(text)
    })()
  }
}
