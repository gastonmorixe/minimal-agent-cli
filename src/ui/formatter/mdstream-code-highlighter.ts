import { basename } from "node:path"
import type { FileSink, Subprocess } from "bun"

// The highlighter port is CLI-owned (spec S24): core sends plain tool view
// events, and the CLI tool view highlights Read and Edit/Write bodies.

/** One code-highlight request: the source text and its language id. */
export interface CodeHighlightRequest {
  language: string
  code: string
}

/** Semantic colors accepted by the unified-diff highlight mode. */
export interface UnifiedDiffColors {
  inserted?: string
  deleted?: string
}

/** Mixed syntax + unified-diff highlight request. */
export interface UnifiedDiffHighlightRequest extends CodeHighlightRequest {
  colors?: UnifiedDiffColors
  diffStyle?: "marker-fg" | "bg-wash"
}

/**
 * Fail-closed port for presentation-only tool-output highlighting. Each
 * method returns `null` on any failure, so the plain render stays.
 */
export interface CodeHighlighter {
  /** Start syntax/theme initialization before the first tool result needs it. */
  warmup(): Promise<boolean>
  highlight(request: CodeHighlightRequest): Promise<string | null>
  /** Optional native mixed-diff mode. Null means unsupported or failed. */
  highlightUnifiedDiff?(request: UnifiedDiffHighlightRequest): Promise<string | null>
  close(): Promise<void>
}

export interface MdstreamCodeHighlighterOptions {
  /** Maximum time for the ready line and each highlight response. */
  timeoutMs?: number
  /** Spawn seam used by focused tests. Defaults to Bun.spawn. */
  spawn?: MdstreamHighlightSpawn
}

export type MdstreamHighlightSpawn = (argv: string[]) => Subprocess<"pipe", "pipe", "pipe">

interface HighlightResponse {
  id: number
  ansi?: string
  error?: string
}

interface ReadyResponse {
  ready: 1
  protocol?: number
  modes?: string[]
}

const DEFAULT_TIMEOUT_MS = 1_000
/**
 * Consecutive request timeouts before highlighting gives up for the session.
 * One slow patch is survivable (fail it, respawn, carry on); an unbounded
 * respawn loop on an overloaded machine is not.
 */
const MAX_CONSECUTIVE_TIMEOUTS = 3
const MAX_LINE_CODE_UNITS = 16 * 1024 * 1024

/**
 * Persistent JSONL client for `mdstream --highlight-server`.
 *
 * The process starts lazily on the first request. Calls are serialized because
 * the server is sequential and because one timeout must never leave a late
 * response available for the next caller. Any protocol or process failure
 * permanently disables this client and resolves current/future calls to null.
 */
export class MdstreamCodeHighlighter implements CodeHighlighter {
  private readonly formatterArgv: readonly string[]
  private readonly timeoutMs: number
  private readonly spawn: MdstreamHighlightSpawn
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null
  private stdin: FileSink | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private readonly stdoutDecoder = new TextDecoder()
  private stdoutBuffer = ""
  private nextId = 1
  private queue: Promise<void> = Promise.resolve()
  private readonly modes = new Set<string>()
  private protocol = 1
  private disabled = false
  private closing: Promise<void> | null = null
  /**
   * Timeouts since the last successful response. A single slow patch should
   * cost one request; a machine where EVERY request times out must not pay a
   * timeout plus a respawn forever, so consecutive timeouts eventually give up.
   */
  private consecutiveTimeouts = 0

  constructor(formatterArgv: readonly string[], options: MdstreamCodeHighlighterOptions = {}) {
    this.formatterArgv = [...formatterArgv]
    this.timeoutMs = normalizeTimeout(options.timeoutMs)
    this.spawn = options.spawn ?? spawnHighlightServer

    if (!isMdstreamFormatter(formatterArgv)) this.disabled = true
  }

  warmup(): Promise<boolean> {
    if (this.disabled || this.closing) return Promise.resolve(false)
    return new Promise((resolve) => {
      this.queue = this.queue
        .then(async () => resolve(await this.ensureStarted()))
        .catch(() => {
          this.disable()
          resolve(false)
        })
    })
  }

  /** Convenience overload for call sites that already have separate values. */
  highlight(language: string, code: string): Promise<string | null>
  highlight(request: CodeHighlightRequest): Promise<string | null>
  highlight(
    requestOrLanguage: CodeHighlightRequest | string,
    code?: string,
  ): Promise<string | null> {
    const request =
      typeof requestOrLanguage === "string"
        ? { language: requestOrLanguage, code: code ?? "" }
        : requestOrLanguage
    return this.enqueueRequest(request)
  }

  highlightUnifiedDiff(request: UnifiedDiffHighlightRequest): Promise<string | null> {
    if (!validRequest(request)) return Promise.resolve(null)
    return this.enqueueRequest(request, "unified-diff")
  }

