/**
 * The CLI host ports for status and plugin-event telemetry (spec S23, S28).
 *
 * Core never reads a global status bus or a global plugin bus. A host must
 * give each session a `statusPort` and a `pluginEvents` port. With no port,
 * the engine is silent: no "Sending request" or "Retrying" status rows, and
 * no `llm.outputDelta` / `llm.outputEnd` events for plugins such as
 * `ma-tps-plugin`.
 *
 * This module builds both ports for the terminal host:
 * - {@link createStatusPort} maps each engine phase code to a status-row
 *   label on the CLI status bus.
 * - {@link createPluginEventsPort} forwards each event to the plugin
 *   loader's event bus.
 * - {@link withHostPorts} fills both ports, and the terminal `toolEnv`
 *   port (spec S24), into session deps that do not set them. Every session
 *   the CLI opens goes through it.
 *
 * @module host/startup/host-ports
 */

import {
  GLOBAL_STATUS_BUS,
  type StatusActivity,
  type StatusBus,
  type StatusHandle,
} from "@minimal-agent/core/host/status-bus"
import type { BuildAgentCoreDeps } from "@minimal-agent/core/host-kit/build-agent-core"
import type { ToolEnvPort } from "@minimal-agent/core/sdk/ports"

import { TERMINAL_TOOL_ENV } from "../terminal/terminal-tool-env.ts"
import { TOOL_GROUP_NOTIFICATION_ID, TOOL_PINNED_CATEGORY } from "../ui/status/format.ts"

/** The engine's live status port, as the session deps declare it. */
export type HostStatusPort = NonNullable<BuildAgentCoreDeps["statusPort"]>

/** The fields of one engine status: a phase code plus numbers, no label. */
export type HostStatusFields = Parameters<HostStatusPort["open"]>[0]

/** The engine's plugin-event port, as the session deps declare it. */
export type HostPluginEventsPort = NonNullable<BuildAgentCoreDeps["pluginEvents"]>

/** The part of the status bus the status port writes to. */
export type StatusBusLike = Pick<StatusBus, "create">

/** The part of a plugin loader the plugin-event port reads. */
interface PluginBusSource {
  bus?: () => { emit(event: string, payload?: unknown): void }
}

/** One status row: its label and the notification metadata the bus keeps. */
export interface StatusRow {
  label: string
  notificationId: string
  category: string
}

function seconds(ms: number | undefined): string {
  return ((ms ?? 0) / 1000).toFixed(1)
}

/**
 * The status row for one engine phase. The labels are the same text the
 * engine wrote to the status bus before spec S23.
 */
export function statusRowFor(fields: HostStatusFields): StatusRow {
  const cause = fields.cause ?? "error"
  const attempt = fields.attempt ?? "?"
  switch (fields.phase) {
    case "sending":
      return { label: "Sending request", notificationId: "network.request", category: "network" }
    case "receiving":
      return { label: "Receiving stream", notificationId: "network.request", category: "network" }
    case "running_tool":
      return {
        label: `Running ${fields.toolName ?? "tool"}`,
        // The spinner picks its tool icon by this id.
        notificationId: "tool.running",
        category: "tool",
      }
    case "retrying":
      return {
        label: `Retrying after ${cause} (attempt ${attempt}) — sleeping ${seconds(fields.nextDelayMs)}s…`,
        notificationId: "network.retry",
        category: "network",
      }
    case "waiting_for_quota":
      return {
        label: `Waiting for quota reset after ${cause} (attempt ${attempt}) — sleeping ${seconds(fields.nextDelayMs)}s…`,
        notificationId: "network.retry",
        category: "network",
      }
    case "waiting_for_host":
      // Kept for exhaustiveness and for hosts that drive a port from SDK
      // `status` events. Core itself only EMITS this phase as an event
      // (agent-core run end, outcome `waiting`) and never opens it on the
      // port: the run is over, the REPL shows the error, and a live row
      // would have nothing to spin for.
      return {
        label: `Paused after ${cause} — waiting for the next prompt`,
        notificationId: "network.retry",
        category: "network",
      }
    default: {
      const exhaustive: never = fields.phase
      return exhaustive
    }
  }
}

