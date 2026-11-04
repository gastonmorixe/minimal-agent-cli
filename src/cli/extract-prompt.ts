/**
 * Non-interactive prompt extraction from CLI args.
 *
 * Lifted out of `src/index.ts` so it can be unit-tested without pulling
 * the entire startup side-effect graph. Pure (synchronous, no I/O); the
 * stdin-read case is signalled by a `kind: "stdin"` discriminator and
 * the caller (`index.ts`) does the actual `process.stdin` slurp.
 *
 * Three forms supported (checked in this order):
 * 1. `--prompt <text>`     — explicit flag → `{kind:"literal", text}`
 * 2. `-`                   — read stdin   → `{kind:"stdin"}`
 * 3. First bare positional — non-flag, non-flag-value arg → `{kind:"literal", text}`
 *
 * Otherwise `{kind:"none"}` (interactive REPL).
 *
 * Critical invariant: `FLAGS_WITH_VALUES` MUST list every long flag that
 * consumes the following positional, otherwise the bare-positional walk
 * will mistake the flag's value for the user's prompt and the agent will
 * silently enter non-interactive mode. The set is derived from the CLI
 * registry (SPEC-HELP M-12), so a FlagSpec with `value: "required"` is in
 * it. Tests in `src/cli/extract-prompt.test.ts` pin the regression-prone
 * flags (`--resume`, `--model`, `--provider`, etc), and
 * `src/cli/registry/arity.test.ts` (V-18) pins the derived sets.
 *
 * @module extract-prompt
 */

import { builtinArity } from "./registry/arity.ts"

/**
 * Long flags that consume the following positional as their value.
 * Used to skip both the flag and its value when scanning for a bare
 * positional prompt.
 *
 * Derived from the CLI registry (SPEC-HELP M-12): every long form of a
 * FlagSpec with `value: "required"`, global and per command. To add a
 * value-taking flag, add its FlagSpec in `src/cli/registry` or a
 * `*.command.ts` file. See `src/cli/registry/arity.ts`.
 */
export const FLAGS_WITH_VALUES: ReadonlySet<string> = builtinArity().flagsWithValues

/**
 * Flags that take no value. They consume their own slot but not the
 * following positional, so a positional after one is a real prompt.
 *
 * Derived from the CLI registry (SPEC-HELP M-12): every long form of a
 * FlagSpec with `value: "none"` or `value: "optional"`, the `--no-<name>`
 * form of a negatable flag, plus `-` and `-h`. Optional-value flags
 * (`--sessions`, `--list-models`, `--list-models-live`, `--usage`) stay
 * here: each one selects a command that does not read the prompt.
 */
export const FLAGS_NO_VALUE: ReadonlySet<string> = builtinArity().flagsNoValue

export type PromptSource = { kind: "literal"; text: string } | { kind: "stdin" } | { kind: "none" }

/**
 * Pure: classify how the prompt should be sourced for this argv.
 *
 * Does NOT read stdin — caller does that on `{kind:"stdin"}`.
 *
 * @param allArgs - Normalized argv (output of `normalizeArgs`).
 */
export function extractPromptFromArgs(allArgs: readonly string[]): PromptSource {
  // 0. Every arg after `--host-mode <id>` belongs to the host mode (its
  //    `ctx.argv`), never to the prompt. Scan only the args up to the id.
  const hostModeIdx = allArgs.indexOf("--host-mode")
  const args = hostModeIdx === -1 ? allArgs : allArgs.slice(0, hostModeIdx + 2)

  // 1. --prompt "text"
  const promptIdx = args.indexOf("--prompt")
  if (promptIdx !== -1 && args[promptIdx + 1] !== undefined) {
    return { kind: "literal", text: args[promptIdx + 1] }
  }

  // 2. "-" → stdin
  if (args.includes("-")) return { kind: "stdin" }

  // 3. First bare positional that isn't a flag or a flag's value.
  const skipNext = new Set<number>()
  for (let i = 0; i < args.length; i++) {
    if (FLAGS_WITH_VALUES.has(args[i])) {
      skipNext.add(i)
      skipNext.add(i + 1)
    } else if (FLAGS_NO_VALUE.has(args[i])) {
      skipNext.add(i)
    }
  }
  for (let i = 0; i < args.length; i++) {
    if (!skipNext.has(i) && !args[i].startsWith("--")) {
      return { kind: "literal", text: args[i] }
    }
  }

  return { kind: "none" }
}
