/**
 * Paste chips in the TUI views that show a raw user text outside the
 * editor: the queue widget, the abort echo and the plugin picker rows
 * (the history-edit rewind picker). Each view must show the chip label
 * and never the raw sideband tag. The stored text (queue, buffer, sent
 * text, picker row id) keeps the raw ref.
 *
 * Uses the real codec (`test-utils/sideband-fixture.ts`) and a chip label
 * of the same form as the paste plugin label.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { StatusBus } from "@minimal-agent/core/host/status-bus"
import { Hooks } from "@minimal-agent/core/host-kit/hooks"
import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"

import { abortBus as globalAbortBus } from "../bus/abort-bus.ts"
import { formatRestoredMessages } from "../editor/queue-restore.ts"
import type { EditorKeyPayload, QueueKeyContext, QueueKeyResult } from "../editor/types.ts"
import { make } from "../editor-controller.fixtures.ts"
import { type ReplAgentLike, runRepl } from "../repl.ts"
import { registerEditorPluginHooks } from "../repl-editor-hooks.ts"
import { testSideband as sb, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"
import { buildQueueDecorationLines, QUEUE_PREVIEW_W } from "../ui/chrome/queue-decoration.ts"
import { ChipRegistry } from "./chip-registry.ts"

const noAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")
/** The open sigil of the codec wire form (the CLI holds no tag literal). */
const sigil = (): string => {
  const wire = sb.example("paste")
  return wire.slice(0, wire.indexOf("::") + 2)
}

/** A registry with a label of the paste plugin form. */
function pasteChips(): ChipRegistry {
  const chips = new ChipRegistry()
  chips.register({
    kind: "paste",
    label: (a) => `[Paste #${String(a.id)} ${String(a.bytes)}B ${String(a.lines)}L]`,
  })
  return chips
}

/**
 * The display function of a real `EditorController` with the chip spans, as
 * `live-repl.ts` builds it (`spanSource: chips.spansOf(line, sideband)`).
 */
function chipDisplay(): (text: string) => string {
  const chips = pasteChips()
  const { ctrl } = make({ spanSource: (l) => chips.spansOf(l, sb) })
  return (text) => ctrl.buffer().displayText(text)
}

const ref = (): string => sb.render("paste", { attrs: { id: "u194m", bytes: 130, lines: 129 } })
const CHIP = "[Paste #u194m 130B 129L]"

class FakeCompositor {
  readonly streams: string[] = []
  liveHeight = 1
  mount(_n: number): void {}
  unmount(): void {}
  setLiveArea(): void {}
  setLiveHeight(n: number): void {
    this.liveHeight = n
  }
  writeStream(chunk: string): void {
    this.streams.push(chunk)
  }
  flushStream(): void {}
}

class FakeEditor extends EventEmitter {
  readonly setBufferCalls: string[] = []
  decoration: string[] = []
  private qh: ((key: string, ctx: QueueKeyContext) => QueueKeyResult) | null = null
  constructor(private readonly display?: (text: string) => string) {
    super()
  }
  /** Mirror of `EditorController.buffer()` (its `displayText` gives chip labels). */
  buffer(): { displayText(text: string): string } {
    return { displayText: (text) => (this.display ? this.display(text) : text) }
  }
  start(): void {}
  stop(): void {}
  setBuffer(text: string): void {
    this.setBufferCalls.push(text)
  }
  setDecorationLines(lines: string[]): void {
    this.decoration = [...lines]
  }
  setQueueKeyHandler(h: ((key: string, ctx: QueueKeyContext) => QueueKeyResult) | null): void {
    this.qh = h
  }
  notifyTurnStart(): void {}
  notifyTurnEnd(): void {}
  type(text: string): void {
    this.emit("submit", text)
  }
  cancel(): void {
    this.emit("cancel")
  }
  queueKey(key: string): QueueKeyResult {
    if (!this.qh) throw new Error("no queueKeyHandler installed")
    const r = this.qh(key, { buffer: "", atTop: true })
    if (r.buffer !== undefined) this.setBuffer(r.buffer)
    return r
  }
}

