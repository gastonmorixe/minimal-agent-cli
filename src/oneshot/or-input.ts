/**
 * `--input-format open-responses` (SPEC-ONESHOT R15): read one Open
 * Responses (OR) request JSON from stdin and map it to the existing
 * one-shot options. Input side only. The output side is a separate task.
 *
 * Mapping (see `research/spec-oneshot/R14-open-responses.md`):
 *
 * - `input` (string, or message items): the prompt. Text parts of one
 *   message join with a newline. Messages join with a blank line. An
 *   `assistant` message gets the prefix `Assistant: `. `system` and
 *   `developer` messages go to the append system prompt, after
 *   `instructions`. Image and file parts, and non-message items, are
 *   skipped with a warn.
 * - `instructions`: the append system prompt. A `--append-system-prompt`
 *   flag text comes first, then the request text, one blank line between.
 * - `model`, `temperature`, `reasoning.effort`: the `--model`,
 *   `--temperature`, and `--effort` flags. A CLI flag wins (stderr note).
 *   Effort `none` maps to `low`, the lowest level the CLI knows.
 * - `text.format` `json_schema`: the inline `--output-schema`, plus
 *   `--strict` when `strict` is true. Core names the schema from its
 *   `title`, so the OR `name` becomes the `title` when the schema has none.
 * - `text.format` `json_object`, `top_p`, `max_output_tokens`: no CLI or
 *   core option exists. Warn and ignore.
 * - `stream`: kept for the output side.
 * - `tools`, `tool_choice`, `store`, `metadata`, `user`: ignored, no warn.
 *   `previous_response_id`: warn (the CLI is stateless here).
 * - Any other field: one warn each, never a failure.
 *
 * Bad JSON on stdin, a missing input, or an empty prompt: exit 2. A `-p`
 * or positional prompt next to this flag: exit 2.
 *
 * @module oneshot/or-input
 */

import { normalizeArgs } from "../cli/cli-args.ts"
import { extractPromptFromArgs } from "../cli/extract-prompt.ts"
import { parseInputFormat } from "../cli/parse-argv.ts"

const WARN = "[minimal-agent] warn:"
const NOTE = "[minimal-agent] note:"

/** The one-shot values read from one OR request. */
export interface OrRequest {
  readonly prompt: string
  /** `instructions` plus any `system` / `developer` message text. */
  readonly appendSystemPrompt?: string
  readonly model?: string
  readonly temperature?: number
  readonly effort?: string
  /** From `text.format` `json_schema`. The OR `name` is set as `title` when absent. */
  readonly outputSchema?: object
  readonly strict?: boolean
  /** The request `stream` value (absent means false). For the output side. */
  readonly stream: boolean
  /** Warn and note lines for stderr, each with a trailing newline. */
  readonly warnings: readonly string[]
}

/** A user error: write `message` to stderr and exit 2. */
export interface OrInputError {
  readonly ok: false
  readonly message: string
}

/** Effort levels the CLI passes through (core `KNOWN_EFFORT`). */
const EFFORT_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"])

/** Fields ignored with no warn. */
const SILENT_FIELDS: ReadonlySet<string> = new Set([
  "tools",
  "tool_choice",
  "store",
  "metadata",
  "user",
])

/** Fields read by {@link parseOrRequest}. */
const READ_FIELDS: ReadonlySet<string> = new Set([
  "model",
  "input",
  "instructions",
  "temperature",
  "reasoning",
  "text",
  "stream",
  "top_p",
  "max_output_tokens",
  "previous_response_id",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Collects warn lines, one per distinct text. */
class Warnings {
  private readonly seen = new Set<string>()
  readonly lines: string[] = []

  warn(text: string): void {
    this.push(`${WARN} ${text}\n`)
  }

  note(text: string): void {
    this.push(`${NOTE} ${text}\n`)
  }

  private push(line: string): void {
    if (this.seen.has(line)) return
    this.seen.add(line)
    this.lines.push(line)
  }
}

/** Text of one message `content`: a string, or a parts array. */
function contentText(content: unknown, w: Warnings): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) {
    w.warn("open-responses: message content is not a string or a parts array; skipped")
    return ""
  }
  const texts: string[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    const type = part.type
    if ((type === "input_text" || type === "output_text") && typeof part.text === "string") {
      texts.push(part.text)
    } else if (type === "input_image" || type === "input_file") {
      w.warn(`open-responses: ${type} parts are not supported; skipped`)
    } else {
      w.warn(`open-responses: content part type ${JSON.stringify(type)} is not supported; skipped`)
    }
  }
  return texts.join("\n")
}

