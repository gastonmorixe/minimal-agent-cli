/**
 * The CLI paste hook chain (paste plugin v3, D4).
 *
 * The editor runs the chain ONE time for each paste, with the whole text (a
 * bracketed paste at its end marker, or a Ctrl+V clipboard read). Hooks run
 * by priority, higher first. The first hook that gives a non-null outcome
 * wins. A hook that throws, or that gives an outcome with a bad shape, is
 * skipped with a warning, and the chain continues with the next hook. When no
 * hook gives an outcome, the editor inserts the paste as sanitized literal
 * text (owner rule: never drop content).
 *
 * Priorities: the media hook is 90 (`media-paste.ts`). Plugin hooks are
 * clamped to 0..80 (D3), so media always runs first.
 *
 * @module paste/paste-hooks
 */

import { type Diagnostics, processDiagnostics } from "@minimal-agent/core/host-kit/media"

/** Where the paste came from. */
export type PasteSource = "bracketed" | "clipboard"

/** One paste, as the hooks see it. */
export interface PasteEvent {
  /** The whole paste, markers removed, raw (no CRLF change). */
  readonly text: string
  /** A terminal bracketed paste, or a Ctrl+V clipboard read. */
  readonly source: PasteSource
  /** The active session at paste time (the lazy getter result). */
  readonly sid: string | undefined
}

/** The result of a hook. */
export type PasteOutcome =
  /** Insert this text in place of the paste, through the sanitizing path. */
  | { kind: "insert"; text: string }
  /**
   * Run an async step (for example a clipboard image read). The editor runs
   * one at a time and drops a late result after a stop (epoch guard). The
   * promise resolves to the text to insert, or `null` for nothing.
   */
  | { kind: "defer"; run: () => Promise<string | null> }

/** One hook in the chain. */
export interface PasteHook {
  /** A stable id, used in warnings. */
  id: string
  /** Higher runs first. Plugin hooks are clamped to 0..80 (D3). */
  priority: number
  /** Return an outcome to claim the paste, or `null` to pass it on. */
  onPaste(ev: PasteEvent): PasteOutcome | null
}

/** Options for {@link PasteHookRegistry}. */
export interface PasteHookRegistryOptions {
  /**
   * The lazy session id getter. The registry reads it at paste time, so a
   * host can make the registry before the session store opens.
   */
  sid?: () => string | undefined
  /** Where warnings go. Default: the process diagnostics bus. */
  diagnostics?: Diagnostics
}

function isOutcome(o: unknown): o is PasteOutcome {
  if (typeof o !== "object" || o === null) return false
  const v = o as { kind?: unknown; text?: unknown; run?: unknown }
  return (
    (v.kind === "insert" && typeof v.text === "string") ||
    (v.kind === "defer" && typeof v.run === "function")
  )
}

/** The ordered paste hook chain of one editor. */
export class PasteHookRegistry {
  private hooks: PasteHook[] = []
  private readonly slots = new Map<string, () => void>()
  private readonly sidSource: () => string | undefined
  private readonly diagnostics: Diagnostics

  constructor(opts: PasteHookRegistryOptions = {}) {
    this.sidSource = opts.sid ?? (() => undefined)
    this.diagnostics = opts.diagnostics ?? processDiagnostics()
  }

  /** The number of registered hooks. */
  get size(): number {
    return this.hooks.length
  }

  /**
   * Add a hook. Hooks with the same priority keep their registration order.
   * Returns a function that removes the hook (safe to call more than once).
   */
  register(hook: PasteHook): () => void {
    const at = this.hooks.findIndex((h) => h.priority < hook.priority)
    if (at === -1) this.hooks.push(hook)
    else this.hooks.splice(at, 0, hook)
    let done = false
    return () => {
      if (done) return
      done = true
      this.hooks = this.hooks.filter((h) => h !== hook)
    }
  }

  /**
   * Put `hook` in the named slot, and remove the hook that was there before.
   * `undefined` empties the slot. The legacy editor setters
   * (`setPasteInterceptor`, `setAsyncClipboardImageHandler`) use this.
   */
  setSlot(slot: string, hook: PasteHook | undefined): void {
    this.slots.get(slot)?.()
    this.slots.delete(slot)
    if (hook) this.slots.set(slot, this.register(hook))
  }

  /**
   * Run the chain. Returns the first non-null outcome, or `null` when no hook
   * claims the paste. A throw or a bad outcome skips to the next hook.
   */
  run(ev: PasteEvent): PasteOutcome | null {
    for (const hook of [...this.hooks]) {
      let out: unknown
      try {
        out = hook.onPaste(ev)
      } catch (e) {
        this.warn("paste.hook_failed", `Paste hook ${hook.id} failed: ${String(e)}`, {
          hook: hook.id,
        })
        continue
      }
      if (out == null) continue
      if (isOutcome(out)) return out
      this.warn("paste.hook_failed", `Paste hook ${hook.id} gave a bad result`, { hook: hook.id })
    }
    return null
  }

  /** The active session id, read now from the lazy getter. */
  sid(): string | undefined {
    try {
      return this.sidSource()
    } catch {
      return undefined
    }
  }

  /** Build the event for one paste (reads the sid now). */
  event(text: string, source: PasteSource): PasteEvent {
    return { text, source, sid: this.sid() }
  }

  /** Send one paste warning (for example the size cap) to the diagnostics. */
  warn(source: string, message: string, data?: Record<string, string | number>): void {
    this.diagnostics.warn(source, message, data)
  }
}

/**
 * Adapter for the legacy sync interceptor: a result that is not null and not
 * the input unchanged is an insert. Priority 90, the slot of the media hook.
 *
 * An interceptor that gives its input back unchanged declined the paste (the
 * old rule: `text.trim() === "" && intercepted === text` ran the async read).
 * So the adapter gives `null`, and the async adapter (89) can run.
 *
 * With both legacy adapters, Ctrl+V runs the interceptor two times: one time
 * on "" (step 1 of the Ctrl+V order) and one time on the clipboard text.
 */
export function interceptorHook(fn: (pasted: string) => string | null): PasteHook {
  return {
    id: "legacy.interceptor",
    priority: 90,
    onPaste: (ev) => {
      const text = fn(ev.text)
      return text == null || text === ev.text ? null : { kind: "insert", text }
    },
  }
}

/**
 * Adapter for the legacy async clipboard-image handler: a blank paste defers
 * to `fn`. Priority 89, so it runs only when the interceptor declined.
 */
export function asyncImageHook(fn: () => Promise<string | null>): PasteHook {
  return {
    id: "legacy.async-image",
    priority: 89,
    onPaste: (ev) => (/\S/.test(ev.text) ? null : { kind: "defer", run: fn }),
  }
}
