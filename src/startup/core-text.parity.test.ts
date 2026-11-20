/**
 * Parity snapshot (PLAN step S0.6): the "before" text of user-facing strings
 * that the CLI shows today and that core builds.
 *
 * A later move of this text out of core must keep every snapshot below equal.
 * Each fixture has a stable id (the inventory row id from
 * research/core-prompts/inventory-host-text.md plus a suffix) in its test name.
 * Each fixture runs twice in the same test and both runs must be equal, so
 * the snapshot holds no time, id or random value.
 *
 * The text is rendered the way the CLI renders it today: the CLI line prefix
 * is part of the fixture when the CLI adds one (for example `✗ ` in
 * `startCompactFallback`, or the print-mode notice marker).
 * Values are synthetic. The auth home is an empty directory under `./tmp`.
 *
 * Skipped (cause in research/team/julia/s0.6-notes.md): d1 lock timeout (not a
 * public core export, boundary rule), d19 unknown model (private
 * `resolveModelAuth`, needs a full `bootHost`), d34 watchdog text (needs a
 * live stream), e1..e3 retry lines (need the transport).
 *
 * @module startup/core-text.parity.test
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

import {
  InvalidAuthorizationCodeError,
  NoProviderCredentialsError,
  SignInTimeoutError,
  TokenExchangeError,
} from "@minimal-agent/core/errors"
import type { AuthResult } from "@minimal-agent/core/host/auth"
import { parseCompactArgs } from "@minimal-agent/core/host/compact-contract"
import { tryRecoverContextExceeded } from "@minimal-agent/core/host/context-exceeded-recovery"
import { fatalErrorFields } from "@minimal-agent/core/host/error-hint"
import { contextLengthExceededAdvice } from "@minimal-agent/core/host/model-error"
import { modelShortLabel } from "@minimal-agent/core/host/model-label"
import {
  type LoginDeps,
  resolveDefaultOAuthLoginProvider,
  runOAuthLogin,
} from "@minimal-agent/core/host/oauth-login"
import { describeStartupAuth, resolveStartupAuth } from "@minimal-agent/core/host/provider-auth"
import type { TurnNotice } from "@minimal-agent/core/sdk/turn-notice"
import {
  compactArgsErrorText,
  contextExceededAdviceText,
  contextNoticeText,
  errorText,
  loginEventText,
  loginFailureText,
  startupAuthText,
} from "./core-text.ts"
import { turnNoticePlainText } from "./turn-notice-text.ts"

type OAuthProvider = NonNullable<LoginDeps["provider"]>

/** The env keys that change core text. Saved, cleared for the run, restored after. */
const ENV_KEYS = [
  "MINIMAL_AGENT_HOME",
  "MINIMAL_AGENT_TEST_AUTH",
  "MINIMAL_AGENT_AUTO_COMPACT",
  "DEBUG",
] as const
const savedEnv = new Map<string, string | undefined>()
const TMP_ROOT = join(import.meta.dir, "..", "..", "tmp")
let authHome = ""

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv.set(k, process.env[k])
  mkdirSync(TMP_ROOT, { recursive: true })
  authHome = mkdtempSync(join(TMP_ROOT, "core-text-parity-"))
  process.env.MINIMAL_AGENT_HOME = authHome
  delete process.env.MINIMAL_AGENT_TEST_AUTH
  delete process.env.MINIMAL_AGENT_AUTO_COMPACT
  delete process.env.DEBUG
})

afterAll(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k)
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(authHome, { recursive: true, force: true })
})

/** The message of the error that `fn` rejects with. */
async function rejection(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (e) {
    return errorText(e)
  }
  throw new Error("expected a rejection")
}

/** What `startCompactFallback` writes for a parse error. */
function compactLine(argv: string): string {
  const parsed = parseCompactArgs(argv)
  if (parsed.error === undefined) throw new Error("expected a compact parse error")
  return `✗ ${compactArgsErrorText(parsed.error)}`
}

/** What print-mode writes for a notice event (`src/print-mode.ts` notice case). */
function printNotice(notice: TurnNotice): string {
  const marker = notice.severity === "error" ? "✗" : "·"
  return `${marker} ${turnNoticePlainText(notice)}`
}

/** Fixed bytes so PKCE state and verifier are the same on every run. */
const FIXED_BYTES = (len: number): Buffer => Buffer.alloc(len, 7)

