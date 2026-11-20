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
  type StatusBus,
  type StatusHandle,
} from "@minimal-agent/core/host/status-bus"
import type { BuildAgentCoreDeps } from "@minimal-agent/core/host-kit/build-agent-core"
import type { ToolEnvPort } from "@minimal-agent/core/sdk/ports"

import { TERMINAL_TOOL_ENV } from "../terminal/terminal-tool-env.ts"

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
   * Clear the rows of the tool calls that are still open. The host calls it
   * when a run ends: core clears each call in a `finally`, so a call that
   * is still open then is stale and would keep its row on the bus.
   */
  resetToolRows(): void
}

/** True when `port` is a {@link CliStatusPort} (it has `resetToolRows`). */
export function isCliStatusPort(port: HostStatusPort): port is CliStatusPort {
  return typeof (port as Partial<CliStatusPort>).resetToolRows === "function"
}

/**
 * A status port that shows each engine activity as one row on `bus`.
 * `open` makes the row, `update` changes its label, `updateActivity`
 * patches its live byte and token numbers, and `clear` removes it.
 *
 * A `running_tool` row is a plain row of one call (`Running Fetch`). The
 * REPL live area does not show it while a call runs: it shows the live tool
 * tree (`ui/status/tool-tree.ts`), which reads the open calls from the tool
 * call tracker. The row stays for hosts with no live tool tree (the line
 * renderer). The port keeps no group and no count of calls.
 */
export function createStatusPort(bus: StatusBusLike = GLOBAL_STATUS_BUS): CliStatusPort {
  const toolHandles = new Set<StatusHandle>()
  return {
    resetToolRows() {
      for (const handle of [...toolHandles]) handle.clear()
      toolHandles.clear()
    },
    open(fields) {
      const row = statusRowFor(fields)
      const handle = bus.create(row.label, {
        notificationId: row.notificationId,
        category: row.category,
      })
      const isTool = fields.phase === "running_tool"
      if (isTool) toolHandles.add(handle)
      return {
        update(next) {
          const nextRow = statusRowFor(next)
          handle.update(nextRow.label, {
            notificationId: nextRow.notificationId,
            category: nextRow.category,
          })
        },
        updateActivity: (activity) => handle.updateActivity(activity),
        clear() {
          if (isTool) toolHandles.delete(handle)
          handle.clear()
        },
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
