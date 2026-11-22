/**
 * Async clipboard-image paste for the editor.
 *
 * Some terminals (Ghostty) send no text for an image paste, and the native
 * clipboard reader is async. A host wires an async reader here: it resolves to
 * the text to insert (an `[Image #id …]` token) or `null`. The host reports a
 * failed read itself (the editor stays silent on `null`).
 *
 * One read runs at a time. A result that arrives after `stop()` (or after a
 * stop/start cycle) is dropped, so a late image never lands in a dead or new
 * session buffer.
 *
 * @module editor/async-clipboard-image
 */

export interface AsyncClipboardImageHost {
  /** True while the controller accepts input. */
  isStarted(): boolean
  /** Insert text at the cursor and repaint. */
  insertAndRepaint(text: string): void
}

/** Runs one async clipboard-image read at a time and inserts its token. */
export class AsyncClipboardImage {
  private handler?: () => Promise<string | null>
  private pending = false
  private epoch = 0

  constructor(private readonly host: AsyncClipboardImageHost) {}

  set(fn: (() => Promise<string | null>) | undefined): void {
    this.handler = fn
  }

  /** Call on `stop()` so a late result is dropped. */
  bumpEpoch(): void {
    this.epoch++
  }

  /** Start a read. No-op when no handler is wired or a read is pending. */
  run(): void {
    const handler = this.handler
    if (!handler || this.pending) return
    this.pending = true
    const epoch = this.epoch
    void (async () => {
      let token: string | null = null
      try {
        token = await handler()
      } catch {
        token = null
      } finally {
        this.pending = false
      }
      if (!token || !this.host.isStarted() || epoch !== this.epoch) return
      this.host.insertAndRepaint(token)
    })()
  }
}