/** Split `input` into the prompt text and the system text. */
function mapInput(
  input: unknown,
  w: Warnings,
): { readonly prompt: string; readonly system: readonly string[] } {
  if (typeof input === "string") return { prompt: input, system: [] }
  if (!Array.isArray(input)) {
    w.warn("open-responses: input is not a string or an item array; ignored")
    return { prompt: "", system: [] }
  }
  const turns: string[] = []
  const system: string[] = []
  for (const item of input) {
    if (!isRecord(item)) continue
    const type = item.type ?? "message"
    if (type !== "message") {
      w.warn(`open-responses: input item type ${JSON.stringify(type)} is not supported; skipped`)
      continue
    }
    const text = contentText(item.content, w)
    if (text.trim() === "") continue
    const role = item.role
    if (role === "system" || role === "developer") system.push(text)
    else if (role === "assistant") turns.push(`Assistant: ${text}`)
    else if (role === "user") turns.push(text)
    else w.warn(`open-responses: message role ${JSON.stringify(role)} is not supported; skipped`)
  }
  return { prompt: turns.join("\n\n"), system }
}

/** `reasoning.effort` to a CLI effort level. */
function mapEffort(reasoning: unknown, w: Warnings): string | undefined {
  if (!isRecord(reasoning)) {
    w.warn("open-responses: reasoning is not an object; ignored")
    return undefined
  }
  for (const key of Object.keys(reasoning)) {
    if (key !== "effort" && reasoning[key] !== null && reasoning[key] !== undefined) {
      w.warn(`open-responses: reasoning.${key} is not supported; ignored`)
    }
  }
  const effort = reasoning.effort
  if (effort === undefined || effort === null) return undefined
  if (effort === "none") {
    w.note('open-responses: reasoning.effort "none" maps to "low", the lowest CLI effort level')
    return "low"
  }
  if (typeof effort === "string" && EFFORT_LEVELS.has(effort)) return effort
  w.warn(`open-responses: reasoning.effort ${JSON.stringify(effort)} is not supported; ignored`)
  return undefined
}

/** `text.format` to an output schema and strict. */
function mapTextFormat(
  text: unknown,
  w: Warnings,
): { readonly outputSchema?: object; readonly strict?: boolean } {
  if (!isRecord(text)) {
    w.warn("open-responses: text is not an object; ignored")
    return {}
  }
  for (const key of Object.keys(text)) {
    if (key !== "format" && text[key] !== null && text[key] !== undefined) {
      w.warn(`open-responses: text.${key} is not supported; ignored`)
    }
  }
  const format = text.format
  if (format === undefined || format === null) return {}
  if (!isRecord(format)) {
    w.warn("open-responses: text.format is not an object; ignored")
    return {}
  }
  if (format.type === "text") return {}
  if (format.type === "json_object") {
    w.warn(
      "open-responses: text.format json_object (JSON with no schema) is not supported; send json_schema instead. Running as plain text",
    )
    return {}
  }
  if (format.type !== "json_schema") {
    w.warn(
      `open-responses: text.format type ${JSON.stringify(format.type)} is not supported; ignored`,
    )
    return {}
  }
  if (!isRecord(format.schema)) {
    w.warn("open-responses: text.format.schema is not an object; ignored")
    return {}
  }
  const schema: Record<string, unknown> = { ...format.schema }
  if (typeof schema.title !== "string" && typeof format.name === "string" && format.name !== "") {
    schema.title = format.name
  }
  return format.strict === true ? { outputSchema: schema, strict: true } : { outputSchema: schema }
}

/**
 * Parse one OR request (the raw stdin text). Pure. Returns an error for
 * bad JSON, a non-object body, a missing input, or an empty prompt. Every
 * other problem is a warn line.
 */
