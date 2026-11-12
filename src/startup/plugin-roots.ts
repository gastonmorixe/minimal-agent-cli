/**
 * Plugin roots for the CLI (spec S40).
 *
 * Core takes plugin roots as data and knows no default location. The CLI
 * computes all of them here:
 *
 *   - embedded: the dev-time plugins checkout next to the CLI repo
 *     (`../minimal-agent-plugins`), or the dirs in
 *     `MINIMAL_AGENT_PLUGIN_SIBLINGS` (colon-separated). A compiled binary
 *     reads only the env list, never the implicit sibling probe. A compiled
 *     binary also carries every first-party plugin in its registered
 *     embedded table (`src/startup/embedded-plugins.ts`). Core appends that
 *     table after these disk roots, so it has the lowest precedence.
 *   - user: `<agent home>/plugins` (the first-run clone target). Install
 *     mode only.
 *   - project: `<cwd>/.agents/minimal-agent/plugins`.
 *
 * Two modes. Dev mode: a checkout dir holds at least one plugin package.
 * The checkout is then the only first-party copy: the user tier is empty
 * and the CLI does not clone. Install mode: no such checkout. The user
 * tier is the clone, and the CLI clones it on first run.
 *
 * There is no home tier. Our plugins use a private manifest format, so
 * they do not belong in the shared `$HOME/.agents/` folder.
 *
 * @module startup/plugin-roots
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

import type { PluginRoots } from "@minimal-agent/core/host-kit/plugin-loader"

/** The default remote of the first-party plugins (the first-run clone). */
export const DEFAULT_PLUGINS_REPO = "https://github.com/gastonmorixe/minimal-agent-plugins.git"

/** The dir name of the dev-time plugins checkout next to the CLI repo. */
export const PLUGINS_CHECKOUT_DIR = "minimal-agent-plugins"

/** The project plugin root, relative to the cwd. */
export const PROJECT_PLUGINS_SUBDIR = join(".agents", "minimal-agent", "plugins")

/** Old plugin roots that the CLI no longer reads, relative to cwd or HOME. */
const LEGACY_PLUGINS_SUBDIR = join(".agents", "plugins")

/** True when `p` is an existing directory. */
function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * True when `dir` holds at least one plugin package: a subdir with a
 * `manifest.json` (a manifest plugin) or a `provider.json` (a provider).
 * A subdir can be a symlink, so test the files, not the dirent type.
 */
function hasPluginPackage(dir: string): boolean {
  try {
    return readdirSync(dir).some(
      (name) =>
        existsSync(join(dir, name, "manifest.json")) ||
        existsSync(join(dir, name, "provider.json")),
    )
  } catch {
    return false
  }
}

/**
 * True when this code runs from a `bun build --compile` binary. The same
 * narrow cast as core's `isStandaloneExecutable()` (core does not export
 * it): the bun-types in use may not declare `Bun.isStandaloneExecutable`.
 */
export function isStandaloneExecutable(): boolean {
  return (Bun as { isStandaloneExecutable?: boolean }).isStandaloneExecutable === true
}

/**
 * The dev-time plugins checkouts: `MINIMAL_AGENT_PLUGIN_SIBLINGS`, else the
 * `minimal-agent-plugins` dir next to the CLI repo. Only existing dirs.
 *
 * A compiled binary has no CLI repo: its `cliRoot` is `/$bunfs`, so the
 * implicit probe would be `/minimal-agent-plugins` on the real disk, and a
 * host dir by that name would flip the binary into dev mode. So a
 * standalone binary skips the implicit probe and reads only the env list.
 *
 * @param cliRoot - The CLI install dir (`<repo>`, parent of `src/`).
 * @param env - The process env (`MINIMAL_AGENT_PLUGIN_SIBLINGS`).
 * @param standalone - True in a compiled binary. Default: {@link isStandaloneExecutable}.
 */