/** A holding agent: the turn waits until aborted. Records the sent text. */
function holdingAgent() {
  const sent: string[] = []
  const agent: ReplAgentLike & { rollbackPendingTurn?: () => boolean } = {
    pluginLoader: () => null,
    rollbackPendingTurn: () => false,
    async *run(text, opts: any) {
      sent.push(text)
      yield ""
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        if (opts?.signal?.aborted) abort()
        else opts?.signal?.addEventListener("abort", abort)
      })
      return { blocks: [], text: "", stopReason: "end_turn" } as any
    },
  }
  return { agent, sent }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe.skipIf(!sidebandFixturePresent())("paste chips in the TUI views (real codec)", () => {
  afterEach(() => {
    if (globalAbortBus.isTurnInFlight())
      globalAbortBus.requestAbort({ kind: "programmatic", tag: "test-cleanup" })
  })

  it("queue widget: plain and nav rows show the chip, not the tag", () => {
    const chips = pasteChips()
    const display = (t: string) => chips.renderText(t, sb)
    const queue = [`see ${ref()} please`, `two\n${ref()}`]
    for (const selectedIndex of [null, 0, 1]) {
      const lines = buildQueueDecorationLines(queue, { selectedIndex, cols: 100, display })
      const shown = lines.map(noAnsi).join("\n")
      expect(shown).toContain(`see ${CHIP} please`)
      expect(shown).toContain(`two ${CHIP}`)
      expect(shown).not.toContain(sigil())
    }
    // Without the mapper the widget shows the raw tag (the bug).
    const raw = buildQueueDecorationLines(queue).map(noAnsi).join("\n")
    expect(raw).toContain(sigil())
  })

  it("queue widget: the width cut counts the chip label, not the raw tag", () => {
    const chips = pasteChips()
    const display = (t: string) => chips.renderText(t, sb)
    const long = `${"x".repeat(QUEUE_PREVIEW_W - 10)} ${ref()} tail`
    const row = noAnsi(buildQueueDecorationLines([long], { display })[1] ?? "")
    expect(row).not.toContain(sigil())
    // The cut ends inside the chip label text. The hint counts the rest of
    // the label plus " tail" (20 code points), not the long raw tag.
    expect(row).toContain("[Paste #u")
    expect(row).toContain("+20ch")
    expect(displayWidth(row)).toBeLessThan(QUEUE_PREVIEW_W + 20)
  })

  it("live area: queue widget and abort echo show the chip; stored text keeps the ref", async () => {
    const editor = new FakeEditor(chipDisplay())
    const compositor = new FakeCompositor()
    const { agent, sent } = holdingAgent()
    const replPromise = runRepl(agent, {
      output: { isTTY: true, write: () => true, columns: 100, rows: 24 } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: compositor as any,
      editor: editor as any,
    })
    await Promise.resolve()
    const first = `first ${ref()}`
    const queued = `queued ${ref()}`
    editor.type(first)
    await tick()
    editor.type(queued)
    await tick()
    // Queue widget.
    const deco = editor.decoration.map(noAnsi).join("\n")
    expect(deco).toContain(`queued ${CHIP}`)
    expect(deco).not.toContain(sigil())
    // The model gets the raw ref (the send hook expands it).
    expect(sent).toEqual([first])

    globalAbortBus.requestAbort({ kind: "user-key", key: "Esc" })
    await tick()
    // Abort echo in scrollback.
    const scroll = noAnsi(compositor.streams.join(""))
    expect(scroll).toContain("ABORTED")
    expect(scroll).toContain(`first ${CHIP}`)
    expect(scroll).not.toContain(sigil())
    // The restored buffer keeps the raw refs (the editor paints the chips).
    expect(editor.setBufferCalls.at(-1)).toBe(`1. ${first}\n2. ${queued}`)
    editor.cancel()
    await replPromise
  })

  it("live area: Up dequeue puts the raw ref back in the buffer", async () => {
    const editor = new FakeEditor(chipDisplay())
    const { agent } = holdingAgent()
    const replPromise = runRepl(agent, {
      output: { isTTY: true, write: () => true, columns: 100, rows: 24 } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: new FakeCompositor() as any,
      editor: editor as any,
    })
    await Promise.resolve()
    editor.type("first")
    await tick()
    const queued = `q ${ref()}`
    editor.type(queued)
    await tick()
    expect(editor.queueKey("ArrowUp").buffer).toBe(queued)
    globalAbortBus.requestAbort({ kind: "programmatic", tag: "test" })
    await tick()
    editor.cancel()
    await replPromise
  })

  it("editor: Up history recall, queue dequeue and numbered restore paint the chip", () => {
    const chips = pasteChips()
    const hooks = new Hooks()
    const recalled = `old ${ref()}`
    hooks.on<EditorKeyPayload>(
      "editor.key",
      (p) => {
        if (p.key !== "ArrowUp" || p.buffer.length > 0) return
        p.result.halt = true
        p.result.buffer = recalled
      },
      { caller: "plugin" },
    )
    const { ctrl, stdin, compositor } = make({
      hooks,
      columns: 120,
      spanSource: (l) => chips.spansOf(l, sb),
    })
    const shown = () => noAnsi(compositor.last()?.lines.join("\n") ?? "")
    ctrl.start()
    // History recall (ma-history-plugin on_key -> result.buffer -> setBuffer).
    stdin.send("\x1b[A")
    expect(ctrl.buffer().toString()).toBe(recalled)
    expect(shown()).toContain(`old ${CHIP}`)
    expect(shown()).not.toContain(sigil())
    // Queue dequeue (tryQueueNav -> setBuffer).
    ctrl.setBuffer("")
    ctrl.setQueueKeyHandler((key) =>
      key === "ArrowUp" ? { handled: true, buffer: `q ${ref()}` } : { handled: false },
    )
    stdin.send("\x1b[A")
    expect(shown()).toContain(`q ${CHIP}`)
    expect(shown()).not.toContain(sigil())
    ctrl.setQueueKeyHandler(null)
    // Abort restore and "dequeue all": numbered list (formatRestoredMessages).
    ctrl.setBuffer(formatRestoredMessages([`a ${ref()}`, `b\n${ref()}`]))
    expect(shown()).toContain(`1. a ${CHIP}`)
    expect(shown()).toContain(`   ${CHIP}`)
    expect(shown()).not.toContain(sigil())
    ctrl.stop()
  })

  it("plugin picker rows (history-edit) show the chip; the row id is unchanged", async () => {
    const listeners = new Map<string, (p: unknown) => unknown>()
    const footer: string[][] = []
    registerEditorPluginHooks(
      {
        hooks: () => ({
          on: (channel: string, fn: (p: unknown) => unknown) => listeners.set(channel, fn),
          emitChain: async <T>(_: string, payload: T) => ({ payload }),
        }),
      },
      {
        isOverlayOwner: (o) => o === "history-edit",
        setFooterLayer: (_id, lines) => footer.push(lines),
        buffer: () => ({ displayText: chipDisplay() }),
      },
    )
    listeners.get("editor.picker.set")?.({
      owner: "history-edit",
      title: "Edit earlier prompt · 1",
      rows: [{ id: "u1", label: `1 · look ${ref()}` }],
      selected: 0,
    })
    const shown = noAnsi((footer.at(-1) ?? []).join("\n"))
    expect(shown).toContain(`1 · look ${CHIP}`)
    expect(shown).not.toContain(sigil())
  })
})

describe("EditorBuffer.displayText (applyChipSpans)", () => {
  /** Each `{...}` of a line is a span with the label `[c]`. */
  const braces = (line: string) => {
    const out: { start: number; end: number; label: string }[] = []
    let open = -1
    Array.from(line).forEach((ch, i) => {
      if (ch === "{") open = i
      if (ch === "}" && open >= 0) {
        out.push({ start: open, end: i + 1, label: "[c]" })
        open = -1
      }
    })
    return out
  }

  it("replaces each span per line, code-point safe, and keeps the rest", () => {
    const { ctrl } = make({ spanSource: braces })
    expect(ctrl.buffer().displayText("😀 a {xy} b\n{z}")).toBe("😀 a [c] b\n[c]")
    expect(ctrl.buffer().displayText("plain")).toBe("plain")
  })

  it("no span source: the text is unchanged", () => {
    const { ctrl } = make()
    expect(ctrl.buffer().displayText("a {xy}")).toBe("a {xy}")
  })
})
