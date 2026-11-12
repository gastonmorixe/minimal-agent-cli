#!/usr/bin/env bun
/**
 * Prune old nightly releases and their tags on this repo.
 *
 * ```sh
 * bun run scripts/release/prune-nightlies.ts --repo OWNER/NAME [--keep 7] \
 *   [--current TAG] [--dry-run]
 * ```
 *
 * Keeps the newest `--keep` published nightlies (by the UTC stamp in the
 * tag, `v<version>-nightly.<YYYYMMDDTHHMMSSZ>`, so a version bump does not
 * reorder them). Deletes every older nightly release with its tag, every
 * nightly draft (a failed publish) except `--current`, and every nightly
 * tag that has no release left. Stable releases and any tag that does not
 * match the nightly pattern are never touched.
 *
 * Talks to GitHub through the `gh` CLI (`GH_TOKEN` needs contents: write).
 * {@link planPrune} is pure and holds every decision, so a test covers it.
 *
 * @module scripts/release/prune-nightlies
 */

import { fail, parseFlags, required, run, runMain } from "./lib.ts"

/** A nightly tag: `v0.1.0-nightly.20261112T190000Z`. Group 1 is the stamp. */
export const NIGHTLY_TAG_RE = /^v\d+\.\d+\.\d+-nightly\.(\d{8}T\d{6}Z)$/

/** The fields of one release this script reads (`gh release list --json`). */
export interface ReleaseRef {
  readonly tagName: string
  readonly isDraft: boolean
}

/** What to delete. */
export interface PrunePlan {
  /** Published nightlies kept, newest first. */
  readonly keep: string[]
  /** Releases to delete together with their tag. */
  readonly deleteReleases: string[]
  /** Tags with no release to delete. */
  readonly deleteTags: string[]
}

/** The stamp of a nightly tag, or undefined for any other tag. */
function stamp(tag: string): string | undefined {
  return NIGHTLY_TAG_RE.exec(tag)?.[1]
}

/** Newest stamp first. Stamps are fixed-width UTC, so string order is time order. */
function byStampDesc(a: string, b: string): number {
  return (stamp(b) ?? "").localeCompare(stamp(a) ?? "")
}

/**
 * Decide which nightly releases and tags to delete.
 *
 * @param releases - every release of the repo (any channel, drafts included)
 * @param tags - every tag name of the repo
 * @param keep - how many published nightlies to keep
 * @param current - the tag this run published: never deleted
 * @returns the plan
 */
export function planPrune(
  releases: readonly ReleaseRef[],
  tags: readonly string[],
  keep: number,
  current?: string,
): PrunePlan {
  const nightly = releases.filter((r) => stamp(r.tagName) !== undefined)
  const published = nightly
    .filter((r) => !r.isDraft)
    .map((r) => r.tagName)
    .sort(byStampDesc)
  const kept = new Set(published.slice(0, Math.max(0, keep)))
  if (current !== undefined && stamp(current) !== undefined) kept.add(current)
  const deleteReleases = nightly
    .map((r) => r.tagName)
    .filter((tag) => !kept.has(tag))
    .sort(byStampDesc)
  const withRelease = new Set(nightly.map((r) => r.tagName))
  const deleteTags = tags
    .filter((tag) => stamp(tag) !== undefined && !kept.has(tag) && !withRelease.has(tag))
    .sort(byStampDesc)
  return {
    keep: [...kept].sort(byStampDesc),
    deleteReleases: [...new Set(deleteReleases)],
    deleteTags,
  }
}

/** Every release of `repo`, drafts included. */
function listReleases(repo: string): ReleaseRef[] {
  const out = run([
    "gh",
    "release",
    "list",
    "--repo",
    repo,
    "--limit",
    "1000",
    "--json",
    "tagName,isDraft",
  ])
  return JSON.parse(out) as ReleaseRef[]
}

/** Every tag name of `repo` under `refs/tags/v`. */
function listTags(repo: string): string[] {
  const out = run([
    "gh",
    "api",
    "--paginate",
    `repos/${repo}/git/matching-refs/tags/v`,
    "--jq",
    '.[].ref | ltrimstr("refs/tags/")',
  ])
  return out.split("\n").filter((line) => line !== "")
}

/** Entry point. */
function main(): void {
  const flags = parseFlags(process.argv.slice(2), ["repo", "keep", "current"], ["dry-run"])
  const repo = required(flags, "repo")
  const keep = Number(flags.keep ?? "7")
  if (!Number.isInteger(keep) || keep < 1) fail(`--keep ${flags.keep}: a positive integer`)
  const dry = flags["dry-run"] === "true"
  const plan = planPrune(listReleases(repo), listTags(repo), keep, flags.current)
  console.log(`prune: keeping ${plan.keep.length} nightlies: ${plan.keep.join(", ") || "none"}`)
  for (const tag of plan.deleteReleases) {
    console.log(`prune: ${dry ? "would delete" : "deleting"} release + tag ${tag}`)
    if (!dry) run(["gh", "release", "delete", tag, "--repo", repo, "--cleanup-tag", "--yes"])
  }
  for (const tag of plan.deleteTags) {
    console.log(`prune: ${dry ? "would delete" : "deleting"} orphan tag ${tag}`)
    if (!dry) run(["gh", "api", "--method", "DELETE", `repos/${repo}/git/refs/tags/${tag}`])
  }
  console.log(
    `prune: ${plan.deleteReleases.length} release(s), ${plan.deleteTags.length} orphan tag(s)${dry ? " (dry run)" : ""}`,
  )
}

if (import.meta.main) await runMain("prune", main)