export function pluginCheckoutRoots(
  cliRoot: string,
  env: Record<string, string | undefined>,
  standalone: boolean = isStandaloneExecutable(),
): string[] {
  const fromEnv = env.MINIMAL_AGENT_PLUGIN_SIBLINGS
  if (!fromEnv && standalone) return []
  const candidates = fromEnv
    ? fromEnv.split(":").filter((p) => p.length > 0)
    : [join(dirname(cliRoot), PLUGINS_CHECKOUT_DIR)]
  return candidates.filter(isDir)
}

/** The plugin mode of this run. See the module doc. */
export interface PluginMode {
  /** `dev`: a checkout with packages exists. `install`: none. */
  readonly kind: "dev" | "install"
  /** The checkout dirs that hold packages. Empty in install mode. */
  readonly checkouts: readonly string[]
}

/**
 * Resolve the plugin mode: dev when a checkout dir holds a package.
 *
 * @param cliRoot - The CLI install dir (`<repo>`, parent of `src/`).
 * @param env - The process env (`MINIMAL_AGENT_PLUGIN_SIBLINGS`).
 * @param standalone - True in a compiled binary (see {@link pluginCheckoutRoots}).
 */
export function resolvePluginMode(
  cliRoot: string,
  env: Record<string, string | undefined>,
  standalone: boolean = isStandaloneExecutable(),
): PluginMode {
  const checkouts = pluginCheckoutRoots(cliRoot, env, standalone).filter(hasPluginPackage)
  return checkouts.length > 0 ? { kind: "dev", checkouts } : { kind: "install", checkouts: [] }
}

/**
 * Compute every plugin root of the CLI. See the module doc.
 *
 * @param cliRoot - The CLI install dir (`<repo>`, parent of `src/`).
 * @param env - The process env (`MINIMAL_AGENT_PLUGIN_SIBLINGS`).
 * @param cwd - The project dir.
 * @param agentHome - The agent home (`~/.minimal-agent`), or undefined when unknown.
 * @param mode - The plugin mode. Resolved from `cliRoot` and `env` when omitted.
 */
export function computePluginRoots(
  cliRoot: string,
  env: Record<string, string | undefined>,
  cwd: string,
  agentHome: string | undefined,
  mode: PluginMode = resolvePluginMode(cliRoot, env),
): PluginRoots {
  const user = mode.kind === "install" && agentHome ? [join(agentHome, "plugins")] : []
  return {
    embedded: [...mode.checkouts],
    user,
    project: [join(cwd, PROJECT_PLUGINS_SUBDIR)],
  }
}

/** The diagnostic sink that {@link reportPluginRoots} writes to. */
export interface PluginRootsDiag {
  /** File log only. */
  notice(source: string, message: string): void
  /** Scrollback and file log. */
  warn(source: string, message: string): void
}

/**
 * Report the plugin mode at startup. Dev mode: one notice (file log) with
 * the checkout dirs. Each old root that still holds packages: one warning
 * (scrollback and file log). Nothing is moved.
 */
export function reportPluginRoots(
  mode: PluginMode,
  env: Record<string, string | undefined>,
  cwd: string,
  diag: PluginRootsDiag,
): void {
  if (mode.kind === "dev") {
    diag.notice("plugin-sync", `dev mode: plugins from ${mode.checkouts.join(", ")}, no clone`)
  }
  const target = join(cwd, PROJECT_PLUGINS_SUBDIR)
  for (const legacy of legacyPluginRoots(env, cwd)) {
    diag.warn(
      "plugin-loader",
      `ignored legacy plugin root ${legacy}, move its plugins to ${target}`,
    )
  }
}

/**
 * Old plugin roots (`<cwd>/.agents/plugins`, `$HOME/.agents/plugins`) that
 * still hold packages. The CLI does not load them. It names them in a notice
 * so a user sees why those plugins are gone.
 */
export function legacyPluginRoots(env: Record<string, string | undefined>, cwd: string): string[] {
  const candidates = [join(cwd, LEGACY_PLUGINS_SUBDIR)]
  if (env.HOME) candidates.push(join(env.HOME, LEGACY_PLUGINS_SUBDIR))
  return [...new Set(candidates)].filter(hasPluginPackage)
}