/** The CLI status port: the host port, plus the run-end reset of the tool rows. */
export interface CliStatusPort extends HostStatusPort {
  /**
   * Forget the open tool calls and clear their row. The host calls it
   * when a run ends: core clears each call in a `finally`, so a call that
   * is still open then is stale. Without the reset, a stale call would
   * make every later call show as a group with the old timer.
   */
  resetToolRows(): void
}

/** True when `port` is a {@link CliStatusPort} (it has `resetToolRows`). */
export function isCliStatusPort(port: HostStatusPort): port is CliStatusPort {
  return typeof (port as Partial<CliStatusPort>).resetToolRows === "function"
}

/** Options of {@link createStatusPort}. */
export interface StatusPortOptions {
  /** The clock for the start time of each tool call. Default: `Date.now`. */
  now?: () => number
}

/** One open `running_tool` handle of the port. */
interface OpenToolCall {
  toolName: string
  openedAt: number
  /** The live numbers core gave this call, merged. */
  activity: StatusActivity
}

/**
 * The label of the tool group row (D11, decision A): the count of open
 * calls, then each tool name with its count, in the order the tools
 * first started. Example: `Running 9 tools · Fetch ×7 · Read ×2`.
 */
export function toolGroupLabel(toolNames: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const name of toolNames) counts.set(name, (counts.get(name) ?? 0) + 1)
  const parts = [...counts].map(([name, count]) => `${name} ×${count}`)
  return `Running ${toolNames.length} tools · ${parts.join(" · ")}`
}

/**
 * The `running_tool` rows of one status port (D11, decision A).
 *
 * - One open call: the row is the same as before (`Running Fetch`).
 * - Two or more open calls (a wave): ONE row, `Running N tools · Fetch ×7`.
 *   It counts from the oldest call that still runs. The row uses the
 *   `tool.group` notification id, so the status renderer reads that start
 *   time from `activity.startedAt` (see `pinnedEntryStart`).
 * - The count goes back to 1: the row shows that call, `Running Read`,
 *   with the time since that call started. The notification id is
 *   `tool.running` again, as today; the category `tool.pinned` keeps the
 *   start time of that call (see `pinnedEntryStart`).
 *
 * The first call's bus entry carries the row until no call is open.
 * `reset` forgets all open calls (the run ended), so a call that core never
 * cleared cannot make a later call join a stale group.
 */
function createToolRows(
  bus: StatusBusLike,
  now: () => number,
): {
  open: (fields: HostStatusFields) => ReturnType<HostStatusPort["open"]>
  reset: () => void
} {
  let open: OpenToolCall[] = []
  let entry: StatusHandle | null = null
  /** True after the entry first showed a group of 2 or more. */
  let grouped = false
  /** Counts the resets. A handle from an older generation does nothing. */
  let generation = 0

  const relabel = (): void => {
    if (!entry || !grouped) return
    const oldest = open[0]
    if (!oldest) return
    if (open.length >= 2) {
      entry.update(toolGroupLabel(open.map((call) => call.toolName)), {
        notificationId: TOOL_GROUP_NOTIFICATION_ID,
        category: "tool",
        activity: { direction: "idle", startedAt: oldest.openedAt },
      })
      return
    }
    const row = statusRowFor({ phase: "running_tool", toolName: oldest.toolName })
    entry.update(row.label, {
      notificationId: row.notificationId,
      category: TOOL_PINNED_CATEGORY,
      activity: { ...oldest.activity, startedAt: oldest.openedAt },
    })
  }

  const reset = (): void => {
    generation++
    entry?.clear()
    entry = null
    open = []
    grouped = false
  }

  const openRow = (fields: HostStatusFields): ReturnType<HostStatusPort["open"]> => {
    const born = generation
    const call: OpenToolCall = {
      toolName: fields.toolName ?? "tool",
      openedAt: now(),
      activity: {},
    }
    if (entry) {
      open.push(call)
      grouped = true
      relabel()
    } else {
      // One call: the same row as every other phase.
      const row = statusRowFor(fields)
      entry = bus.create(row.label, { notificationId: row.notificationId, category: row.category })
      open = [call]
    }
    const carrier = entry
    /** False after a reset: the handle belongs to a run that ended. */
    const live = (): boolean => born === generation
    return {
      update(next) {
        if (!live()) return
        if (next.phase === "running_tool") call.toolName = next.toolName ?? "tool"
        if (grouped) {
          relabel()
          return
        }
        const nextRow = statusRowFor(next)
        carrier.update(nextRow.label, {
          notificationId: nextRow.notificationId,
          category: nextRow.category,
        })
      },
      updateActivity(activity) {
        if (!live()) return
        call.activity = { ...call.activity, ...activity }
        // A group row shows no numbers of one call.
        if (!grouped || (open.length === 1 && open[0] === call)) carrier.updateActivity(activity)
      },
      clear() {
        if (!live() || !open.includes(call)) return
        open = open.filter((item) => item !== call)
        if (open.length > 0) {
          relabel()
          return
        }
        carrier.clear()
        entry = null
        grouped = false
      },
    }
  }

  return { open: openRow, reset }
}

