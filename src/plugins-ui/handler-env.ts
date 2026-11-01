/**
 * Terminal entries for every plugin handler env (S31).
 *
 * Core adds no terminal data to a handler's `ctx.env`. Until S41 moves
 * plugin UI code into `ui/` folders, plugin handlers still format some
 * display text with the host palette. The CLI passes the palette and the
 * protocol version through `PluginLoaderOptions.handlerEnv`.
 *
 * @module plugins-ui/handler-env
 */

import { paletteEnvJson } from "../terminal-kit/palette.ts"

/** The terminal entries of a plugin handler env, read at each call. */
export function terminalHandlerEnv(): Record<string, string> {
  return { TUI_PLUGIN_PROTOCOL: "1", MINIMAL_AGENT_PALETTE: paletteEnvJson() }
}
