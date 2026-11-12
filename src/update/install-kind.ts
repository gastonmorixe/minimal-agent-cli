/**
 * How this minimal-agent was installed, for `minimal-agent update`.
 *
 * - `source`: a run from a checkout (`bun run src/index.ts`, build-info mode
 *   `source`), or anything that is not a Bun standalone executable. Update
 *   is `git pull` in the monorepo.
 * - `brew`: the binary sits in a Homebrew Cellar. Update is `brew upgrade`.
 * - `standalone`: a compiled binary at `process.execPath`, which `update`
 *   replaces in place.
 *
 * Pure.
 *
 * @module update/install-kind
 */

/** The install kind. */
export type InstallKind = "source" | "brew" | "standalone"

/** What {@link detectInstallKind} reads. */
export interface InstallFacts {
  /** build-info `mode`. */
  readonly mode: "dev" | "release" | "source"
  /** `Bun.isStandaloneExecutable`. */
  readonly standalone: boolean
  /** The real path of the running binary (`process.execPath`, symlinks resolved). */
  readonly execPath: string
}

/** True when `path` has a `Cellar` directory segment (`/opt/homebrew/Cellar/...`). */
export function isBrewCellarPath(path: string): boolean {
  return /(?:^|\/)Cellar\//u.test(path)
}

/** Classify the running install. */
export function detectInstallKind(facts: InstallFacts): InstallKind {
  if (facts.mode === "source" || !facts.standalone) return "source"
  if (isBrewCellarPath(facts.execPath)) return "brew"
  return "standalone"
}

/** The message for an install that `update` does not replace. */
export function installKindMessage(kind: Exclude<InstallKind, "standalone">): string {
  return kind === "source"
    ? "running from source: git pull in the monorepo (then bun install), nothing to update here"
    : "installed by Homebrew: use brew upgrade minimal-agent"
}
