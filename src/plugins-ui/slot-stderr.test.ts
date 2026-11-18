/**
 * A live-area slot subprocess no longer inherits the CLI's stderr: it is piped,
 * drained from spawn time, and reported as Warning `plugins-ui.slot-stderr`
 * events after the slot exited. The slot's stdout and exit handling stay as
 * they were.
 *
 * @module plugins-ui/slot-stderr.test
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getDiagnosticBus, type LogEvent, Severity } from "@minimal-agent/core/host/diagnostics"
import type {
  LiveAreaHandlerContext,
  ManifestLiveAreaSlot,
} from "@minimal-agent/core/plugin-api/types/plugin"

import { resolveLiveAreaSlot } from "./resolve-slot.ts"
import {
  SLOT_STDERR_MAX_LINE_CHARS,
  SLOT_STDERR_MAX_LINES,
  slotStderrLines,
} from "./slot-stderr.ts"

const SOURCE = "plugins-ui.slot-stderr"
const ESC = String.fromCodePoint(0x1b)

describe("slotStderrLines", () => {
  test("keeps plain lines in order and drops empty and whitespace-only lines", () => {
    expect(slotStderrLines("one\n\n  \ntwo\r\nthree\rfour\n")).toEqual([
      "one",
      "two",
      "three",
      "four",
    ])
  })

  test("strips escape sequences and control characters", () => {
    expect(
      slotStderrLines(`${ESC}[31mred${ESC}[0m text\n${ESC}]0;title\x07after\nbell\x07here`),
    ).toEqual(["red text", "after", "bell here"])
  })

  test(`stops at ${SLOT_STDERR_MAX_LINES} lines`, () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
    const lines = slotStderrLines(text)
    expect(lines).toHaveLength(SLOT_STDERR_MAX_LINES)
    expect(lines[0]).toBe("line 0")
    expect(lines.at(-1)).toBe(`line ${SLOT_STDERR_MAX_LINES - 1}`)
  })

  test(`cuts a line at ${SLOT_STDERR_MAX_LINE_CHARS} characters, not in the middle of an emoji`, () => {
    const [long] = slotStderrLines("a".repeat(SLOT_STDERR_MAX_LINE_CHARS + 500))
    expect(long).toHaveLength(SLOT_STDERR_MAX_LINE_CHARS)
    // An emoji (two UTF-16 units) that straddles the cut is dropped whole.
    const [emoji] = slotStderrLines(`${"a".repeat(SLOT_STDERR_MAX_LINE_CHARS - 1)}🙂 tail`)
    expect(emoji).toBe("a".repeat(SLOT_STDERR_MAX_LINE_CHARS - 1))
  })

  test("empty text gives no lines", () => {
    expect(slotStderrLines("")).toEqual([])
    expect(slotStderrLines("\n\n")).toEqual([])
  })
})

describe("a subprocess slot with stderr output", () => {
  let dir: string
  let events: LogEvent[] = []
  let unsubscribe: (() => void) | undefined
  let stderrWrite: ReturnType<typeof spyOn<typeof process.stderr, "write">>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "slot-stderr-"))
    events = []
    unsubscribe = getDiagnosticBus().on("*", (e) => events.push(e))
    stderrWrite = spyOn(process.stderr, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    stderrWrite.mockRestore()
    unsubscribe?.()
    unsubscribe = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  function script(name: string, body: string): void {
    const file = join(dir, name)
    writeFileSync(file, `#!/bin/sh\nread -r _envelope\n${body}`)
    chmodSync(file, 0o755)
  }

  async function run(name: string, timeoutMs = 10_000): Promise<string | null> {
    const slot: ManifestLiveAreaSlot = {
      id: name,
      handler: { type: "subprocess", command: [name] },
      timeoutMs,
    }
    const resolved = await resolveLiveAreaSlot(slot, "test-plugin", dir, () => {})
    if (!resolved) throw new Error("slot did not resolve")
    const ctx = {
      packageDir: dir,
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      abort: new AbortController().signal,
      tick: 0,
    } as unknown as LiveAreaHandlerContext
    return await resolved.invoke(ctx)
  }

  const ours = (): LogEvent[] => events.filter((e) => e.source === SOURCE)

  test("stderr lines become Warning events with the slot and plugin; stdout is unchanged", async () => {
    script(
      "chatty",
      [
        "printf 'first line\\n' >&2",
        "printf '\\033[31mred\\033[0m text\\n' >&2",
        "printf '\\n' >&2",
        "printf 'out-value\\n\\n'",
      ].join("\n"),
    )
    const out = await run("chatty")

    expect(out).toBe("out-value") // trailing newlines trimmed, exactly as before
    const got = ours()
    expect(got.map((e) => e.message)).toEqual(["first line", "red text"])
    for (const e of got) {
      expect(e.severity).toBe(Severity.Warning)
      expect(e.structuredData).toEqual({ slot: "chatty", plugin: "test-plugin" })
    }
    // The text arrived on the bus, so the child's fd 2 was the pipe and not the terminal.
    expect(stderrWrite).not.toHaveBeenCalled()
  }, 15_000)

  test("a slot with no stderr output emits nothing", async () => {
    script("quiet", "printf 'fine\\n'")
    expect(await run("quiet")).toBe("fine")
    expect(ours()).toEqual([])
  }, 15_000)

  test("a flood larger than a pipe buffer does not block the child, and is capped", async () => {
    // 3000 lines of about 90 bytes is over 250 KB, far beyond a 64 KiB pipe.
    script(
      "flood",
      [
        "i=0",
        "while [ $i -lt 3000 ]; do",
        "  printf 'line %s xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n' $i >&2",
        "  i=$((i+1))",
        "done",
        "printf 'done\\n'",
      ].join("\n"),
    )
    const out = await run("flood")

    expect(out).toBe("done") // the child ran to its end: the pipe was drained
    const got = ours()
    expect(got).toHaveLength(SLOT_STDERR_MAX_LINES)
    expect(got[0]?.message.startsWith("line 0 ")).toBe(true)
    expect(stderrWrite).not.toHaveBeenCalled()
  }, 20_000)

  test("one very long stderr line is cut at 2000 characters", async () => {
    script(
      "longline",
      "head -c 5000 /dev/zero | tr '\\0' 'a' >&2\nprintf '\\n' >&2\nprintf 'ok\\n'",
    )
    expect(await run("longline")).toBe("ok")
    const got = ours()
    expect(got).toHaveLength(1)
    expect(got[0]?.message).toBe("a".repeat(SLOT_STDERR_MAX_LINE_CHARS))
  }, 15_000)

  test("stderr written before a timeout kill is still reported, and invoke returns", async () => {
    script("stuck", "printf 'about to hang\\n' >&2\nexec sleep 300")
    const started = Date.now()
    const out = await run("stuck", 1000)

    expect(out).toBeNull()
    expect(Date.now() - started).toBeLessThan(8000)
    expect(ours().map((e) => e.message)).toEqual(["about to hang"])
  }, 20_000)
})
