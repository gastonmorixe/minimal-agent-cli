/**
 * One-shot run options (SPEC-ONESHOT R6-R9): `--output-schema` inline JSON,
 * `--strict`, `--append-system-prompt(-file)`, and `--temperature`.
 *
 * `parse-argv.ts` reads the raw flag values. This module turns them into
 * the values the run gets, and checks what the core in use can apply
 * (risk K1: the pinned core lacks `appendSystemPrompt`, the per-run
 * temperature setter, and the strict setter). A missing feature gives one
 * stderr warn line and the run continues without it. It never throws.
 *
 * @module oneshot/oneshot-options
 */

import { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import { parseSchemaFile } from "@minimal-agent/core/sdk/output-schema"
import { detectHostRuntimeCapabilities } from "../startup/run-host-mode.ts"
import type { OneShotRunOptions } from "./arm-run.ts"

/** What the core in use can apply for a one-shot run. */
export interface OneShotCapabilities {
  /** The session reads the `appendSystemPrompt` dep (core M2). */
  readonly appendSystemPrompt: boolean
  /** `AgentCore.setNextRunTemperature` exists (core D4). */
  readonly temperature: boolean
  /** `AgentCore.setNextRunOutputStrict` exists (core R2). */
  readonly strict: boolean
}

/**
 * Feature detection on the real core: the host-mode probe for append and
 * temperature, and the same prototype check for the strict setter.
 * Never throws: a failed probe gives `false`.
 */
export function detectOneShotCapabilities(): OneShotCapabilities {
  const host = detectHostRuntimeCapabilities()
  const proto = AgentCore.prototype as unknown as { setNextRunOutputStrict?: unknown }
  return {
    appendSystemPrompt: host.systemPrompt.append,
    temperature: host.temperature,
    strict: typeof proto.setNextRunOutputStrict === "function",
  }
}

/** Raw one-shot values from `parseCliOptions`. */
export interface OneShotFlags {
  /** The `--output-schema` value: a file path or inline JSON. */
  readonly outputSchemaArg: string | undefined
  readonly strict: boolean
  readonly appendSystemPrompt: string | undefined
  readonly appendSystemPromptFile: string | undefined
  /** `--input-format open-responses` append text (R15). Joined after the flag text. */
  readonly orAppendSystemPrompt?: string
  /** `--input-format open-responses` request `stream: true` (R14). Goes to `runOptions`. */
  readonly orStream?: boolean
  /** Already checked as finite by `parseCliOptions`. */
  readonly temperature: number | undefined
  /** `--schema-retries`, already checked as 0..5 by `parseCliOptions`. Absent: 0. */
  readonly schemaRetries?: number
}

/** A user error: the caller writes `message` to stderr and exits with `exitCode`. */
export interface OneShotError {
  readonly ok: false
  readonly message: string
  readonly exitCode: number
}

/** The resolved one-shot options. */
export interface OneShotPlan {
  readonly ok: true
  readonly outputSchema: object | undefined
  /** Append text for the session. Only set when the core can apply it. */
  readonly appendSystemPrompt: string | undefined
  /** One-shot values for the prompt run. Only set when the core can apply them. */
  readonly runOptions: OneShotRunOptions
  /** Lines for stderr (warns and notes), each with a trailing newline. */
  readonly notes: readonly string[]
}

/** Inputs for {@link planOneShot}. */
export interface PlanOneShotInput {
  readonly flags: OneShotFlags
  readonly capabilities: OneShotCapabilities
  /** A `full` system-prompt replace or omit is active (core then drops the append). */
  readonly fullOverrideActive: boolean
  readonly readFile: (path: string) => string
}

const WARN = "[minimal-agent] warn:"
const NOTE = "[minimal-agent] note:"

/** `true` when the value is inline JSON (starts with `{` after trim), not a path. */
export function isInlineSchema(arg: string): boolean {
  return arg.trimStart().startsWith("{")
}

/**
 * Read `--output-schema`: inline JSON, else a file path (as before).
 * Bad inline JSON: exit 2. A bad or missing file keeps the old exit 1.
 */
export function loadOutputSchema(
  arg: string,
  readFile: (path: string) => string,
): { readonly ok: true; readonly schema: object } | OneShotError {
  if (isInlineSchema(arg)) {
    try {
      return { ok: true, schema: parseSchemaFile(arg) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `--output-schema (inline JSON): ${msg}`, exitCode: 2 }
    }
  }
  try {
    return { ok: true, schema: parseSchemaFile(readFile(arg)) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `--output-schema: ${msg}`, exitCode: 1 }
  }
}

/**
 * Join `--append-system-prompt` and `--append-system-prompt-file` text
 * (text first, one blank line between). A missing file: exit 2.
 */
export function resolveAppendText(
  text: string | undefined,
  file: string | undefined,
  readFile: (path: string) => string,
): { readonly ok: true; readonly text: string | undefined } | OneShotError {
  const parts: string[] = []
  if (text !== undefined && text.trim() !== "") parts.push(text)
  if (file !== undefined) {
    let body: string
    try {
      body = readFile(file)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        message: `--append-system-prompt-file: cannot read ${JSON.stringify(file)}: ${msg}`,
        exitCode: 2,
      }
    }
    if (body.trim() !== "") parts.push(body)
  }
  return { ok: true, text: parts.length > 0 ? parts.join("\n\n") : undefined }
}

