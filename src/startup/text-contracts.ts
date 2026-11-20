/**
 * The text contract check the CLI asks of the plugin loader.
 *
 * Core holds no model-facing text. So the boot refuses to start
 * (`ContractCheckFailedError`) when a text contract has no provider plugin,
 * or has two in one tier. The CLI renders that error in `core-text.ts`.
 *
 * @module startup/text-contracts
 */

import { TEXT_CONTRACTS } from "@minimal-agent/core/host-kit/plugin-loader"
import { hostCountdown } from "../host-countdown.ts"

/** Spread into the `PluginLoader.load` options of the CLI. */
export const CLI_TEXT_CONTRACT_CHECK = {
  requiredContracts: TEXT_CONTRACTS,
  contractCheckMode: "fail",
} as const

/**
 * The plugin roots and core tool names of the CLI loader, plus the text
 * contract check and the host countdown of hook handlers (`ctx.countdown`:
 * a status row that Esc skips, see `src/host-countdown.ts`). One spread in
 * `main.ts`, so the loader options stay short.
 *
 * @param roots - The plugin roots of the CLI (S40).
 * @param coreToolNames - The built-in tool names, which always win.
 * @returns The loader options to spread.
 */
export function cliLoaderBase<R, N>(roots: R, coreToolNames: N) {
  return { roots, coreToolNames, ...CLI_TEXT_CONTRACT_CHECK, countdown: hostCountdown }
}

/** The loader methods that show whether a plugin supplies model-facing text. */
interface TextLoader {
  syntheticTextProviders(): readonly unknown[]
  toolTextProviders(): readonly unknown[]
}

/**
 * True when a plugin supplies synthetic or tool text. Core holds no text, so
 * a loader with only text plugins must still reach the session: else the
 * model gets empty tool results, notices and tool descriptions.
 *
 * @param loader - The CLI plugin loader.
 * @returns Whether any text provider is loaded.
 */
export function hasTextPlugins(loader: TextLoader): boolean {
  return loader.syntheticTextProviders().length > 0 || loader.toolTextProviders().length > 0
}

/**
 * The CLI `hasPlugins` flag: anything plugin-shaped that the session needs.
 *
 * @param loader - The CLI plugin loader.
 * @param tools - The loaded plugin tools.
 * @param modes - The loaded plugin modes.
 * @param promptBlock - True when a plugin gives a prompt block.
 * @param dryRun - True with `--dry-run` (its hook-only plugin adds nothing else).
 * @returns Whether the session gets the loader.
 */
export function cliHasPlugins(
  loader: TextLoader,
  tools: readonly unknown[],
  modes: readonly unknown[],
  promptBlock: boolean,
  dryRun: boolean,
): boolean {
  return tools.length > 0 || modes.length > 0 || promptBlock || dryRun || hasTextPlugins(loader)
}
