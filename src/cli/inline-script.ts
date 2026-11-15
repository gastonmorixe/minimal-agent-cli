/**
 * Recognise and decompose a **one-line inline script** so the transcript can
 * render it as if the model had written real newlines.
 *
 * # Why this module exists
 *
 * The Bash transcript has two decomposition strategies: split at `\n`
 * (`formatToolInputContinuation` "Zone B") and split at top-level shell
 * operators (`bash-split.ts`). A command like
 *
 *     uv run --no-project python -c 'from pathlib import Path; p = Path("…"); s = p.read_text(); …'
 *
 * has neither: it is a single line (no `\n`) and its `;` separators live
 * *inside single quotes*, so `splitBashSegments` correctly refuses to split
 * them. The header then hard-cut at the terminal width and the user lost
 * every statement of the script — which is exactly the content worth reading.
 *
 * This module supplies the missing third strategy: find the quoted script
 * payload, then split *it* at depth-0 `;` / `\n`. The renderer can then paint
 * the prologue plus statement rows, the same shape a genuinely multi-line
 * command already produces.
 *
 * # Purity
 *
 * No rendering, no terminal state, no I/O: `string` in, plain objects out.
 * Same contract as `bash-split.ts`, and for the same reasons (reusable by a
 * replay viewer, a tool-call log, or a history browser; trivially testable).
 *
 * # What this module does NOT try to do
 *
 * - It is **not** a shell parser. It looks for one top-level quoted region and
 *   checks whether the token before it is a known inline-script flag (`-c`,
 *   `-e`, `--eval`, …) or whether the program itself is a known
 *   script-carrying binary (`jq`, `awk`, `sed`).
 * - It never rewrites, unescapes, or re-quotes the payload. The bytes the
 *   user (and the model) wrote are what get rendered.
 * - It ignores multi-line commands entirely. A real `\n` already takes the
 *   Zone B path, which is the better render for heredocs and inline scripts
 *   with genuine newlines.
 *
 * @module cli/inline-script
 */

/**
 * Flags whose *next* shell word is a program payload rather than a normal
 * argument: `sh -c`, `bash -c`, `python -c`, `node -e`, `perl -e`,
 * `ruby -e`, `nix-shell --command`.
 */
const SCRIPT_FLAGS: ReadonlySet<string> = new Set([
  "-c",
  "-e",
  "-E",
  "--eval",
  "--command",
  "--execute",
])

/**
 * Programs that take their script as a bare positional argument with no
 * flag in front of it. Kept deliberately short: these are the ones that show
 * up in practice as long one-liners through Bash.
 */
const SCRIPT_BINARIES: ReadonlySet<string> = new Set(["awk", "jq", "sed"])

/**
 * Minimum number of `;`-separated statements before unwrapping is worth the
 * rows. A single-statement payload gains nothing from being broken out (the
 * renderer would emit the prologue row plus one row that says the same thing),
 * so we leave it on the plain truncation path.
 */
export const MIN_INLINE_SCRIPT_STATEMENTS = 2

/** A quote-delimited region found at shell top level. */
type QuoteSpan = {
  /** The opening quote character. */
  quote: "'" | '"'
  /** Index of the opening quote in the source string. */
  start: number
  /** Index of the matching closing quote in the source string. */
  end: number
}

/**
 * A one-line command decomposed into prologue / payload / epilogue.
 *
 * For `uv run python -c 'a; b; c'` the three parts are
 * `uv run python -c '`, `a; b; c`, and `'`.
 *
 * `prologue` ends with the opening quote and `epilogue` begins with the
 * closing quote, so `prologue + payload + epilogue` reconstructs the original
 * command byte for byte. Rendering can therefore print the prologue on the
 * header row, the statements as continuation rows, and the epilogue as a
 * closing row, without ever losing or duplicating a quote.
 */
