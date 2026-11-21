/**
 * Session deps for `HostRuntime.resumeSession` (host mode): reopen a saved
 * session under its OWN id, so an ACP client that kept the id from
 * `session/new` (`session/resume`) gets the same conversation back in a new
 * process.
 *
 * The resume is in place, like `--resume-same-sid`: the session file
 * `<sid>.jsonl` is opened with `existsOk` and new records are appended to
 * it. There is no fork, because the client keys its thread on this id.
 *
 * The boot opened a store for the fresh process id. That store gets no
 * conversation, so its exit hook (`cleanupIfUnused`) removes it.
 *
 * Known limit: plugin sidecars keyed on the process id (for example
 * `<sid>.tasks.jsonl`) keep the process id. Only the conversation, its blobs
 * and its file observations move to the resumed id.
 *
 * @module host/startup/host-resume
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

import type { RoundCheckpoint } from "@minimal-agent/core"
import { AGENT_VERSION } from "@minimal-agent/core/host/build-info"
import { lastTurnRoundCheckpoint, loadSession } from "@minimal-agent/core/host/session-restore"
import { NO_SIDEBAND, sidebandOf } from "@minimal-agent/core/host/sideband"
import { BlobStore, loadBlobStoreConfig } from "@minimal-agent/core/host-kit/blob-store"
import type { BuildAgentCoreDeps } from "@minimal-agent/core/host-kit/build-agent-core"
import { FileTrackingStore } from "@minimal-agent/core/host-kit/file-tracking-store"
import { lastAdvertisedModeFromHistory } from "@minimal-agent/core/host-kit/modes"
import {
  defaultSessionsDir,
  SessionStore,
  sessionFilePath,
} from "@minimal-agent/core/host-kit/session-store"

import { recordedAgentVersion } from "../cli/build-info.ts"

/** The `code` of the Error that {@link prepareHostResume} throws for an unknown id. */
export const SESSION_NOT_FOUND = "session.not-found"

/** The same UUID shape check as `setSessionId` (`--session-id`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The deps change for one resumed session, from {@link prepareHostResume}. */
export interface HostResume {
  /** The boot deps with the resumed store, blob store, file tracker and history. */
  readonly deps: BuildAgentCoreDeps
  /** Messages in the resumed model history. */
  readonly messageCount: number
}

/** An Error with a `code`, so a host-mode entry can map it to a protocol error. */
function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

/**
 * Read the saved session `sid` and build the deps that reopen it in place.
 *
 * @param sid - the session id the client sends back. Must be UUID-shaped.
 * @param base - the boot session deps.
 * @param dir - the sessions directory. Defaults to the configured one.
 * @returns the deps for `openAgentCoreSession`, with `sessionId` not set.
 * @throws Error with `code` {@link SESSION_NOT_FOUND} when the id is not a
 *   UUID or no session file has it. Other read errors throw unchanged.
 */
export function prepareHostResume(
  sid: string,
  base: BuildAgentCoreDeps,
  dir: string = defaultSessionsDir(),
): HostResume {
  if (!UUID_RE.test(sid) || !existsSync(sessionFilePath(sid, dir))) {
    throw codedError(SESSION_NOT_FOUND, `no saved session ${JSON.stringify(sid)} to resume`)
  }
  // The sideband reader of the boot loader: it finds the runtime attachment
  // blocks and the mode-change tags in the saved history.
  const loader = base.loader
  const sideband =
    loader && typeof loader.sideband === "function" ? sidebandOf(loader) : NO_SIDEBAND
  const loaded = loadSession(sid, dir, { sideband })
  const checkpoint: RoundCheckpoint | null = lastTurnRoundCheckpoint(loaded.records)
  const store = SessionStore.open({
    sid,
    dir,
    model: base.model,
    cwd: process.cwd(),
    // `existsOk` keeps the saved meta record, so these are not written.
    systemHash: "",
    toolsHash: "",
    agentVersion: recordedAgentVersion(AGENT_VERSION),
    argv: process.argv,
    ...(base.providerId ? { provider: base.providerId } : {}),
    ...(base.credentialName ? { credentialName: base.credentialName } : {}),
    existsOk: true,
  })
  store.setSideband(sideband)
  try {
    store.appendAttach()
  } catch {
    // best-effort, like the boot store
  }
  let blobStore: BlobStore | null = null
  try {
    const { config } = loadBlobStoreConfig()
    if (config.enabled) blobStore = new BlobStore({ sid, config, dir: join(dir, `${sid}.blobs`) })
  } catch {
    blobStore = null
  }
  let fileTrackingStore: FileTrackingStore | null = null
  try {
    fileTrackingStore = new FileTrackingStore({ sid, dir, cwd: process.cwd() })
  } catch {
    fileTrackingStore = null
  }
  // The model already saw the modes in its history: do not announce them again.
  base.modeManager?.primeLastAdvertised(lastAdvertisedModeFromHistory(loaded.messages, sideband))
  return {
    deps: {
      ...base,
      store,
      blobStore,
      fileTrackingStore,
      initialMessages: loaded.messages,
      // A cut-off turn: core closes its open tool calls before the next request.
      ...(checkpoint ? { initialCheckpoint: checkpoint } : {}),
    },
    messageCount: loaded.messages.length,
  }
}