export function parseOrRequest(json: string): ({ readonly ok: true } & OrRequest) | OrInputError {
  let body: unknown
  try {
    body = JSON.parse(json)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `--input-format open-responses: stdin is not valid JSON: ${msg}` }
  }
  if (!isRecord(body)) {
    return {
      ok: false,
      message: "--input-format open-responses: the request on stdin must be a JSON object",
    }
  }
  if (body.input === undefined || body.input === null) {
    return { ok: false, message: "--input-format open-responses: the request has no input" }
  }

  const w = new Warnings()
  for (const key of Object.keys(body)) {
    if (READ_FIELDS.has(key) || SILENT_FIELDS.has(key)) continue
    if (body[key] === null || body[key] === undefined) continue
    w.warn(`open-responses: field ${JSON.stringify(key)} is not supported; ignored`)
  }

  const input = mapInput(body.input, w)
  if (input.prompt.trim() === "") {
    return {
      ok: false,
      message: "--input-format open-responses: the request input has no user text",
    }
  }

  const system: string[] = []
  if (typeof body.instructions === "string") {
    if (body.instructions.trim() !== "") system.push(body.instructions)
  } else if (body.instructions !== undefined && body.instructions !== null) {
    w.warn("open-responses: instructions is not a string; ignored")
  }
  system.push(...input.system)

  let model: string | undefined
  if (typeof body.model === "string" && body.model.trim() !== "") model = body.model.trim()
  else if (body.model !== undefined && body.model !== null && body.model !== "") {
    w.warn("open-responses: model is not a string; ignored")
  }

  let temperature: number | undefined
  if (typeof body.temperature === "number" && Number.isFinite(body.temperature)) {
    temperature = body.temperature
  } else if (body.temperature !== undefined && body.temperature !== null) {
    w.warn("open-responses: temperature is not a finite number; ignored")
  }

  if (body.top_p !== undefined && body.top_p !== null) {
    w.warn("open-responses: top_p is not supported by this CLI; ignored")
  }
  if (body.max_output_tokens !== undefined && body.max_output_tokens !== null) {
    w.warn(
      "open-responses: max_output_tokens is not supported by this CLI (core sets the model limit); ignored",
    )
  }
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    w.warn("open-responses: previous_response_id is not supported (stateless run); ignored")
  }

  const effort =
    body.reasoning !== undefined && body.reasoning !== null
      ? mapEffort(body.reasoning, w)
      : undefined
  const format = body.text !== undefined && body.text !== null ? mapTextFormat(body.text, w) : {}

  return {
    ok: true,
    prompt: input.prompt,
    ...(system.length > 0 ? { appendSystemPrompt: system.join("\n\n") } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...format,
    stream: body.stream === true,
    warnings: w.lines,
  }
}

/** The request mapped onto the CLI argv. */
export interface OrArgvPlan {
  /** The raw argv plus the injected flags and the `-` prompt sentinel. */
  readonly argv: readonly string[]
  /** Append text from the request, merged after any flag text by the one-shot setup. */
  readonly appendSystemPrompt: string | undefined
  /** Precedence notes for stderr, each with a trailing newline. */
  readonly notes: readonly string[]
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag)
}

/**
 * Map a parsed request onto the raw argv. Pure. A CLI flag that is already
 * there wins over the request value (one stderr note). The `-` sentinel
 * marks the run as a one-shot prompt run. The prompt text itself does not
 * go into argv: the entry point takes it from {@link OrInputSetup}.
 */