  close(): Promise<void> {
    if (this.closing) return this.closing

    this.closing = this.queue
      .catch(() => undefined)
      .then(async () => {
        const proc = this.proc
        const stdin = this.stdin
        this.clearProcessState()

        try {
          void stdin?.end()
        } catch {}

        if (!proc) return
        // The sidecar is unref'd (it must not hold an idle REPL open) and
        // withTimeout's timer is unref'd too. While a caller awaits close(),
        // nothing else may hold the loop: re-ref the child so Bun cannot drain
        // the loop and exit 0 with the caller's promise still pending. That
        // drain hid fatal errors on `-p` (main().catch never ran).
        try {
          proc.ref()
        } catch {}
        try {
          await withTimeout(
            proc.exited.then(() => undefined),
            this.timeoutMs,
          )
        } catch {
          try {
            proc.kill()
          } catch {}
        }
      })
      .catch(() => undefined)
    this.disabled = true

    return this.closing
  }

  private enqueueRequest(
    request: CodeHighlightRequest | UnifiedDiffHighlightRequest,
    mode?: "unified-diff",
  ): Promise<string | null> {
    if (this.disabled || this.closing || !validRequest(request)) return Promise.resolve(null)

    return new Promise((resolve) => {
      this.queue = this.queue
        .then(async () => {
          resolve(await this.highlightSerialized(request, mode))
        })
        .catch(() => {
          this.disable()
          resolve(null)
        })
    })
  }

  private async highlightSerialized(
    request: CodeHighlightRequest | UnifiedDiffHighlightRequest,
    mode?: "unified-diff",
  ): Promise<string | null> {
    if (this.disabled) return null

    try {
      if (!(await this.ensureStarted())) return null
      if (mode && (this.protocol < 2 || !this.modes.has(mode))) return null

      const id = this.nextId++
      const payload =
        mode === "unified-diff"
          ? { id, mode, ...(request as UnifiedDiffHighlightRequest) }
          : { id, language: request.language, code: request.code }
      const line = `${JSON.stringify(payload)}\n`
      void this.stdin!.write(line)
      await this.stdin!.flush()

      let response: HighlightResponse | null
      try {
        response = await withTimeout(this.readResponseLine(), this.timeoutMs)
      } catch (error) {
        // A timeout is not corruption: the sidecar is alive but busy, and its
        // answer is still in the pipe. Reusing the pipe would hand that stale
        // response to the next request, so respawn and fail only THIS request.
        // Permanent disable stays reserved for real protocol failures (closed
        // stdout, bad JSON, id mismatch) below.
        if (error instanceof TimeoutError) {
          this.stopProcess()
          // Give up only when timeouts are consecutive: a slow patch in an
          // otherwise healthy session must not lose highlighting permanently,
          // while a session where nothing ever answers should stop paying for
          // a blocked second plus a respawn on every render.
          this.consecutiveTimeouts += 1
          if (this.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) this.disabled = true
          return null
        }
        throw error
      }
      if (!isHighlightResponse(response) || response.id !== id) {
        this.disable()
        return null
      }
      this.consecutiveTimeouts = 0
      // A correlated JSON error is a valid protocol response, not stream
      // corruption. Fail this presentation request closed but keep the sidecar
      // alive so the caller can use its local compositor fallback and later raw
      // Read highlights still work. Only malformed/out-of-order responses above
      // permanently disable the sequential client.
      if (typeof response.ansi !== "string") return null
      // Native unified-diff output is embedded directly beside host-owned
      // gutters, so a background still set at the end of a row tints the next
      // frame row's gutter glyph. See the guard contract above
      // `lineHasNoBleedingBackground`: rows may leave a row-scoped wash open
      // (the consumer closes it), but a row that opens a background without
      // resetting anywhere, or an SGR this parser cannot walk, is rejected.
      // Raw highlighting stays compatible with v1 servers; this guard is
      // specific to protocol v2 unified-diff mode.
      if (mode === "unified-diff" && !hasNoBleedingBackground(response.ansi)) return null
      return response.ansi
    } catch {
      this.disable()
      return null
    }
  }

  private async ensureStarted(): Promise<boolean> {
    if (this.proc && this.stdin && this.reader) return true
    if (this.disabled) return false

    try {
      const proc = this.spawn([...this.formatterArgv, "--highlight-server"])
      this.proc = proc
      this.stdin = proc.stdin
      this.reader = proc.stdout.getReader()
      proc.unref()
      void drain(proc.stderr).catch(() => undefined)
      // A sidecar we deliberately killed on timeout must not disable the client:
      // its exit is our doing, and the next request respawns. Only an exit of
      // the CURRENT process that we did not ask for is a protocol failure.
      void proc.exited
        .then(() => {
          if (this.proc === proc) this.disable()
        })
        .catch(() => {
          if (this.proc === proc) this.disable()
        })

      const ready = await withTimeout(this.readJsonLine(), this.timeoutMs)
      if (!isReadyResponse(ready)) {
        this.disable()
        return false
      }
      this.protocol = Number.isSafeInteger(ready.protocol) ? (ready.protocol ?? 1) : 1
      this.modes.clear()
      for (const mode of ready.modes ?? []) {
        if (typeof mode === "string") this.modes.add(mode)
      }
      return true
    } catch {
      this.disable()
      return false
    }
  }

