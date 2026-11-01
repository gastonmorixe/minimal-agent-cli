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
 * - {@link withHostPorts} fills both ports into session deps that do not
 *   set them. Every session the CLI opens goes through it.
 *
 * @module host/startup/host-ports
 */

import { GLOBAL_STATUS_BUS, type StatusBus } from "@minimal-agent/core/host/status-bus"
import type { BuildAgentCoreDeps } from "@minimal-agent/core/host-kit/build-agent-core"

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

/**
 * A status port that shows each engine activity as one row on `bus`.
 * `open` makes the row, `update` changes its label, `updateActivity`
 * patches its live byte and token numbers, and `clear` removes it.
 */
export function createStatusPort(bus: StatusBusLike = GLOBAL_STATUS_BUS): HostStatusPort {
  return {
    open(fields) {
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
 * Fill the CLI status port and plugin-event port into `deps` when they do
 * not set them. A port that `deps` already sets stays.
 *
 * @param deps - Session deps for `openSession` or `openAgentCoreSession`.
 * @param statusBus - The status bus for the rows. Defaults to the CLI one.
 */
export function withHostPorts<
  T extends {
    loader: PluginBusSource | null
    statusPort?: HostStatusPort
    pluginEvents?: HostPluginEventsPort
  },
>(
  deps: T,
  statusBus: StatusBusLike = GLOBAL_STATUS_BUS,
): T & { statusPort: HostStatusPort; pluginEvents: HostPluginEventsPort } {
  return {
    ...deps,
    statusPort: deps.statusPort ?? createStatusPort(statusBus),
    pluginEvents: deps.pluginEvents ?? createPluginEventsPort(deps.loader),
  }
}
