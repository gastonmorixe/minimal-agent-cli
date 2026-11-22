/**
 * The process paste chain of the CLI (paste plugin v3, D1; B-3 order).
 *
 * `main.ts` makes it BEFORE `loadPluginUi`, so the ui-loader (D3) can give
 * plugins the registry and the lazy sid getter. The sid is not known then:
 * `main.ts` fills it with {@link CliPasteChain.bindSid} where
 * `bootSessionStores` opens the session. `live-repl.ts` registers the media
 * hook and gives the registry to the editor.
 *
 * @module paste/paste-chain
 */

import { ChipRegistry } from "./chip-registry.ts"
import { PasteHookRegistry } from "./paste-hooks.ts"

/** The paste registry and the lazy session id getter of one CLI process. */
export interface CliPasteChain {
  /** The paste hook chain. The editor runs it; plugins register on it (D3). */
  readonly hooks: PasteHookRegistry
  /**
   * The chip registry (D2). The editor, the scrollback and the replay show
   * each inline sideband node with it; plugins register labels on it (D3).
   */
  readonly chips: ChipRegistry
  /** The lazy sid getter: `undefined` until {@link bindSid}. */
  readonly sid: () => string | undefined
  /**
   * Fill the sid getter with the active session. `live` (optional) is read at
   * each paste; else the getter gives `sid`. Returns `sid`.
   */
  bindSid(sid: string, live?: () => string | undefined): string
}

/** Make a paste chain with an empty sid getter. */
export function createPasteChain(): CliPasteChain {
  let source: () => string | undefined = () => undefined
  const sid = () => source()
  return {
    hooks: new PasteHookRegistry({ sid }),
    chips: new ChipRegistry(),
    sid,
    bindSid(value, live) {
      source = live ?? (() => value)
      return value
    },
  }
}

let processChain: CliPasteChain | null = null

/** The paste chain of this process (made on the first call). */
export function cliPasteChain(): CliPasteChain {
  processChain ??= createPasteChain()
  return processChain
}