/** Synthetic OAuth provider. Every URL uses the reserved `.test` domain. */
function fakeProvider(withDeviceCode: boolean): OAuthProvider {
  const built = {
    credential: { serviceId: "fake-oauth", displayName: "Fake", secrets: { token: "x" } },
    result: { accessToken: "a", refreshToken: "r", expiresAt: 0, scopes: [] },
  }
  return {
    serviceId: "fake-oauth",
    displayName: "Fake",
    config: () => ({
      clientId: "client-synthetic",
      authorizeUrl: "https://auth.example.test/authorize",
      tokenUrl: "https://auth.example.test/token",
      redirectUri: "https://auth.example.test/callback",
      scopes: ["scope.a"],
    }),
    buildCredential: () => built,
    ...(withDeviceCode
      ? {
          deviceCode: {
            request: async () => ({
              verificationUrl: "https://auth.example.test/device",
              userCode: "ABCD-1234",
              expiresInMs: 1000,
            }),
            complete: async () => built,
          },
        }
      : {}),
  } as unknown as OAuthProvider
}

/** The lines `display` receives in a login run, joined by a visible separator. */
async function loginLines(
  provider: OAuthProvider,
  paste: string,
  maxAttempts: number,
): Promise<string> {
  const lines: string[] = []
  const outcome = await runOAuthLogin({
    provider,
    onLoginEvent: (ev) => lines.push(loginEventText(ev)),
    readPaste: async () => paste,
    randomBytes: FIXED_BYTES,
    maxAttempts,
    install: {
      store: {
        suggestCredentialName: () => "Fake",
        set: () => {},
      } as unknown as NonNullable<LoginDeps["install"]>["store"],
    },
  })
  return [
    ...lines,
    `outcome: ${JSON.stringify(outcome.ok ? outcome : { ...outcome, reason: loginFailureText(outcome.reason) })}`,
  ].join("\n--\n")
}

const fakeAgent = (
  compact: (() => Promise<{ kind: "local"; messagesBefore: number; messagesAfter: number }>) | null,
  withPending: boolean,
) => ({
  getModel: () => "model-a",
  history: () =>
    withPending ? [{ role: "user" as const, content: "please continue the task" }] : [],
  ...(compact ? { compact } : {}),
})

type Fixture = readonly [
  id: string,
  label: string,
  source: string,
  run: () => string | Promise<string>,
]

