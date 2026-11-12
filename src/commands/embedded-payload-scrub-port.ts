/**
 * Local port of the data-URI scrub in core `src/tools/embedded-payload-scrub.ts`.
 * Core exports no public scrub function.
 *
 * TODO(S2.6): S2.6 owns the final home of this function. Replace this port then.
 *
 * @module commands/embedded-payload-scrub-port
 */

const MIN_BASE64_CHARS = 256

const DATA_URI_RE =
  /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)((?:;[a-zA-Z0-9=._+-]+)*)?(;base64),([A-Za-z0-9+/=]+)/gi

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kB`
  return `${(n / 1024 / 1024).toFixed(2)}MB`
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

export interface ScrubResult {
  text: string
  changed: boolean
}

/** Replace oversized `data:*;base64,` URIs with redacted-asset stubs plus one footer. */
export function scrubEmbeddedPayloads(input: string): ScrubResult {
  if (input.length === 0 || !input.includes("data:")) return { text: input, changed: false }
  let removed = 0
  let charsRemoved = 0
  let savedBytes = 0
  const text = input.replace(
    DATA_URI_RE,
    (full, mime: string, _params: string, _flag: string, payload: string) => {
      const b64 = payload.replace(/\s+/g, "")
      if (b64.length < MIN_BASE64_CHARS) return full
      const approxBytes = Math.floor((b64.length * 3) / 4)
      removed++
      charsRemoved += b64.length
      savedBytes += approxBytes
      return (
        `<ma::agent::redacted-asset kind="data_uri" mime="${escapeAttr(mime.toLowerCase())}" ` +
        `size="${escapeAttr(formatBytes(approxBytes))}" chars_removed="${b64.length}" />`
      )
    },
  )
  if (removed === 0) return { text: input, changed: false }
  const withoutPriorFooter = text.replace(/\n*\n<ma::agent::context-sanitizer\b[^>]*\/>\s*$/u, "")
  const footer =
    `<ma::agent::context-sanitizer removed="${removed}" ` +
    `kinds="data_uri" chars_removed="${charsRemoved}" ` +
    `saved="${escapeAttr(formatBytes(savedBytes))}" />`
  return { text: `${withoutPriorFooter}\n\n${footer}`, changed: true }
}