/**
 * Resolve every one-shot option. Returns an error for a user mistake
 * (bad inline schema, missing append file), else the plan. Unsupported
 * core features become warn lines, never errors.
 */
export function planOneShot(input: PlanOneShotInput): OneShotPlan | OneShotError {
  const { flags, capabilities, readFile } = input
  const notes: string[] = []

  let outputSchema: object | undefined
  if (flags.outputSchemaArg !== undefined) {
    const loaded = loadOutputSchema(flags.outputSchemaArg, readFile)
    if (!loaded.ok) return loaded
    outputSchema = loaded.schema
  }

  const fromFlags = resolveAppendText(
    flags.appendSystemPrompt,
    flags.appendSystemPromptFile,
    readFile,
  )
  if (!fromFlags.ok) return fromFlags
  // R15: the request text comes after the flag text, one blank line between.
  const orText = flags.orAppendSystemPrompt
  const append =
    orText !== undefined && orText.trim() !== ""
      ? { text: fromFlags.text !== undefined ? `${fromFlags.text}\n\n${orText}` : orText }
      : fromFlags

  let appendSystemPrompt: string | undefined
  if (append.text !== undefined) {
    if (input.fullOverrideActive) {
      notes.push(
        `${WARN} --append-system-prompt ignored, a full --system-prompt override is active\n`,
      )
    } else if (!capabilities.appendSystemPrompt) {
      notes.push(unsupported("--append-system-prompt"))
    } else {
      appendSystemPrompt = append.text
    }
  }

  const runOptions: {
    temperature?: number
    outputStrict?: boolean
    schemaRetries?: number
    orStream?: boolean
  } = {}
  if (flags.orStream === true) runOptions.orStream = true
  const retries = flags.schemaRetries ?? 0
  if (retries > 0) {
    if (outputSchema === undefined) {
      notes.push(`${NOTE} --schema-retries has no effect without --output-schema\n`)
    } else {
      runOptions.schemaRetries = retries
    }
  }
  if (flags.strict) {
    if (outputSchema === undefined) {
      notes.push(`${NOTE} --strict has no effect without --output-schema\n`)
    } else if (!capabilities.strict) {
      notes.push(unsupported("--strict"))
    } else {
      runOptions.outputStrict = true
    }
  }

  if (flags.temperature !== undefined) {
    if (capabilities.temperature) runOptions.temperature = flags.temperature
    else notes.push(unsupported("--temperature"))
  }

  return { ok: true, outputSchema, appendSystemPrompt, runOptions, notes }
}

function unsupported(flag: string): string {
  return `${WARN} this core does not support ${flag}; running without it\n`
}

/** A `full` system-prompt replace or omit is active (it drops the append text). */
export function isFullOverrideActive(
  overrides: { readonly full?: { readonly kind: string } } | undefined,
): boolean {
  const kind = overrides?.full?.kind
  return kind !== undefined && kind !== "default"
}

/** The {@link OneShotPlan} as the entry point uses it. */
export type OneShotSetup = OneShotPlan & {
  /**
   * `{appendSystemPrompt}` or `{}`, to spread into the session deps. A plain
   * object, so it stays structural on the pinned core whose deps type has
   * no such field.
   */
  readonly appendDeps: { readonly appendSystemPrompt?: string }
}

/**
 * Entry-point glue: plan the one-shot options from the parsed CLI options,
 * write every note to `stderr`, and on a user error write the message and
 * call `exit` with its code.
 */
export function setupOneShot(
  opts: {
    readonly outputSchemaPath: string | undefined
    readonly strict: boolean
    readonly appendSystemPrompt: string | undefined
    readonly appendSystemPromptFile: string | undefined
    readonly orAppendSystemPrompt?: string
    readonly orStream?: boolean
    readonly temperature: number | undefined
    readonly schemaRetries?: number
    readonly systemPromptOverrides?: { readonly full?: { readonly kind: string } }
  },
  readFile: (path: string) => string,
  exit: (code: number) => never,
  stderr: (chunk: string) => void = (chunk) => void process.stderr.write(chunk),
  capabilities: OneShotCapabilities = detectOneShotCapabilities(),
): OneShotSetup {
  const plan = planOneShot({
    flags: {
      outputSchemaArg: opts.outputSchemaPath,
      strict: opts.strict,
      appendSystemPrompt: opts.appendSystemPrompt,
      appendSystemPromptFile: opts.appendSystemPromptFile,
      ...(opts.orAppendSystemPrompt !== undefined
        ? { orAppendSystemPrompt: opts.orAppendSystemPrompt }
        : {}),
      ...(opts.orStream === true ? { orStream: true } : {}),
      temperature: opts.temperature,
      ...(opts.schemaRetries !== undefined ? { schemaRetries: opts.schemaRetries } : {}),
    },
    capabilities,
    fullOverrideActive: isFullOverrideActive(opts.systemPromptOverrides),
    readFile,
  })
  if (!plan.ok) {
    stderr(`${plan.message}\n`)
    return exit(plan.exitCode)
  }
  for (const line of plan.notes) stderr(line)
  const appendDeps =
    plan.appendSystemPrompt !== undefined ? { appendSystemPrompt: plan.appendSystemPrompt } : {}
  return { ...plan, appendDeps }
}
