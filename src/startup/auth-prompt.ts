/**
 * First-time / stale-credentials login prompt for the CLI entry point.
 *
 * Wraps a credential resolver so a fresh install (no credentials) or a
 * rejected refresh token offers an inline `--login` flow on interactive
 * TTYs instead of dumping the user back at the shell. Non-interactive runs
 * keep the fail-fast behavior. The caller gives the resolver (for example
 * `resolveStartupAuth` from `@minimal-agent/core/host/provider-auth`).
 * Core holds no provider OAuth client (decision 39).
 *
 * Split out of `src/index.ts` to keep that file under the `max-lines`
 * lint budget.
 *
 * @module startup/auth-prompt
 */

import type { AuthResult } from "@minimal-agent/core/host/auth"
import { discoverCredentialedProviders } from "@minimal-agent/core/host/auth-strategies"
import { runLoginCommand } from "../commands/login.ts"
import {
  renderStartupAuthPromptAborted,
  renderStartupAuthPromptIntro,
  renderStartupAuthPromptQuestion,
  renderStartupAuthPromptStarting,
  type StartupAuthPromptKind,
} from "../ui/chrome/auth-prompt.ts"
import { type CommandOutput, writeCommandRows } from "../ui/command-output.ts"

export interface FirstTimeAuthPromptDeps {
  /** Resolve the credential of the selected provider. */
  resolveAuth: () => Promise<AuthResult>
  /** Override login handoff for tests. */
  runLogin?: () => Promise<number>
  /** Input stream for the yes/no prompt. */
  input?: NodeJS.ReadableStream & { isTTY?: boolean }
  /** Output stream for prompt rows. */
  output?: CommandOutput
  /** Force interactivity in tests. Defaults to stdin+stdout TTY. */
  isInteractive?: boolean
}

/**
 * Wrap `deps.resolveAuth()` with a first-time / stale-credentials login prompt.
 *
 * On a fresh install minimal-agent's own store (`~/.minimal-agent/auth.jsonc`)
 * is empty, so the resolver throws `"no credentials for provider …"`.
 * Rather than dump the user back at the shell with an error, we detect that
 * case in interactive mode (TTY on stdout AND stdin) and offer to run
 * `--login` inline. If they accept, we run the OAuth flow and retry
 * the resolver.
 *
 * Non-interactive runs (non-TTY, `--prompt`, piped stdin) keep the current
 * "fail fast with a hint" behavior — script-friendly and predictable.
 *
 * Stale credentials (refresh token rejected) take a similar path: we surface
 * the error and ask if they want to re-login. The 401-after-refresh case in
 * the transport is handled separately (it bubbles a clean error that
 * already names the login command).
 */
export async function getAuthWithFirstTimePrompt(
  deps: FirstTimeAuthPromptDeps,
): Promise<AuthResult> {
  const auth = deps.resolveAuth
  const input = deps.input ?? process.stdin
  const output = deps.output ?? process.stderr
  const runLogin =
    deps.runLogin ??
    (() => {
      const credentialed = discoverCredentialedProviders()
      const providerId = credentialed.length === 1 ? credentialed[0]!.providerId : undefined
      return runLoginCommand({ providerId })
    })
  try {
    return await auth()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const looksLikeMissing =
      /No minimal-agent credentials|No credentials found|no credentials for provider|No OAuth access token|No refresh token/i.test(
        msg,
      )
    const looksLikeStale = /invalid_grant|stale/i.test(msg)
    const interactive =
      deps.isInteractive ?? (input.isTTY === true && process.stdout.isTTY === true)

    if (!interactive || (!looksLikeMissing && !looksLikeStale)) {
      throw err
    }

    // Interactive — offer a one-shot login. Print the diagnosis first so
    // the user sees WHY the prompt appeared, then ask y/N. Default is
    // "no" for stale credentials (user might prefer to re-run with
    // different flags) and "yes" for fresh installs (the only sane next
    // step).
    const kind: StartupAuthPromptKind = looksLikeMissing ? "missing" : "stale"
    writeCommandRows(renderStartupAuthPromptIntro(kind, msg), output)
    const defaultYes = looksLikeMissing
    const answer = await readSingleLineFromStdin(
      renderStartupAuthPromptQuestion(defaultYes),
      input,
      output,
    )
    const yes = answer === "" ? defaultYes : /^y(es)?$/i.test(answer.trim())
    if (!yes) {
      writeCommandRows(renderStartupAuthPromptAborted(), output)
      throw err
    }
    writeCommandRows(renderStartupAuthPromptStarting(), output)

    const code = await runLogin()
    if (code !== 0) {
      // Preserve the original error as `cause` so callers (or a future
      // structured-logging hook) can surface BOTH the post-login retry
      // failure AND the original "no creds / invalid_grant" diagnosis.
      throw new Error(
        "Login failed; see messages above. Re-run `minimal-agent --login` to retry.",
        { cause: err },
      )
    }
    // Login wrote the credential store; retry. If THIS still fails,
    // surface the error — we're not going to loop.
    return await auth()
  }
}

/**
 * Read one line from stdin without entering raw mode. Used for the
 * first-time-login y/N prompt. Implementation is the same shape as
 * `commands/login.ts`'s `readLine` but inlined so we don't pull in the
 * full login command module before we know it's needed.
 */
async function readSingleLineFromStdin(
  promptText: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: CommandOutput = process.stderr,
): Promise<string> {
  const { createInterface } = await import("node:readline")
  return new Promise<string>((resolve) => {
    output.write(promptText)
    const rl = createInterface({ input, terminal: false })
    // Resolve BEFORE closing + a `settled` guard: `rl.close()` emits
    // `'close'` synchronously, so `resolve(line)` after `rl.close()` would
    // lose the race to the close handler's `resolve("")`. Mirrors the fix in
    // commands/login.ts's `readLine` and src/input.ts's `readFallback`.
    let settled = false
    rl.once("line", (line) => {
      settled = true
      resolve(line)
      rl.close()
    })
    rl.once("close", () => {
      if (!settled) resolve("")
    })
  })
}
