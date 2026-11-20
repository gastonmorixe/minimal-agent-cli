/**
 * SIGTERM wrap-up for the headless event-stream route (`-p` with
 * `--output-format json`, `stream-json` or `open-responses`).
 *
 * Only a sub-agent worker gets it: the process must have a non-empty
 * {@link ENV_WRAP_UP_TOOLS} (the sub-agents plugin always sets it for a
 * worker). Without it, the route installs no listener, and SIGTERM works as
 * before (the default action, or the file-lock exit 143).
 *
 * The pattern is the same as the host-mode signal grace
 * (`run-host-mode.ts` `installSignalHandling`):
 *
 * - The first SIGTERM aborts the run signal with a core wrap-up reason
 *   (`kind: "wrap_up"`), not a user abort. The core stops the request, the
 *   retry wait and the tool run. Then it sends ONE short final turn with
 *   {@link WRAP_UP_NOTE}, runs its tool calls, and the run ends with
 *   outcome `truncated`. The process then exits with code 143.
 * - A second SIGTERM, or {@link WRAP_UP_GRACE_MS} after the first one,
 *   ends the process at once with code 143.
 * - After the run of a wrap-up ends, {@link HeadlessWrapUp.exitAfterRun}
 *   ends the process after {@link AFTER_RUN_EXIT_MS} if a live handle (a
 *   child, a socket, a plugin timer) keeps it alive.
 *
 * A second SIGTERM in the first {@link REPEAT_IGNORE_MS} is ignored. That
 * is mainly a supervisor that sends the signal two times. (A plugin
 * fan-out listener does not raise it again while this owner listens.)
 *
 * The interactive TUI and host mode do not use this module.
 *
 * @module startup/headless-wrap-up
 */

/** Exit code for an end by SIGTERM: 128 plus the signal number. */
export const SIGTERM_EXIT_CODE = 143

/** Time after the first SIGTERM before the process ends, in ms. */
export const WRAP_UP_GRACE_MS = 45_000

/** A second SIGTERM in this time after the first one is ignored, in ms. */
export const REPEAT_IGNORE_MS = 500

/** Longest time a forced end waits for stdout to drain, in ms. */
const FORCED_EXIT_DRAIN_MS = 1000

/** After the run of a wrap-up, a live handle keeps the process at most this long, in ms. */
export const AFTER_RUN_EXIT_MS = 2000

/** The one template of the note (ASD-STE100). `tool` names the report tool. */
function noteText(tool: string): string {
  return `Your time is finished. Do not start new work. Call ${tool} now, with the results that you have. Tell which work is not complete.`
}

/**
 * The model note of the final turn. It names no plugin tool:
 * {@link wrapUpNote} adds the tool name when {@link ENV_WRAP_UP_TOOLS}
 * names exactly one tool.
 */
export const WRAP_UP_NOTE = noteText("the tool that reports your result")

/** Time before the forced end that the final turn must end, in ms. */
export const WRAP_UP_DEADLINE_MARGIN_MS = 3000

/** The note of the final turn. With exactly one wrap-up tool, it names that tool. */
export function wrapUpNote(tools: readonly string[]): string {
  return tools.length === 1 ? noteText(`the ${tools[0]} tool`) : WRAP_UP_NOTE
}

/**
 * Env var: a comma list of tool names. When set, the final request
 * advertises only these tools (for example the report tool of a worker).
 */
export const ENV_WRAP_UP_TOOLS = "MINIMAL_AGENT_WRAP_UP_TOOLS"

/**
 * The core abort reason of a wrap-up (see core `sdk/wrap-up.ts`). It is an
 * `Error` with the name `AbortError` (the shape of a user abort), so code
 * that reads `err.name` or `err.message` after `throwIfAborted()` works.
 * The core finds it by `kind`.
 */
export interface WrapUpAbortReason extends Error {
  readonly kind: "wrap_up"
  readonly text: string
  readonly tools?: readonly string[]
  /** Epoch ms: the final turn must end before it (core `WrapUpReason.deadlineAt`). */
  readonly deadlineAt?: number
}

/** Options of {@link installHeadlessWrapUp}. */
export interface HeadlessWrapUpOptions {
  /** Where SIGTERM arrives. Default: `process`. */
  readonly signalSource?: Pick<NodeJS.Process, "on" | "removeListener">
  /** Ends the process on a forced end. Default: drain stdout, then `process.exit`. */
  readonly exitProcess?: (code: number) => void
  /** Where the one-line notes go. Default: `process.stderr`. */
  readonly stderr?: (chunk: string) => void
  /** Env for {@link ENV_WRAP_UP_TOOLS}. Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Grace time in ms. Default: {@link WRAP_UP_GRACE_MS}. */
  readonly graceMs?: number
  /** Wall clock (epoch ms) for {@link REPEAT_IGNORE_MS} and `deadlineAt`. Default: `Date.now`. */
  readonly now?: () => number
  /** Time for {@link HeadlessWrapUp.exitAfterRun}. Default: {@link AFTER_RUN_EXIT_MS}. */
  readonly afterRunExitMs?: number
}

