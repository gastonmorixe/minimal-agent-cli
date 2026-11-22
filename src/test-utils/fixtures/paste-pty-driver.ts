/**
 * Driver for `paste-pty.e2e.test.ts`.
 *
 * Runs a REAL EditorController + Compositor inside a real terminal (spawned
 * by Bun.Terminal or tmux) and replays a large bracketed paste as multiple
 * stdin chunks. The parent test controls env (notably COLUMNS) so the
 * single-source-of-truth cols contract can be validated against real PTY
 * semantics instead of FakeTerminal emulation.
 *
 * Exit protocol: prints a final line "PASTE-PTY-DONE" followed by a space
 * and the base64 of every byte the compositor wrote, so the parent can
 * replay the byte stream through a FakeTerminal-style DECAWM model and
 * assert on scrollback ghosts.
 *
 * `PASTE_PTY_MODE=image` (matrix row I4): register the media paste hook with
 * a FAKE async image reader (the user clipboard is never read or changed),
 * send a Ghostty-style blank bracketed paste and a Ctrl+V with no clipboard
 * text, then print "PASTE-PTY-BUFFER" and the base64 of the buffer.
 */
import { EventEmitter } from "node:events"
import { createMediaRegistry } from "@minimal-agent/core/host-kit/media"

import { EditorController } from "../../editor-controller.ts"
import { createMediaPasteHook } from "../../paste/media-paste.ts"
import { Compositor } from "../../ui/compositor.ts"

let raw = ""
const compositor = new Compositor({
  output: {
    isTTY: process.stdout.isTTY,
    get columns() {
      return process.stdout.columns
    },
    get rows() {
      return process.stdout.rows
    },
    write: (s: string) => {
      raw += s
      return true
    },
  } as any,
})

class FakeStdin extends EventEmitter {
  isTTY = true
  encoding: BufferEncoding | null = null

  setEncoding(enc: BufferEncoding): this {
    this.encoding = enc
    return this
  }

  resume(): this {
    return this
  }

  pause(): this {
    return this
  }

  setRawMode(_v: boolean): this {
    return this
  }

  send(chunk: string): void {
    this.emit("data", chunk)
  }
}

const stdin = new FakeStdin()
const editor = new EditorController({
  prompt: "ASK ❯ ",
  continuationPrompt: "  ",
  // Bounded like the real app (live-repl.ts uses rows/2). Without a cap the
  // live area grows past the PTY viewport and every paint legitimately
  // scrolls, committing predecessor frames into scrollback — a driver
  // artifact that masks the actual bug signal.
  maxLiveHeight: 12,
  compositor,
  stdin: stdin as any,
})
compositor.mount()
editor.start()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

void (async () => {
  // Keep the event loop alive even though our stdin is a fake emitter with
  // no OS backing (otherwise Bun exits after the synchronous setup).
  const keepAlive = setInterval(() => {}, 1_000)
  try {
    await run()
  } finally {
    clearInterval(keepAlive)
  }
})()

/** A 2x2 PNG header: enough for the media registry to type and size it. */
function fakePng(): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = 2
  b[23] = 2
  return b
}

async function runImage(): Promise<void> {
  const registry = createMediaRegistry()
  editor.pasteHooks.register(
    createMediaPasteHook({
      registry: () => registry,
      // No sync (Linux) clipboard read: only the injected async reader.
      intercept: () => null,
      readImage: async () => ({ bytes: fakePng() }),
    }),
  )
  editor.setClipboardPasteHandler(() => null)
  await sleep(150)
  stdin.send("\x1b[200~\x1b[201~")
  await sleep(100)
  stdin.send(" \x16")
  await sleep(100)
  const buffer = editor.buffer().toString()
  editor.stop()
  compositor.unmount()
  process.stdout.write(`\nPASTE-PTY-BUFFER ${Buffer.from(buffer).toString("base64")}\n`)
  process.exit(0)
}

async function run(): Promise<void> {
  if (process.env.PASTE_PTY_MODE === "image") return runImage()
  // 80 lines x ~70 visible chars: at any plausible width most lines wrap,
  // which is what makes the erase walk-up sensitive to cols disagreement.
  const payload = Array.from({ length: 80 }, (_, i) => `${"x".repeat(70)} ${i}`).join("\r")

  // Split into 12 chunks WITHOUT the closing terminator. Each chunk goes to
  // the whole-paste assembler (paste plugin v3, D1): the buffer stays empty
  // and only the "pasting N kB" status row changes, through the trailing
  // paste-paint coalesce. The terminator paints the whole paste at once.
  // (Each chunk repeats the start marker; the assembler keeps it as text,
  // the same as before the assembly, when each chunk inserted it literally.)
  const chunks: string[] = []
  const per = Math.ceil(payload.length / 12)
  for (let i = 0; i < payload.length; i += per) chunks.push(payload.slice(i, i + per))
  await sleep(150)
  for (const c of chunks) {
    stdin.send(`\x1b[200~${c}`)
    await sleep(10)
  }
  stdin.send("\x1b[201~")
  await sleep(200)

  editor.stop()
  compositor.unmount()
  // Emit the captured byte stream verbatim; the parent decodes and models it.
  process.stdout.write(`\nPASTE-PTY-DONE ${Buffer.from(raw).toString("base64")}\n`)
  process.exit(0)
}
