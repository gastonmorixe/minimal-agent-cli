/**
 * Human-readable text for the `--dump <sid> --paths` artifact inventory.
 *
 * Core owns the data (`inspectSessionArtifacts` in
 * `@minimal-agent/core/host/session-artifacts`). The CLI owns this terminal
 * text.
 *
 * @module commands/session-artifacts-format
 */

import type { SessionArtifactsManifest } from "@minimal-agent/core/host/session-artifacts"

/** Format the manifest for human-readable CLI output. */
export function formatSessionArtifacts(manifest: SessionArtifactsManifest): string {
  const lines = [`Session artifacts for ${manifest.sid}`]
  for (const artifact of manifest.artifacts) {
    const label = artifact.kind === "network" ? "network" : artifact.kind
    lines.push(`  ${label.padEnd(10)} ${artifact.status.padEnd(11)} ${artifact.path}`)
  }
  return `${lines.join("\n")}\n`
}