/** The installed handler. */
export interface HeadlessWrapUp {
  /** Give it to `session.run`. It aborts with the wrap-up reason on SIGTERM. */
  readonly signal: AbortSignal
  /** True after the first SIGTERM. */
  readonly started: () => boolean
  /**
   * Remove the SIGTERM listener and stop the grace wait. Call it when the
   * run ends. After a wrap-up, then call {@link exitAfterRun}.
   */
  readonly dispose: () => void
  /**
   * After a wrap-up (the run and the `result` line are done): end the
   * process with `code` after {@link AFTER_RUN_EXIT_MS}. The timer does not
   * keep the process alive. It fires only when a live handle does.
   */
  readonly exitAfterRun: (code: number) => void
}

/** True when this process is a sub-agent worker: {@link ENV_WRAP_UP_TOOLS} names a tool. */
export function wantsHeadlessWrapUp(env: Readonly<Record<string, string | undefined>>): boolean {
  return envTools(env).length > 0
}

/** The tool names of {@link ENV_WRAP_UP_TOOLS}. */
function envTools(env: Readonly<Record<string, string | undefined>>): string[] {
  return (env[ENV_WRAP_UP_TOOLS] ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/**
 * The wrap-up reason for the core, with the tool list from the env. With
 * `deadlineAt` (epoch ms), the core ends the final turn before it.
 */
export function wrapUpReason(
  env: Readonly<Record<string, string | undefined>>,
  deadlineAt?: number,
): WrapUpAbortReason {
  const tools = envTools(env)
  return Object.assign(new Error("wrap_up"), {
    name: "AbortError",
    kind: "wrap_up" as const,
    text: wrapUpNote(tools),
    ...(tools.length > 0 ? { tools } : {}),
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
  })
}

/**
 * The default forced end: set the exit code, wait for stdout to drain (at
 * most 1 s), then exit.
 */
function exitAfterDrain(code: number): void {
  process.exitCode = code
  const exit = (): never => process.exit(code)
  // `AbortSignal.timeout` never keeps the process alive by itself.
  AbortSignal.timeout(FORCED_EXIT_DRAIN_MS).addEventListener("abort", exit, { once: true })
  process.stdout.write("", exit)
}

/** Listen for SIGTERM while a headless run goes. See the module doc. */
export function installHeadlessWrapUp(opts: HeadlessWrapUpOptions = {}): HeadlessWrapUp {
  const controller = new AbortController()
  const stderr = opts.stderr ?? ((chunk: string) => void process.stderr.write(chunk))
  const exitProcess = opts.exitProcess ?? exitAfterDrain
  const now = opts.now ?? Date.now
  const source = opts.signalSource ?? process
  let firstAt = 0
  let forced = false
  let grace: AbortSignal | undefined
  const forceEnd = (why: string): void => {
    if (forced) return
    forced = true
    stderr(`[minimal-agent] ${why}; ending the process\n`)
    // `exitProcess` sets the exit code (the default does it in `exitAfterDrain`).
    exitProcess(SIGTERM_EXIT_CODE)
  }
  const onGraceEnd = (): void => forceEnd("the wrap-up did not end in time after SIGTERM")
  const onSigterm = (): void => {
    if (controller.signal.aborted) {
      if (now() - firstAt >= REPEAT_IGNORE_MS) forceEnd("second SIGTERM")
      return
    }
    firstAt = now()
    const graceMs = opts.graceMs ?? WRAP_UP_GRACE_MS
    stderr("[minimal-agent] SIGTERM: wrap-up started (one final turn)\n")
    const deadlineAt = firstAt + graceMs - WRAP_UP_DEADLINE_MARGIN_MS
    controller.abort(wrapUpReason(opts.env ?? process.env, deadlineAt))
    grace = AbortSignal.timeout(graceMs)
    grace.addEventListener("abort", onGraceEnd, { once: true })
  }
  source.on("SIGTERM", onSigterm)
  return {
    signal: controller.signal,
    started: () => controller.signal.aborted,
    dispose: (): void => {
      grace?.removeEventListener("abort", onGraceEnd)
      source.removeListener("SIGTERM", onSigterm)
    },
    exitAfterRun: (code: number): void => {
      const end = (): void => {
        if (forced) return
        forced = true
        stderr("[minimal-agent] a live handle kept the process after the wrap-up; ending it\n")
        exitProcess(code)
      }
      // `AbortSignal.timeout` never keeps the process alive by itself.
      AbortSignal.timeout(opts.afterRunExitMs ?? AFTER_RUN_EXIT_MS).addEventListener("abort", end, {
        once: true,
      })
    },
  }
}
