/**
 * Tier-2 interactive host layer: queue/abort/status wiring around a
 * `createRuntime`/`openSession` {@link Session}.
 *
 * Owns interaction concerns the conversation engine must not import
 * (reflection cooldown with Esc-skip, per-turn transcript rebinding,
 * ReplAgentLike surface). The REPL and other interactive frontends consume
 * this instead of calling the legacy {@link Agent} loop.
 *
 * Drives its turn through the same `createRuntime` / `openSession` /
 * `Session` contract `minimal-agent-web` already runs in production (agent
 * M's S47): a session owns one `AgentCore`, built from the host's real
 * collaborators (plugin-loaded tool registry, mode manager, session store,
 * lifecycle hooks, ...) via the same adapters `buildAgentCore` uses, so a
 * `--prompt` or `--output-format text` run through this class is byte-
 * identical to before — only the assembly seam changed, not the engine.
 *
 * @module host/interactive-session
 */

import { createRuntime, type ResumeSessionOptions, type Session } from "@minimal-agent/core"
import {
  type CompactRequestOpts,
  takePendingCompact,
} from "@minimal-agent/core/host/compact-contract"
import { GLOBAL_STATUS_BUS } from "@minimal-agent/core/host/status-bus"
import { loadBlobStoreConfig } from "@minimal-agent/core/host-kit/blob-store"
import { type BuildAgentCoreDeps, toEffort } from "@minimal-agent/core/host-kit/build-agent-core"
import { ToolFeedbackTracker } from "@minimal-agent/core/host-kit/feedback-tracker"
import { createLifecyclePort } from "@minimal-agent/core/host-kit/lifecycle-port-adapter"
import { MediaResolverAdapter } from "@minimal-agent/core/host-kit/media-resolver-adapter"
import { ModeProviderAdapter } from "@minimal-agent/core/host-kit/mode-provider-adapter"
import type { ModeManager } from "@minimal-agent/core/host-kit/modes"
import type { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { PromptContributorAdapter } from "@minimal-agent/core/host-kit/prompt-contributor-adapter"
import { SessionPersistenceAdapter } from "@minimal-agent/core/host-kit/session-persistence-adapter"
import { ToolExecutorAdapter } from "@minimal-agent/core/host-kit/tool-executor-adapter"
import { ToolRegistryAdapter } from "@minimal-agent/core/host-kit/tool-registry-adapter"
import type { ManifestMode } from "@minimal-agent/core/plugin-api/types/plugin"
import type { TurnResult } from "@minimal-agent/core/sdk/agent-core"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"
import type { Message } from "@minimal-agent/core/sdk/messages"
import type { InputQueuePort } from "@minimal-agent/core/sdk/ports"
import type { PreflightIssue } from "@minimal-agent/core/sdk/provider"
import { toolFilterFromNamePolicy } from "@minimal-agent/core/sdk/tool-filter"
import { formatTurnNoticePlain } from "@minimal-agent/core/sdk/turn-notice"
import { inputCaptureStack } from "./input/input-capture-stack.ts"
import { retryBoundaryText } from "./logging/retry-boundary-text.ts"
import { TOOL_PRESENTATION } from "./plugins-ui/tool-presentation.ts"
import { runReflectionCooldown } from "./reflection-cooldown.ts"
import type { ReplAgentLike } from "./repl.ts"
import { createPluginEventsPort, createStatusPort } from "./startup/host-ports.ts"
import { TERMINAL_TOOL_ENV, terminalColumns } from "./terminal/terminal-tool-env.ts"
import { type StepLive, TurnRenderPump } from "./turn-render-pump.ts"
import type { CodeHighlighter } from "./ui/formatter/mdstream-code-highlighter.ts"
import type { ToolTimeTracker } from "./ui/tool-transcript/tool-time.ts"
import { createReplToolView } from "./ui/tool-transcript/tool-view.ts"

type MaybePromise<T> = T | Promise<T>

type TranscriptWriter = (line: string) => void

/** Input handed to the interactive host's reflection checkpoint behavior. */
export interface ReflectionCheckpointContext {
  round: number
  cooldownMs: number
  signal?: AbortSignal
}

/**
 * Interactive reflection behavior. The implementation owns completion, abort,
 * and any host-specific skip affordance such as temporarily capturing Esc.
 */
export interface ReflectionCheckpointBehavior {
  wait(context: ReflectionCheckpointContext): Promise<void>
}

/**
 * Run-scoped transcript router. A lease cannot overwrite another active run,
 * and releasing a stale lease cannot disturb the current route.
 */
export class TranscriptRouter {
  private active: symbol | null = null
  private current: TranscriptWriter

  constructor(private readonly fallback: TranscriptWriter = () => {}) {
    this.current = fallback
  }

  readonly write = (line: string): void => {
    this.current(line)
  }

  /**
   * Route lines to `writer` (default: the fallback) until the returned
   * release runs. `wrap` can put the chosen writer behind another step,
   * for example the turn's render pump.
   */
  acquire(
    writer?: TranscriptWriter,
    wrap: (target: TranscriptWriter) => TranscriptWriter = (target) => target,
  ): () => void {
    if (this.active !== null) {
      throw new Error("InteractiveSession already has an active run")
    }
    const lease = Symbol("interactive-session-transcript")
    this.active = lease
    this.current = wrap(writer ?? this.fallback)
    return () => {
      if (this.active !== lease) return
      this.active = null
      this.current = this.fallback
    }
  }
}

export type InteractiveSessionDeps = BuildAgentCoreDeps & {
  /** Mode manager for prompt/status/cycling (same instance as buildAgentCore). */
  modeManager: ModeManager | null
  /**
   * Transcript sink for the tool rows and the turn rows when no run gives
   * its own writer.
   */
  writeTranscript?: (line: string) => void
  /** Optional `· HH:MM:SS` tool-header time hints. */
  toolTimeTracker?: ToolTimeTracker | null
  /** Warm, fail-closed syntax highlighter for the tool transcript bodies. */
  codeHighlighter?: CodeHighlighter | null
  /** Injectable interactive reflection behavior. Defaults to the real TUI cooldown. */
  reflectionCheckpoint?: ReflectionCheckpointBehavior
  /**
   * `--resume` target: the session store's id and directory. When set, the
   * session opens through core's `resumeSession` (S50), and
   * `initialMessages` / `initialCheckpoint` are not used.
   */
  resumeFrom?: { sid: string; dir: string }
}

const DEFAULT_REFLECTION_CHECKPOINT: ReflectionCheckpointBehavior = {
  async wait({ round, cooldownMs, signal }): Promise<void> {
    await runReflectionCooldown({
      totalMs: cooldownMs,
      round,
      statusBus: GLOBAL_STATUS_BUS,
      inputCaptureStack,
      ...(signal ? { signal } : {}),
    })
  },
}

/**
 * The per-run state behind the session's `inputQueue` and `reflectionGate`
 * ports. The ports are built once, with the session. Each run sets what
 * they read, and clears it when it ends.
 */
class RunPortState {
  /** The queue of the run in progress, if the run has one. */
  inputQueue: InputQueuePort | null = null
  /** The reflection wait of the run in progress. */
  reflection: ((round: number) => Promise<void>) | null = null
  /** The render pump of the run in progress. */
  pump: TurnRenderPump | null = null

  /** The `inputQueue` port: reads the queue of the run in progress. */
  readonly inputQueuePort: InputQueuePort = {
    take: () => this.inputQueue?.take() ?? null,
    injected: (text) => this.inputQueue?.injected?.(text),
  }

  /**
   * The `reflectionGate` port: waits on the reflection behavior of the run
   * in progress. It first waits for the pump to go idle, so the cooldown
   * shows after the rows of the round before it.
   */
  readonly reflectionGatePort = {
    beforeCheckpoint: async (round: number): Promise<void> => {
      await this.pump?.idle()
      await this.reflection?.(round)
    },
  }
}

/**
 * The contributor list with the host append text (`appendSystemPrompt`,
 * SPEC-ONESHOT R8) after the plugin contributor. Same rule as core's
 * `openAgentCoreSession` (M2): blank or missing text adds nothing, and the
 * text lands after the instructions block. Read structurally, so this also
 * builds against a pinned core whose deps type has no such field (the
 * caller only sets it when that core supports it).
 */
export function withAppendContributor<C extends object>(
  base: C,
  deps: object,
): Array<C | { afterInstructionsBlocks: () => Array<{ type: "text"; text: string }> }> {
  const text = (deps as { appendSystemPrompt?: unknown }).appendSystemPrompt
  const trimmed = typeof text === "string" ? text.trim() : ""
  if (trimmed === "") return [base]
  return [base, { afterInstructionsBlocks: () => [{ type: "text", text: trimmed }] }]
}

/**
 * Build the `Session` behind one {@link InteractiveSession}: the same
 * host collaborators `buildAgentCore` wires (plugin-loaded tool registry,
 * mode manager, session persistence, lifecycle hooks, media resolver),
 * assembled from the exact same adapter classes, but handed to
 * `createRuntime().openSession(...)` instead of `new AgentCore(...)`.
 *
 * `askUserFallback: "none"`: this session is shared by the interactive
 * REPL (which may pass its own per-run `askUser` when a modal is actually
 * mounted) and the non-interactive `--prompt` path (which never does). With
 * no per-run override, a preflight issue must be denied with an
 * `ask_denied` notice and sent unchanged — `AgentCore`'s own headless
 * fallback. This is also `Session`'s default since core decision 34. The
 * value stays explicit, because no `session.answer()` caller exists here.
 */
async function openInteractiveSession(
  deps: InteractiveSessionDeps,
  writeTranscript: TranscriptWriter,
  runPorts: RunPortState,
): Promise<Session> {
  // Tool registry: core built-ins + plugin tools, with aliases.
  const toolRegistry = new ToolRegistryAdapter(deps.loader)

  // Tool executor: runs executeToolRound verbatim. It is the SOLE persister of
  // tool_result records (with blob + presentation fidelity), so it gets the
  // store; the session-persistence adapter no-ops appendToolResult.
  const hooks = deps.loader && typeof deps.loader.hooks === "function" ? deps.loader.hooks() : null
  const lifecycle = createLifecyclePort(hooks)
  // S23: one status port for the sends and the tool rows. A caller port wins.
  const statusPort = deps.statusPort ?? createStatusPort()

  // S24: core sends plain tool view events. The CLI builds the rows.
  const toolView = createReplToolView({
    writeTranscript,
    // The CLI's static map (S41): icon, color, and early header paint.
    presentation: TOOL_PRESENTATION,
    toolTimeTracker: deps.toolTimeTracker ?? null,
    codeHighlighter: deps.codeHighlighter ?? null,
    columns: terminalColumns,
  })
  const toolExecutor = new ToolExecutorAdapter({
    loader: deps.loader,
    modeManager: deps.modeManager,
    blobStore: deps.blobStore,
    blobSkipTools: loadBlobStoreConfig().skipTools,
    feedbackTracker: new ToolFeedbackTracker(),
    toolView,
    model: deps.model,
    store: deps.store,
    fileTrackingStore: deps.fileTrackingStore,
    lifecycle,
    // S24: the CLI gives Bash its own terminal size. Core reads none.
    toolEnv: deps.toolEnv ?? TERMINAL_TOOL_ENV,
    statusPort,
  })

  // Prompt contributor: awaits the plugin prompt block once (parity seam),
  // plus save-echoes and per-turn attachment producers.
  const promptContributor = await PromptContributorAdapter.create({
    loader: deps.loader,
    saveEcho: deps.saveEcho,
    turnAttachments: deps.turnAttachments,
  })

  // Session persistence: user/assistant/note/rewind only (tool_result owned by
  // the executor adapter). Omitted entirely when no store is wired.
  const sessionPersistence = deps.store ? new SessionPersistenceAdapter(deps.store) : undefined

  // Mode provider: the mode-change signal + read-only queries.
  const modeProvider = deps.modeManager ? new ModeProviderAdapter(deps.modeManager) : undefined

  // Advertisement filter: CLI/SDK name policy → structural ToolAdvertisementFilter.
  const toolFilter =
    deps.toolNamePolicy != null ? toolFilterFromNamePolicy(deps.toolNamePolicy) : undefined

  // Media resolver: ingest inline @file / image refs using the run's model.
  const mediaResolver = new MediaResolverAdapter(deps.model)

  const options = {
    auth: deps.auth,
    model: deps.model,
    ...(deps.providerId !== undefined ? { providerId: deps.providerId } : {}),
    ...(deps.credentialName !== undefined ? { credentialName: deps.credentialName } : {}),
    ...(toEffort(deps.effort) !== undefined ? { effort: toEffort(deps.effort) } : {}),
    ...(deps.outputSchema !== undefined ? { outputSchema: deps.outputSchema } : {}),
    ...(deps.speed !== undefined ? { speed: deps.speed } : {}),
    ...(deps.serviceTier !== undefined ? { serviceTier: deps.serviceTier } : {}),
    ...(deps.thinkingDisplay !== undefined ? { thinkingDisplay: deps.thinkingDisplay } : {}),
    ...(deps.cacheTtl !== undefined ? { cacheTtl: deps.cacheTtl } : {}),
    ...(deps.sendFn !== undefined ? { sendFn: deps.sendFn } : {}),
    ...(deps.networkClient !== undefined ? { networkClient: deps.networkClient } : {}),
    toolRegistry,
    ...(toolFilter ? { toolFilter } : {}),
    toolExecutor,
    ...(sessionPersistence ? { sessionPersistence } : {}),
    promptContributors: withAppendContributor(promptContributor, deps),
    ...(modeProvider ? { modeProvider } : {}),
    mediaResolver,
    lifecycle,
    // `systemPrompt` + `maxTokens` are vestigial, like `buildAgentCore`'s own
    // config: `run()` derives both itself.
    systemPrompt: "",
    maxTokens: 0,
    ...(deps.systemPromptOverrides ? { systemPromptOverrides: deps.systemPromptOverrides } : {}),
    ...(deps.reflectionInterval !== undefined
      ? { reflectionInterval: deps.reflectionInterval }
      : {}),
    ...(deps.reflectionCooldownMs !== undefined
      ? { reflectionCooldownMs: deps.reflectionCooldownMs }
      : {}),
    ...(deps.retry !== undefined ? { retry: deps.retry } : {}),
    // S23/S28: the CLI status rows and the plugin bus get the engine's
    // status phases and stream telemetry. A caller port wins.
    statusPort,
    pluginEvents: deps.pluginEvents ?? createPluginEventsPort(deps.loader),
    // S17/S27: the `compactSource` port reads the plugin host's
    // `context:compact` queue, exactly like `buildAgentCore`. The queue and
    // reflection ports read the state of the run in progress (S37).
    ports: {
      compactSource: { take: () => takePendingCompact() },
      inputQueue: runPorts.inputQueuePort,
      reflectionGate: runPorts.reflectionGatePort,
    },
    askUserFallback: "none",
  } satisfies ResumeSessionOptions
  const runtime = createRuntime()
  // S50: a `--resume` with a session store reopens the session through
  // core's `resumeSession`. Core reads the history and the last round
  // checkpoint back from the store, so `run(_, { resume: true })` can
  // continue an unfinished turn at its next round. The event log stays in
  // memory, as for a new session.
  if (deps.resumeFrom) {
    return runtime.resumeSession(deps.resumeFrom.sid, {
      ...options,
      persist: { dir: deps.resumeFrom.dir, cwd: process.cwd() },
      eventLogPath: null,
    })
  }
  return runtime.openSession({
    ...options,
    ...(deps.initialMessages !== undefined ? { initialMessages: deps.initialMessages } : {}),
    ...(deps.initialCheckpoint !== undefined ? { initialCheckpoint: deps.initialCheckpoint } : {}),
  })
}

/**
 * Interactive session: a `Session` + Tier-2 hooks implementing
 * {@link ReplAgentLike}.
 */
export class InteractiveSession implements ReplAgentLike {
  private constructor(
    private readonly session: Session,
    private readonly loader: PluginLoader | null,
    private readonly modeManager: ModeManager | null,
    private readonly transcript: TranscriptRouter,
    private readonly reflectionCheckpoint: ReflectionCheckpointBehavior,
    private readonly runPorts: RunPortState,
  ) {}

  /**
   * Build a fully-wired session (`Session` + interactive transcript bridge).
   */
  static async create(deps: InteractiveSessionDeps): Promise<InteractiveSession> {
    const transcript = new TranscriptRouter(deps.writeTranscript)
    const runPorts = new RunPortState()
    const session = await openInteractiveSession(deps, transcript.write, runPorts)
    return new InteractiveSession(
      session,
      deps.loader,
      deps.modeManager,
      transcript,
      deps.reflectionCheckpoint ?? DEFAULT_REFLECTION_CHECKPOINT,
      runPorts,
    )
  }

  /**
   * Underlying engine (tests / slash-command bridges / the live-area host's
   * history-edit rewrite). An escape hatch for operations outside the
   * session-driving contract — never for running a turn; use `run()`.
   */
  agentCore() {
    return this.session.agentCore()
  }

  pluginLoader(): PluginLoader | null {
    return this.loader
  }

  modes(): ModeManager | null {
    return this.modeManager
  }

  getActiveMode(): ManifestMode | null {
    return this.modeManager?.active() ?? null
  }

  getModel(): string {
    return this.session.agentCore().getModel()
  }

  setModel(model: string): void {
    this.session.agentCore().setModel(model)
  }

  history(): Message[] {
    return this.session.agentCore().history()
  }

  appendNote(text: string): void {
    this.session.agentCore().appendNote(text)
  }

  rollbackPendingTurn(): boolean {
    return this.session.agentCore().rollbackPendingTurn()
  }

  notePreviousTurnAborted(): void {
    this.session.agentCore().notePreviousTurnAborted()
  }

  noteSessionResumed(): void {
    this.session.agentCore().noteSessionResumed()
  }

  compact(opts?: CompactRequestOpts) {
    return this.session.agentCore().compact(opts)
  }

  /**
   * Run a host render write in turn order. During a run, the write waits
   * for the rows and text the log emitted before it (S36). With no run in
   * progress, it runs at once. The REPL uses it for writes from inside a
   * core port: the queue echo and the mode-change chip.
   */
  renderInOrder(step: () => void): void {
    if (this.runPorts.pump) this.runPorts.pump.step(step)
    else step()
  }

  /**
   * Run one user turn through the session, with interactive cooldown +
   * per-turn transcript rebinding. The turn renders from the session's own
   * log entries (S36): each `text_delta` comes out as a yielded string, and
   * every other event goes to `opts.onEvent`. A {@link TurnRenderPump}
   * keeps the text, the events, and the tool transcript rows in log order.
   * With no `onEvent`, a `notice` is written as a plain transcript line.
   */
  async *run(
    userText: string,
    opts?: {
      onTranscriptLine?: (line: string) => void
      onEvent?: (event: AgentEvent, live: StepLive) => MaybePromise<void>
      inputQueue?: InputQueuePort
      signal?: AbortSignal
      askUser?: (issue: PreflightIssue) => Promise<string | null>
      /** Continue the unfinished turn at its next round (S50). `userText` is not used. */
      resume?: boolean
    },
  ): AsyncGenerator<string, TurnResult, undefined> {
    const pump = new TurnRenderPump(opts?.signal)
    this.runPorts.pump = pump
    const releaseTranscript = this.transcript.acquire(
      opts?.onTranscriptLine,
      (target) => (line) => pump.step(() => target(line)),
    )
    const onEvent = opts?.onEvent
    const unsubscribe = this.session.subscribe(
      (entry) => {
        if (entry.ch !== "event") return
        const event = entry.data
        if (event.type === "text_delta") pump.text(event.text)
        else if (event.type === "retry-boundary") pump.text(retryBoundaryText(event))
        else if (onEvent) pump.step((live) => onEvent(event, live))
        else if (event.type === "notice") {
          this.transcript.write(`\n  ${formatTurnNoticePlain(event.notice)}`)
        }
      },
      { channels: ["event"] },
    )
    this.runPorts.inputQueue = opts?.inputQueue ?? null
    this.runPorts.reflection = (round) =>
      this.reflectionCheckpoint.wait({
        round,
        cooldownMs: this.session.agentCore().getReflectionCooldownMs(),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      })
    let entries: ReturnType<Session["run"]> | undefined
    let finished: Promise<void> | undefined
    let settled = false
    try {
      entries = this.session.run(userText, {
        ...(opts?.signal ? { signal: opts.signal } : {}),
        ...(opts?.askUser ? { askUser: opts.askUser } : {}),
        ...(opts?.resume ? { resume: true } : {}),
      })
      // The entry stream ends when the turn ends, and throws on a run
      // failure. The pump gets the same entries through the subscription.
      const stream = entries
      finished = (async () => {
        for await (const _entry of stream) {
          // the subscription renders; this loop only waits for the end
        }
      })()
      finished.then(
        () => pump.close(),
        (error: unknown) => pump.close(error),
      )
      yield* pump.drain()
      settled = true
      const result = await entries.result
      // A permanent error paused the run (outcome `waiting`). This host shows
      // it the way it shows any failed turn; the session stays open and the
      // user's next prompt is the next run on the same history.
      if (result.outcome === "waiting") throw result.error
      return result
    } finally {
      if (!settled && entries) {
        // The consumer closed the generator before the turn settled (e.g. a
        // stale run abandoned for a fresh one). Abort it and wait for its
        // natural end so `session.run()` is never called again while this
        // run is still finishing in the background.
        pump.abandon()
        this.session.abort(new Error("InteractiveSession.run closed before the turn settled"))
        await finished?.catch(() => {
          // Already reported (or about to be, to nobody) via entries.result.
        })
      }
      unsubscribe()
      this.runPorts.inputQueue = null
      this.runPorts.reflection = null
      this.runPorts.pump = null
      releaseTranscript()
    }
  }
}
