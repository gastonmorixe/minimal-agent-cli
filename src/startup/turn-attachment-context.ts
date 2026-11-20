/**
 * The sideband wiring of the CLI session (design step 13). The context that
 * the CLI gives to each plugin turn-attachment factory
 * (`instantiateTurnAttachments`) has the session id, the loader bus, and the
 * loader's one sideband API. Thus a factory renders its tags with the same
 * API object as `loader.sideband()`. `sidebandOf` is re-exported, so
 * `main.ts` imports the sideband wiring from one module.
 *
 * @module startup/turn-attachment-context
 */

import { sidebandOf } from "@minimal-agent/core/host/sideband"
import {
  instantiateTurnAttachments,
  type TurnAttachmentContext,
} from "@minimal-agent/core/host/turn-attachments"
import type { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"

export { sidebandOf }

/** The turn-attachment context of one session. */
export function turnAttachmentContextOf(
  loader: Pick<PluginLoader, "bus" | "sideband">,
  sessionId: string | null,
): TurnAttachmentContext {
  return { sessionId, bus: loader.bus(), sideband: sidebandOf(loader) }
}

/** Build the plugin turn attachments of one session, with {@link turnAttachmentContextOf}. */
export function instantiateSessionTurnAttachments(
  loader: Pick<PluginLoader, "bus" | "sideband">,
  sessionId: string | null,
  logger: (msg: string) => void,
): ReturnType<typeof instantiateTurnAttachments> {
  return instantiateTurnAttachments(turnAttachmentContextOf(loader, sessionId), logger)
}