  private async readResponseLine(): Promise<HighlightResponse | null> {
    const value = await this.readJsonLine()
    return isObject(value) ? (value as unknown as HighlightResponse) : null
  }

  private async readJsonLine(): Promise<unknown> {
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n")
      if (newline !== -1) {
        const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "")
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
        if (line.length === 0) throw new Error("empty highlight-server response")
        return JSON.parse(line)
      }
      if (this.stdoutBuffer.length > MAX_LINE_CODE_UNITS) {
        throw new Error("highlight-server response too large")
      }

      const next = await this.reader?.read()
      if (!next || next.done) throw new Error("highlight-server stdout closed")
      this.stdoutBuffer += this.stdoutDecoder.decode(next.value, { stream: true })
    }
  }

  private disable(): void {
    if (this.disabled && !this.proc) return
    this.disabled = true
    this.stopProcess()
  }

  /**
   * Kill the sidecar and drop its pipe WITHOUT disabling the client.
   *
   * Used for a request timeout: the process is alive but slow, and its late
   * answer is still buffered in stdout, so the next request would read a stale
   * id. Dropping the process discards that answer, and the next call re-enters
   * `ensureStarted` and spawns a fresh sidecar. Permanent disable stays for
   * protocol corruption, where retrying cannot help.
   */
  private stopProcess(): void {
    const proc = this.proc
    const stdin = this.stdin
    this.clearProcessState()

    try {
      void stdin?.end()
    } catch {}
    try {
      proc?.kill()
    } catch {}
  }

  private clearProcessState(): void {
    try {
      void this.reader?.cancel()
    } catch {}
    this.proc = null
    this.stdin = null
    this.reader = null
    this.stdoutBuffer = ""
  }
}

/** True only for an argv whose executable basename is literally `mdstream`. */
export function isMdstreamFormatter(formatterArgv: readonly string[]): boolean {
  const executable = formatterArgv[0]
  if (typeof executable !== "string") return false
  return (
    basename(executable.replaceAll("\\", "/"))
      .toLowerCase()
      .replace(/\.exe$/, "") === "mdstream"
  )
}

/** Create the optional highlighter port, returning null for all other formatters. */
export function createMdstreamCodeHighlighter(
  formatterArgv: readonly string[] | undefined,
  options?: MdstreamCodeHighlighterOptions,
): CodeHighlighter | null {
  if (!formatterArgv || !isMdstreamFormatter(formatterArgv)) return null
  return new MdstreamCodeHighlighter(formatterArgv, options)
}

function spawnHighlightServer(argv: string[]): Subprocess<"pipe", "pipe", "pipe"> {
  return Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const _chunk of stream) {
    // Discard diagnostics. Highlighting must not write into the TUI.
  }
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_TIMEOUT_MS
}

