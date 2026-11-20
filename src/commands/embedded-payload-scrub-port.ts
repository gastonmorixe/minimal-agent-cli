/**
 * Local port of the data-URI scrub in core `src/tools/embedded-payload-scrub.ts`.
 * Core exports no public scrub function.
 *
 * TODO(S2.6): S2.6 owns the final home of this function. Replace this port then.
 *
 * @module commands/embedded-payload-scrub-port
 */

import type { SidebandApi } from "@minimal-agent/core/host/sideband"

const MIN_BASE64_CHARS = 256

const DATA_URI_RE =
  /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)((?:;[a-zA-Z0-9=._+-]+)*)?(;base64),([A-Za-z0-9+/=]+)/gi

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kB`
  return `${(n / 1024 / 1024).toFixed(2)}MB`
}

export interface ScrubResult {
  text: string
  changed: boolean
}

/** The sideband slice that the scrub uses: render the stubs, strip an old footer. */
export type ScrubSideband = Pick<SidebandApi, "render" | "trailing">

/** The sideband kind of one stub. */
const STUB_KIND = "redacted-asset"
/** The sideband kind of the footer. */
const FOOTER_KIND = "context-sanitizer"

/**
 * Replace oversized `data:*;base64,` URIs with redacted-asset stubs plus one
 * footer. The codec renders the stub and the footer (kinds `redacted-asset`
 * and `context-sanitizer`). With no codec (`render` gives `""`), the text
 * does not change.
 */
export function scrubEmbeddedPayloads(input: string, sb: ScrubSideband): ScrubResult {
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
      const stub = sb.render(STUB_KIND, {
        attrs: {
          kind: "data_uri",
          mime: mime.toLowerCase(),
          size: formatBytes(approxBytes),
          "chars-removed": b64.length,
        },
      })
      if (stub === "") return full
      removed++
      charsRemoved += b64.length
      savedBytes += approxBytes
      return stub
    },
  )
  if (removed === 0) return { text: input, changed: false }
  const footer = sb.render(FOOTER_KIND, {
    attrs: {
      removed,
      kinds: "data_uri",
      "chars-removed": charsRemoved,
      saved: formatBytes(savedBytes),
    },
  })
  return { text: `${withoutPriorFooter(text, sb)}\n\n${footer}`, changed: true }
}

/**
 * `text` without an earlier footer at its end, and without the line feeds
 * before that footer. Only a footer that is the last node of the annotation
 * region counts.
 */
function withoutPriorFooter(text: string, sb: ScrubSideband): string {
  const { nodes } = sb.trailing(text)
  const last = nodes[nodes.length - 1]
  if (last === undefined || last.kind !== FOOTER_KIND || !last.selfClosing) return text
  let start = last.span.start
  while (start > 0 && text[start - 1] === "\n") start--
  // The old rule needed one line feed or more before the footer.
  return start === last.span.start ? text : text.slice(0, start)
}