export function planOrArgv(rawArgv: readonly string[], request: OrRequest): OrArgvPlan {
  const norm = normalizeArgs([...rawArgv])
  const extra: string[] = []
  const notes: string[] = []
  const flagWins = (flag: string, field: string): void => {
    notes.push(`${NOTE} the ${flag} flag wins over the request ${field}\n`)
  }

  if (request.model !== undefined) {
    if (hasFlag(norm, "--model")) flagWins("--model", "model")
    else if (request.model.startsWith("-")) {
      notes.push(`${WARN} open-responses: model ${JSON.stringify(request.model)} ignored\n`)
    } else extra.push("--model", request.model)
  }
  if (request.temperature !== undefined) {
    if (hasFlag(norm, "--temperature")) flagWins("--temperature", "temperature")
    else extra.push("--temperature", String(request.temperature))
  }
  if (request.effort !== undefined) {
    if (hasFlag(norm, "--effort")) flagWins("--effort", "reasoning.effort")
    else extra.push("--effort", request.effort)
  }
  if (request.outputSchema !== undefined) {
    if (hasFlag(norm, "--output-schema")) flagWins("--output-schema", "text.format")
    else {
      extra.push("--output-schema", JSON.stringify(request.outputSchema))
      if (request.strict === true && !hasFlag(norm, "--strict")) extra.push("--strict")
    }
  }
  if (!hasFlag(norm, "-")) extra.push("-")
  return {
    argv: [...rawArgv, ...extra],
    appendSystemPrompt: request.appendSystemPrompt,
    notes,
  }
}

/** What the entry point gets from {@link prepareOrInput}. */
export interface OrInputSetup {
  /** The argv to parse (unchanged when the input format is `text`). */
  readonly argv: readonly string[]
  /** The prompt from the request, else `undefined` (use the normal prompt source). */
  readonly prompt: string | undefined
  /** The request `stream` value. `false` when the input format is `text`. */
  readonly stream: boolean
  /**
   * Add the request append text (as `orAppendSystemPrompt`) and the request
   * `stream: true` (as `orStream`) to the one-shot options. `setupOneShot`
   * puts `orStream` on its `runOptions`, which the run reads. Returns `opts`
   * unchanged when there is neither.
   */
  readonly withAppend: <T extends object>(
    opts: T,
  ) => T & { readonly orAppendSystemPrompt?: string; readonly orStream?: boolean }
}

/** Entry-point I/O for {@link prepareOrInput}. */
export interface OrInputIo {
  readonly argv: readonly string[]
  readonly exit: (code: number) => never
  readonly stderr?: { readonly write: (chunk: string) => unknown }
  /** Defaults to `process.stdin`. */
  readonly stdin?: AsyncIterable<string | Uint8Array>
}

const PASSTHROUGH = (argv: readonly string[]): OrInputSetup => ({
  argv,
  prompt: undefined,
  stream: false,
  withAppend: (opts) => opts,
})

async function readAll(stdin: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf-8")
}

/**
 * Entry-point glue. With `--input-format open-responses`: read stdin, parse
 * the request, write warns and notes to stderr, and return the new argv
 * and the prompt. On a user error write the message and exit 2. Any other
 * input format (or `--help`) returns the argv unchanged and reads nothing.
 */
export async function prepareOrInput(io: OrInputIo): Promise<OrInputSetup> {
  const norm = normalizeArgs([...io.argv])
  if (norm.includes("--help") || norm.includes("-h")) return PASSTHROUGH(io.argv)
  let format: string
  try {
    format = parseInputFormat(norm)
  } catch {
    // A bad value: `parseCliOptions` reports it later, with exit 2.
    return PASSTHROUGH(io.argv)
  }
  if (format !== "open-responses") return PASSTHROUGH(io.argv)

  const write = (chunk: string): void => {
    if (io.stderr) io.stderr.write(chunk)
    else process.stderr.write(chunk)
  }
  const fail = (message: string): never => {
    write(`${message}\n`)
    return io.exit(2)
  }

  if (extractPromptFromArgs(norm).kind === "literal") {
    return fail(
      "--input-format open-responses: do not pass -p or a positional prompt; the prompt comes from the request on stdin",
    )
  }
  const parsed = parseOrRequest(await readAll(io.stdin ?? process.stdin))
  if (!parsed.ok) return fail(parsed.message)
  for (const line of parsed.warnings) write(line)
  const plan = planOrArgv(io.argv, parsed)
  for (const line of plan.notes) write(line)
  const append = plan.appendSystemPrompt
  const stream = parsed.stream
  return {
    argv: plan.argv,
    prompt: parsed.prompt,
    stream,
    withAppend: (opts) => ({
      ...opts,
      ...(append !== undefined ? { orAppendSystemPrompt: append } : {}),
      ...(stream ? { orStream: true } : {}),
    }),
  }
}