/** The fixtures. Order and ids are stable: the later move maps on the id. */
const FIXTURES: readonly Fixture[] = [
  // Auth errors (d15)
  [
    "d15-87",
    "auth: no provider selected",
    "core src/auth/provider-auth.ts:87",
    () => rejection(() => resolveStartupAuth(undefined, "model-a")),
  ],
  [
    "d15-103",
    "auth: no credentials for provider (empty store)",
    "core src/auth/provider-auth.ts:103",
    () => rejection(() => resolveStartupAuth("acme", "model-a")),
  ],
  [
    "d15-120",
    "auth: generic-endpoint bearer needs --api-key",
    "core src/auth/provider-auth.ts:120",
    () =>
      rejection(() =>
        resolveStartupAuth("generic-endpoint", "model-a", undefined, { authType: "bearer" }),
      ),
  ],
  [
    "d15-126",
    "auth: custom-header needs --api-key",
    "core src/auth/provider-auth.ts:126",
    () =>
      rejection(() =>
        resolveStartupAuth("generic-endpoint", "model-a", undefined, { authType: "custom-header" }),
      ),
  ],
  [
    "d15-128",
    "auth: custom-header needs --auth-header",
    "core src/auth/provider-auth.ts:128",
    () =>
      rejection(() =>
        resolveStartupAuth("generic-endpoint", "model-a", undefined, {
          authType: "custom-header",
          apiKey: "k",
        }),
      ),
  ],
  [
    "b25-oauth",
    "startup tree auth row: oauth with account",
    "core src/auth/provider-auth.ts:158-170",
    () =>
      startupAuthText(
        describeStartupAuth(
          { type: "oauth", token: "t", accountUuid: "abcdef1234567890" } as AuthResult,
          undefined,
        ),
        (s) => `<dim>${s}</dim>`,
      ),
  ],
  [
    "b25-apikey",
    "startup tree auth row: api-key",
    "core src/auth/provider-auth.ts:158-170",
    () =>
      startupAuthText(
        describeStartupAuth({ type: "api-key", token: "t" } as AuthResult, undefined),
      ),
  ],
  // Context window and compact (d31, d32, d33)
  [
    "d32-model",
    "context exceeded advice with a model",
    "core src/llm/model-error.ts:73-80",
    () => contextExceededAdviceText(contextLengthExceededAdvice("model-a")),
  ],
  [
    "d32-nomodel",
    "context exceeded advice without a model",
    "core src/llm/model-error.ts:73-80",
    () => contextExceededAdviceText(contextLengthExceededAdvice(undefined)),
  ],
  [
    "d33-retry",
    "auto-compact ok, then retry of the failed turn",
    "core src/agent/context-exceeded-recovery.ts:101,104",
    async () => {
      const r = await tryRecoverContextExceeded(
        fakeAgent(async () => ({ kind: "local", messagesBefore: 40, messagesAfter: 6 }), true),
        "context_length_exceeded",
      )
      return JSON.stringify({ ...r, notices: r.notices.map(contextNoticeText) }, null, 2)
    },
  ],
  [
    "d33-failed",
    "auto-compact failed",
    "core src/agent/context-exceeded-recovery.ts:114",
    async () => {
      const r = await tryRecoverContextExceeded(
        fakeAgent(async () => {
          throw new Error("summary call failed")
        }, true),
        "maximum context length",
      )
      return r.notices.map(contextNoticeText).join("\n--\n")
    },
  ],
  [
    "d33-failed-core-error",
    "auto-compact failed with a CoreError cause",
    "core src/agent/context-exceeded-recovery.ts:132",
    async () => {
      const r = await tryRecoverContextExceeded(
        fakeAgent(async () => {
          throw new NoProviderCredentialsError("anthropic", "model-a", [])
        }, true),
        "maximum context length",
      )
      return r.notices.map(contextNoticeText).join("\n--\n")
    },
  ],
  [
    "d33-off",
    "auto-compact unavailable: advice only",
    "core src/agent/context-exceeded-recovery.ts:80-87",
    async () => {
      const r = await tryRecoverContextExceeded(fakeAgent(null, false), "context_length_exceeded")
      return r.notices.map(contextNoticeText).join("\n--\n")
    },
  ],
  [
    "d31-unknown-arg",
    "/compact unknown argument",
    "core src/agent/context-compact.ts:300",
    () => compactLine("bogus"),
  ],
  [
    "d31-dup-mode",
    "/compact duplicate mode",
    "core src/agent/context-compact.ts:297",
    () => compactLine("local tail"),
  ],
  [
    "d31-unknown-mode",
    "/compact unknown mode",
    "core src/agent/context-compact.ts:308",
    () => compactLine("mode=wide"),
  ],
  [
    "d31-tail",
    "/compact tail not an integer",
    "core src/agent/context-compact.ts:315",
    () => compactLine("tail=x"),
  ],
  // Turn notices (b13), rendered as print-mode does
  [
    "b13-refusal",
    "notice: refusal with category and message",
    "core src/agent/turn-notice.ts:215",
    () =>
      printNotice({
        kind: "refusal",
        severity: "error",
        category: "policy",
        message: "blocked",
      } as TurnNotice),
  ],
  [
    "b13-max-continuing",
    "notice: max_tokens auto-continuing",
    "core src/agent/turn-notice.ts:219",
    () => printNotice({ kind: "max_tokens_continuing", severity: "warn", attempt: 1, cap: 3 }),
  ],
  [
    "b13-max-capped",
    "notice: max_tokens capped",
    "core src/agent/turn-notice.ts:221",
    () => printNotice({ kind: "max_tokens_capped", severity: "warn", cap: 3 }),
  ],
  [
    "b13-stream-salvaged",
    "notice: stream interrupted, salvaged tool calls (plural)",
    "core src/agent/turn-notice.ts:230",
    () =>
      printNotice({ kind: "stream_interrupted_salvaged", severity: "warn", completedToolCalls: 2 }),
  ],
  [
    "b13-stream-capped",
    "notice: stream interrupted, capped",
    "core src/agent/turn-notice.ts:236",
    () => printNotice({ kind: "stream_interrupted_capped", severity: "warn", cap: 3 }),
  ],
  [
    "b13-ask-denied",
    "notice: ask denied",
    "core src/agent/turn-notice.ts:238",
    () =>
      printNotice({ kind: "ask_denied", severity: "warn", code: "preflight.x", title: "Confirm" }),
  ],
  [
    "b13-model-adopted",
    "notice: model adopted with effort reset",
    "core src/agent/turn-notice.ts:239-242",
    () =>
      printNotice({
        kind: "model_adopted",
        severity: "info",
        from: "model-a",
        to: "model-b",
        effortReset: true,
        effortFrom: "high",
      }),
  ],
  [
    "b13-model-adopt-failed",
    "notice: could not adopt model",
    "core src/agent/turn-notice.ts:243-244",
    () =>
      printNotice({
        kind: "model_adopt_failed",
        severity: "warn",
        model: "model-a",
        requested: "model-z",
        reason: "unknown",
      }),
  ],
  [
    "b13-max-salvaged",
    "notice: max_tokens salvaged mid tool-call",
    "core src/agent/turn-notice.ts:218-219",
    () => printNotice({ kind: "max_tokens_salvaged", severity: "warn" }),
  ],
  [
    "b13-stream-continuing",
    "notice: stream interrupted, continuing",
    "core src/agent/turn-notice.ts:233-234",
    () =>
      printNotice({ kind: "stream_interrupted_continuing", severity: "warn", attempt: 2, cap: 3 }),
  ],
  [
    "b13-stream-salvaged-one",
    "notice: stream interrupted, salvaged 1 tool call (singular)",
    "core src/agent/turn-notice.ts:229-231",
    () =>
      printNotice({ kind: "stream_interrupted_salvaged", severity: "warn", completedToolCalls: 1 }),
  ],
  [
    "b13-content-filter",
    "notice: content filter with category and message",
    "core src/agent/turn-notice.ts:211-216",
    () =>
      printNotice({
        kind: "content_filter",
        severity: "error",
        category: "hate",
        message: "flagged",
      }),
  ],
  [
    "b13-refusal-bare",
    "notice: refusal with null category and message",
    "core src/agent/turn-notice.ts:211-216",
    () => printNotice({ kind: "refusal", severity: "error", category: null, message: null }),
  ],
  [
    "b13-model-adopted-plain",
    "notice: model adopted, effort not reset",
    "core src/agent/turn-notice.ts:239-242",
    () =>
      printNotice({
        kind: "model_adopted",
        severity: "info",
        from: "model-a",
        to: "model-b",
        effortReset: false,
        effortFrom: null,
      }),
  ],
  // Error event with hint (print-mode error case over core fatalErrorFields)
  [
    "hint-error",
    "error line with the provider hint",
    "core src/llm/error-hint.ts:41-52 + cli src/print-mode.ts:174",
    () => {
      const err = Object.assign(new Error("request failed"), { hint: "Run login\nagain" })
      const f = fatalErrorFields(err)
      if (!f) throw new Error("expected fields")
      return f.hint ? `✗ ${f.message}\n  hint: ${f.hint}` : `✗ ${f.message}`
    },
  ],
  // OAuth lines (f1, d16)
  [
    "f1-device",
    "oauth device-code display lines",
    "core src/auth/oauth-login.ts:463,472",
    () => loginLines(fakeProvider(true), "", 1),
  ],
  [
    "f1-browser",
    "oauth browser lines and empty paste",
    "core src/auth/oauth-login.ts:509-510,533",
    () => loginLines(fakeProvider(false), "", 2),
  ],
  [
    "f1-state-mismatch",
    "oauth state mismatch line",
    "core src/auth/oauth-login.ts:541",
    () => loginLines(fakeProvider(false), "https://auth.example.test/cb?code=c&state=wrong", 2),
  ],
  [
    "d16-no-provider",
    "oauth: no login provider registered",
    "core src/auth/oauth-login.ts:431",
    () => {
      try {
        resolveDefaultOAuthLoginProvider()
      } catch (e) {
        return errorText(e)
      }
      throw new Error("expected a throw")
    },
  ],
  [
    "oauth-timeout",
    "oauth: sign-in timed out",
    "core src/auth/oauth-login.ts:52,105",
    () => errorText(new SignInTimeoutError()),
  ],
  [
    "oauth-invalid-code",
    "oauth: token endpoint 401",
    "core src/auth/oauth-login.ts:326",
    () => errorText(new InvalidAuthorizationCodeError()),
  ],
  [
    "oauth-token-exchange",
    "oauth: token exchange failed with status and body",
    "core src/auth/oauth-login.ts:328",
    () => errorText(new TokenExchangeError(503, "service unavailable")),
  ],
  [
    "b24-unregistered",
    "status model label for an unregistered id",
    "core src/llm/model-label.ts:22-60",
    () => modelShortLabel("vendor-model-1"),
  ],
]

describe("core text parity (S0.6 before snapshot)", () => {
  for (const [id, label, _source, run] of FIXTURES) {
    test(`${id}: ${label}`, async () => {
      const first = await run()
      const second = await run()
      expect(second).toBe(first)
      expect(first).toMatchSnapshot()
    })
  }

  test("fixture ids are unique and the count is at least 20", () => {
    const ids = FIXTURES.map((f) => f[0])
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeGreaterThanOrEqual(20)
  })

  test("no snapshot value holds a home path or the auth home", async () => {
    for (const [, , , run] of FIXTURES) {
      const text = await run()
      expect(text).not.toContain(authHome)
      expect(text).not.toContain(process.env.HOME ?? "\u0000")
    }
  })
})