export type InlineScript = {
  /** Text up to and including the opening quote, verbatim. */
  prologue: string
  /** The script body, verbatim (escapes untouched). */
  payload: string
  /** Text from the closing quote onward, verbatim. Never empty. */
  epilogue: string
  /** The quote character that delimits the payload. */
  quote: "'" | '"'
  /** Depth-0 statements, in source order. Never empty. */
  statements: string[]
}

/**
 * Find every quote-delimited region that starts at shell top level.
 *
 * "Top level" means outside another quote and outside `$( )`, `${ }`, and
 * `( )` nesting. Backticks are treated as ordinary characters: the payloads
 * this module handles are single- or double-quoted.
 *
 * An unterminated quote is reported with `end` pointing at the last index, so
 * callers see a span rather than an exception. The renderer never throws on
 * malformed model output.
 */
function findTopLevelQuoteSpans(cmd: string): QuoteSpan[] {
  const spans: QuoteSpan[] = []
  let depth = 0
  let i = 0
  while (i < cmd.length) {
    const ch = cmd[i]
    if (ch === "\\") {
      i += 2
      continue
    }
    if (ch === "$" && i + 1 < cmd.length && (cmd[i + 1] === "(" || cmd[i + 1] === "{")) {
      depth += 1
      i += 2
      continue
    }
    if (ch === "(" || ch === "{") {
      depth += 1
      i += 1
      continue
    }
    if ((ch === ")" || ch === "}") && depth > 0) {
      depth -= 1
      i += 1
      continue
    }
    if (depth === 0 && (ch === "'" || ch === '"')) {
      const quote = ch as "'" | '"'
      const start = i
      let j = i + 1
      while (j < cmd.length) {
        if (quote === '"' && cmd[j] === "\\") {
          j += 2
          continue
        }
        if (cmd[j] === quote) break
        j += 1
      }
      const end = Math.min(j, cmd.length - 1)
      spans.push({ quote, start, end })
      i = j + 1
      continue
    }
    i += 1
  }
  return spans
}

/** The last whitespace-separated token of `head`, or `""` when it has none. */
function lastToken(head: string): string {
  const trimmed = head.trimEnd()
  if (trimmed.length === 0) return ""
  const idx = trimmed.search(/\s\S*$/)
  return idx < 0 ? trimmed : trimmed.slice(idx).trim()
}

/** The first whitespace-separated token of `head`, basename only. */
function firstBinary(head: string): string {
  const trimmed = head.trim()
  if (trimmed.length === 0) return ""
  const token = trimmed.split(/\s+/)[0] ?? ""
  const slash = token.lastIndexOf("/")
  return slash >= 0 ? token.slice(slash + 1) : token
}

/**
 * Split a script payload at depth-0 `;` and newlines.
 *
 * Quote-, escape-, and bracket-aware: a `;` inside `'…'`, `"…"`, `(…)`,
 * `[…]`, or `{…}` is part of the statement, not a separator. A `#` at a word
 * boundary swallows the rest of the line (Python / shell comment), so a
 * trailing comment cannot manufacture a phantom statement.
 *
 * Empty statements are dropped, which is what makes `for x in y:\n  pass` and
 * `a; b;` (trailing separator) both come out clean.
 *
 * @param payload - The raw script body, quotes already stripped by the caller.
 * @returns Trimmed statements in source order. Empty for a blank payload.
 *
 * @example
 * ```ts
 * splitScriptStatements("a; b(c; d); e")
 * // → ["a", "b(c; d)", "e"]
 * splitScriptStatements("for l in rows:\n  print(l)")
 * // → ["for l in rows:", "print(l)"]
 * ```
 */
