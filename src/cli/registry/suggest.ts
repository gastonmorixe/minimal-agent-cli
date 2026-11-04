/**
 * "Did you mean" suggestions for an unknown help path (SPEC-HELP R-17,
 * plan M-9a, 4.1 step 6).
 *
 * Pure: no env, no fs, no console. The distance is the Levenshtein edit
 * distance: the least number of single-character insertions, deletions, and
 * substitutions that change one string into the other
 * (https://en.wikipedia.org/wiki/Levenshtein_distance). cobra uses the same
 * distance with a limit of 2 for its "unknown command" suggestions
 * (https://github.com/spf13/cobra/blob/main/site/content/user_guide.md).
 *
 * @module cli/registry/suggest
 */

import type { CommandSpec } from "@minimal-agent/core/plugin-api/types/cli-contract"

/** Default max edit distance for a suggestion (plan 4.1 step 6). */
export const SUGGEST_MAX_DISTANCE = 2

/** Default max number of suggestions (R-17). */
export const SUGGEST_LIMIT = 3

/** Options for {@link suggest}. */
export interface SuggestOptions {
  /** Keep a candidate only when its distance is at most this. Default {@link SUGGEST_MAX_DISTANCE}. */
  readonly maxDistance?: number
  /** Max number of results. Default {@link SUGGEST_LIMIT}. */
  readonly limit?: number
}

/**
 * Levenshtein edit distance of `a` and `b`. Case-sensitive. Counts UTF-16
 * code units, which is enough for command names (`/^[a-z0-9][a-z0-9-]*$/`).
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  // One row of the classic dynamic-programming table.
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row.push(
        Math.min(
          (prev[j] ?? 0) + 1, // deletion
          (row[j - 1] ?? 0) + 1, // insertion
          (prev[j - 1] ?? 0) + cost, // substitution
        ),
      )
    }
    prev = row
  }
  return prev[b.length] ?? 0
}

/**
 * The candidates closest to `token`: distance at most `maxDistance`, at most
 * `limit` items, sorted by distance and then by name (code unit order).
 * Duplicate candidates count once. The token is compared in lower case, so
 * `Sessions` suggests `sessions`.
 */
export function suggest(
  token: string,
  candidates: readonly string[],
  options: SuggestOptions = {},
): string[] {
  const maxDistance = options.maxDistance ?? SUGGEST_MAX_DISTANCE
  const limit = options.limit ?? SUGGEST_LIMIT
  if (limit <= 0) return []
  const needle = token.toLowerCase()
  const scored: { name: string; distance: number }[] = []
  for (const name of new Set(candidates)) {
    const distance = editDistance(needle, name.toLowerCase())
    if (distance <= maxDistance) scored.push({ name, distance })
  }
  scored.sort((x, y) => x.distance - y.distance || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
  return scored.slice(0, limit).map((s) => s.name)
}

/**
 * Suggestions for an unknown child `token` of `node`. Candidates are the
 * names and aliases of the visible children. Hidden children resolve but are
 * never suggested.
 */
export function suggestChildren(
  node: CommandSpec,
  token: string,
  options: SuggestOptions = {},
): string[] {
  const candidates: string[] = []
  for (const child of node.commands ?? []) {
    if (child.hidden === true) continue
    candidates.push(child.name, ...(child.aliases ?? []))
  }
  return suggest(token, candidates, options)
}