/**
 * A status port that shows each engine activity as one row on `bus`.
 * `open` makes the row, `update` changes its label, `updateActivity`
 * patches its live byte and token numbers, and `clear` removes it.
 * Tool calls that run at the same time share one row (see
 * {@link toolGroupLabel}).
 */
export function createStatusPort(
  bus: StatusBusLike = GLOBAL_STATUS_BUS,
  opts: StatusPortOptions = {},
): CliStatusPort {
  const toolRows = createToolRows(bus, opts.now ?? Date.now)
  return {
    resetToolRows: toolRows.reset,
    open(fields) {
      if (fields.phase === "running_tool") return toolRows.open(fields)
      const row = statusRowFor(fields)
      const handle = bus.create(row.label, {
        notificationId: row.notificationId,
        category: row.category,
      })
      return {
        update(next) {
          const nextRow = statusRowFor(next)
          handle.update(nextRow.label, {
            notificationId: nextRow.notificationId,
            category: nextRow.category,
          })
        },
        updateActivity: (activity) => handle.updateActivity(activity),
        clear: () => handle.clear(),
      }
    },
  }
}

/**
 * A plugin-event port that forwards each event to the loader's event bus.
 * With no loader (or a loader with no bus), the port sends nothing.
 */
export function createPluginEventsPort(
  loader: PluginBusSource | null | undefined,
): HostPluginEventsPort {
  const bus = loader && typeof loader.bus === "function" ? loader.bus() : null
  if (!bus) return { emit: () => {} }
  return { emit: (event, payload) => bus.emit(event, payload) }
}

/**
 * Fill the CLI status port, plugin-event port, and terminal `toolEnv` port
 * into `deps` when they do not set them. A port that `deps` already sets
 * stays. Core reads no terminal size, so the CLI gives Bash its own (S24).
 *
 * @param deps - Session deps for `openSession` or `openAgentCoreSession`.
 * @param statusBus - The status bus for the rows. Defaults to the CLI one.
 */
export function withHostPorts<
  T extends {
    loader: PluginBusSource | null
    statusPort?: HostStatusPort
    pluginEvents?: HostPluginEventsPort
    toolEnv?: ToolEnvPort
  },
>(
  deps: T,
  statusBus: StatusBusLike = GLOBAL_STATUS_BUS,
): T & { statusPort: HostStatusPort; pluginEvents: HostPluginEventsPort; toolEnv: ToolEnvPort } {
  return {
    ...deps,
    statusPort: deps.statusPort ?? createStatusPort(statusBus),
    pluginEvents: deps.pluginEvents ?? createPluginEventsPort(deps.loader),
    toolEnv: deps.toolEnv ?? TERMINAL_TOOL_ENV,
  }
}