function validRequest(request: CodeHighlightRequest): boolean {
  return (
    typeof request.language === "string" &&
    request.language.trim().length > 0 &&
    typeof request.code === "string"
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isReadyResponse(value: unknown): value is ReadyResponse {
  return (
    isObject(value) &&
    value.ready === 1 &&
    (value.protocol === undefined || Number.isSafeInteger(value.protocol)) &&
    (value.modes === undefined ||
      (Array.isArray(value.modes) && value.modes.every((mode) => typeof mode === "string")))
  )
}

function isHighlightResponse(value: HighlightResponse | null): value is HighlightResponse {
  return (
    value !== null &&
    Number.isSafeInteger(value.id) &&
    (typeof value.ansi === "string" || typeof value.error === "string")
  )
}

/**
 * True when no line leaves a background wash open in a way the caller cannot
 * repair by closing the row at end of line.
 *
 * ACCEPT RULE (chosen deliberately): a line is accepted when it either CLOSES
 * its background (SGR 0 or 49) or leaves it open while also carrying its own
 * reset somewhere on the line. The second arm is the "caller can safely close
 * it" case: real mdstream v0.3.6 bg-wash rows reset after the `+`/`-` marker
 * and then leave the row background set to end of line
 * (`\x1b[38;2;135;255;0m+\x1b[0m\x1b[48;2;135;255;0m\x1b[38;2;...`), and the
 * rendering side appends an `SGR 49` at end of line so the wash still reaches
 * the last glyph while the next frame row's gutter starts on the default
 * background.
 *
 * What is rejected: a line that opens a background with no reset anywhere on
 * it. Nothing bounds that wash, so appending a close could break a deliberate
 * multi-line background span. Fail closed instead.
 *
 * This replaces the earlier rule that treated "background open, then a
 * foreground escape" as safe. That accepted exactly the leaking shape: the next
 * row's gutter is painted before any reset reaches the terminal. A foreground
 * escape says nothing about the background, so it no longer influences this
 * decision.
 */
function hasNoBleedingBackground(value: string): boolean {
  if (!value.includes("\x1b[")) return true
  return value.split("\n").every((line) => lineHasNoBleedingBackground(line))
}

/** SGR state one line leaves behind. */
interface SgrLineState {
  /** A background colour is still set at the end of the line. */
  backgroundOpen: boolean
  /** The line carries at least one reset (SGR 0 or background-only 49). */
  sawReset: boolean
}

/**
 * SGR parameter numbers in one sequence. Both `;` and `:` separate parameters,
 * because terminals accept the colon sub-parameter form
 * (`ESC[48:2::255:95:215m`) and a parser that ignores it silently misses a
 * whole wash. An empty body means reset (`0`).
 */
function sgrParams(body: string): number[] {
  if (body.length === 0) return [0]
  return body.split(/[;:]/).map((part) => {
    if (part.length === 0) return 0
    const value = Number(part)
    return Number.isFinite(value) ? value : 0
  })
}

/** Walk one SGR sequence, returning the state it leaves behind. */
function applySgr(params: number[], state: SgrLineState): SgrLineState {
  let backgroundOpen = state.backgroundOpen
  let sawReset = state.sawReset
  for (let index = 0; index < params.length; index++) {
    const param = params[index]!
    if (param === 0 || param === 49) {
      backgroundOpen = false
      sawReset = true
      continue
    }
    if (param === 48) {
      // 48;5;n or 48;2;r;g;b. A bare 48 with no mode is ignored by terminals,
      // so it must not count as an open background.
      const mode = params[index + 1]
      if (mode === 2) {
        index += 4
        backgroundOpen = true
      } else if (mode === 5) {
        index += 2
        backgroundOpen = true
      }
      continue
    }
    if (param === 38) {
      const mode = params[index + 1]
      index += mode === 2 ? 4 : mode === 5 ? 2 : 0
      continue
    }
    if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107)) {
      backgroundOpen = true
    }
  }
  return { backgroundOpen, sawReset }
}

/**
 * Walk every CSI sequence on one line. Returns null when the line carries an
 * escape this parser cannot account for: an unterminated `ESC[`, or an `SGR`
 * whose body is not pure parameters.
 */
function scanSgr(line: string): SgrLineState | null {
  let state: SgrLineState = { backgroundOpen: false, sawReset: false }
  let index = line.indexOf("\x1b[")
  while (index !== -1) {
    // A CSI sequence ends on its final byte, 0x40..0x7E.
    let cursor = index + 2
    while (cursor < line.length) {
      const code = line.charCodeAt(cursor)
      if (code >= 0x40 && code <= 0x7e) break
      cursor++
    }
    if (cursor >= line.length) return null
    const final = line[cursor]!
    const body = line.slice(index + 2, cursor)
    if (final === "m") {
      if (!/^[0-9;:]*$/.test(body)) return null
      state = applySgr(sgrParams(body), state)
    }
    index = line.indexOf("\x1b[", cursor + 1)
  }
  return state
}

function lineHasNoBleedingBackground(line: string): boolean {
  const content = line.endsWith("\r") ? line.slice(0, -1) : line
  if (!content.includes("\x1b[")) return true
  const state = scanSgr(content)
  // Unparsable input is rejected outright. A wash set through a form this
  // parser cannot tokenize would otherwise pass the guard invisibly.
  if (state === null) return false
  return !state.backgroundOpen || state.sawReset
}

/**
 * True when a rendered line ends with a background still set, so the caller
 * must close it with `SGR 49` before another row is drawn. Unparsable input
 * reports true: appending a background-only reset is always harmless, while
 * leaving a real wash open tints the next row's gutter.
 */
export function lineEndsWithOpenBackground(line: string): boolean {
  const content = line.endsWith("\r") ? line.slice(0, -1) : line
  if (!content.includes("\x1b[")) return false
  return scanSgr(content)?.backgroundOpen ?? true
}

/**
 * A request exceeded its time budget. Distinguishable from other failures
 * because a timeout is recoverable (respawn) while protocol corruption is not.
 */
class TimeoutError extends Error {
  constructor() {
    super("mdstream highlight timeout")
    this.name = "TimeoutError"
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), timeoutMs)
    timer.unref()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
