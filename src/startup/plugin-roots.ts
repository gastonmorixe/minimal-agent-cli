/**
 * Plugin roots for the CLI (spec S40).
 *
 * Core takes plugin roots as data and knows no default location. The CLI
 * computes all of them here:
 *
 *   - embedded: `<cli>/plugins`, then the dev-time plugins checkout next to
 *     the CLI repo (`../minimal-agent-plugins`), or the dirs in
 *     `MINIMAL_AGENT_PLUGIN_SIBLINGS` (colon-separated). A checkout dir is
 *     used only when it exists.
 *   - user: `<agent home>/plugins` (the first-run clone target).
 *   - home: `$HOME/.agents/plugins`.
 *   - project: `<cwd>/.agents/plugins`.
 *
 * @module startup/plugin-roots
 */

import { existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

import type { PluginRoots } from "@minimal-agent/core/host-kit/plugin-loader"

/** The default remote of the first-party plugins (the first-run clone). */
export const DEFAULT_PLUGINS_REPO = "https://github.com/gastonmorixe/minimal-agent-plugins.git"

/** The dir name of the dev-time plugins checkout next to the CLI repo. */
export const PLUGINS_CHECKOUT_DIR = "minimal-agent-plugins"

/** True when `p` is an existing directory. */
function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * The dev-time plugins checkouts: `MINIMAL_AGENT_PLUGIN_SIBLINGS`, else the
 * `minimal-agent-plugins` dir next to the CLI repo. Only existing dirs.
 */
export function pluginCheckoutRoots(
  cliRoot: string,
  env: Record<string, string | undefined>,
): string[] {
  const fromEnv = env.MINIMAL_AGENT_PLUGIN_SIBLINGS
  const candidates = fromEnv
    ? fromEnv.split(":").filter((p) => p.length > 0)
    : [join(dirname(cliRoot), PLUGINS_CHECKOUT_DIR)]
  return candidates.filter(isDir)
}

/**
 * Compute every plugin root of the CLI. See the module doc.
 *
 * @param cliRoot - The CLI install dir (`<repo>`, parent of `src/`).
 * @param env - The process env (`HOME`, `MINIMAL_AGENT_PLUGIN_SIBLINGS`).
 * @param cwd - The project dir.
 * @param agentHome - The agent home (`~/.minimal-agent`), or undefined when unknown.
 */
export function computePluginRoots(
  cliRoot: string,
  env: Record<string, string | undefined>,
  cwd: string,
  agentHome: string | undefined,
): PluginRoots {
  const userHome = env.HOME
  return {
    embedded: [join(cliRoot, "plugins"), ...pluginCheckoutRoots(cliRoot, env)],
    user: agentHome ? [join(agentHome, "plugins")] : [],
    home: userHome ? [join(userHome, ".agents", "plugins")] : [],
    project: [join(cwd, ".agents", "plugins")],
  }
}