export function splitScriptStatements(payload: string): string[] {
  const out: string[] = []
  let buf = ""
  let quote: '"' | "'" | "`" | null = null
  let depth = 0

  const flush = (): void => {
    const body = buf.trim()
    if (body.length > 0) out.push(body)
    buf = ""
  }

  let i = 0
  while (i < payload.length) {
    const ch = payload[i]

    // Inside a quoted region nothing separates statements. Double quotes
    // honour backslash escapes; single quotes are literal by definition.
    if (quote !== null) {
      if (ch === "\\" && quote === '"' && i + 1 < payload.length) {
        buf += ch + payload[i + 1]
        i += 2
        continue
      }
      if (ch === quote) quote = null
      buf += ch
      i += 1
      continue
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
      buf += ch
      i += 1
      continue
    }

    // Backslash escape outside quotes: consume the next char verbatim.
    if (ch === "\\") {
      buf += ch
      if (i + 1 < payload.length) {
        buf += payload[i + 1]
        i += 2
      } else {
        i += 1
      }
      continue
    }

    // Comment at a word boundary: runs to end of line. The line break is
    // left for the normal `\n` flush below, so a pure comment line becomes
    // its own row instead of gluing onto the next statement.
    if (ch === "#" && (buf.length === 0 || /\s$/.test(buf))) {
      const nl = payload.indexOf("\n", i)
      const stop = nl === -1 ? payload.length : nl
      buf += payload.slice(i, stop)
      i = stop
      continue
    }

    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1
      buf += ch
      i += 1
      continue
    }
    if ((ch === ")" || ch === "]" || ch === "}") && depth > 0) {
      depth -= 1
      buf += ch
      i += 1
      continue
    }

    if (depth === 0 && (ch === ";" || ch === "\n")) {
      flush()
      i += 1
      continue
    }

    buf += ch
    i += 1
  }

  flush()
  return out
}

/**
 * Recognise a one-line inline script and split its payload into statements.
 *
 * Returns `null` for everything else: multi-line commands (Zone B owns
 * those), commands with no top-level quoted region, and quoted arguments that
 * do not follow a script flag or a script-carrying binary.
 *
 * Acceptance rules, in order:
 *  1. The command must be a single line.
 *  2. The first top-level quoted region must be preceded by a
 *     {@link SCRIPT_FLAGS} token (`python -c '…'`), **or** the command's first
 *     word must be a {@link SCRIPT_BINARIES} program (`jq '…'`).
 *  3. The payload must yield at least {@link MIN_INLINE_SCRIPT_STATEMENTS}
 *     statements. One-statement payloads gain nothing from unwrapping.
 *
 * Width is deliberately **not** considered here: the caller decides whether
 * the header overflows, because only it knows the terminal width and the
 * `· HH:MM:SS` suffix. Keeping the predicate width-free makes this module
 * usable by a reflow pass that runs at a different width.
 *
 * @param command - A Bash `command` input string.
 * @returns The decomposition, or `null` when the command is not an inline
 *          script this module can help with.
 *
 * @example
 * ```ts
 * detectInlineScript("python -c 'a = 1; b = 2'")
 * // → { prologue: "python -c '", payload: "a = 1; b = 2", epilogue: "",
 * //     quote: "'", statements: ["a = 1", "b = 2"] }
 * detectInlineScript("ls -la")
 * // → null
 * ```
 */
export function detectInlineScript(command: string): InlineScript | null {
  if (command.length === 0) return null
  if (command.includes("\n")) return null

  const span = findTopLevelQuoteSpans(command)[0]
  if (span === undefined) return null

  const head = command.slice(0, span.start)
  const payload = command.slice(span.start + 1, span.end)
  if (payload.trim().length === 0) return null

  const flagMatch = SCRIPT_FLAGS.has(lastToken(head))
  const binaryMatch = SCRIPT_BINARIES.has(firstBinary(head))
  if (!flagMatch && !binaryMatch) return null

  const statements = splitScriptStatements(payload)
  if (statements.length < MIN_INLINE_SCRIPT_STATEMENTS) return null

  return {
    prologue: command.slice(0, span.start + 1),
    payload,
    epilogue: command.slice(span.end),
    quote: span.quote,
    statements,
  }
}
