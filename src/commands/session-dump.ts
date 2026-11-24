import type { SidebandApi } from "@minimal-agent/core/host/sideband"
import type { MetaRecord } from "@minimal-agent/core/host-kit/session-store"
import {
  displayMarkdown,
  displayXml,
  xmlSafe,
} from "@minimal-agent/core/plugin-api/utils/display-format"
import type { ContentBlock, Message, TextBlock } from "@minimal-agent/core/sdk/messages"

import { type ScrubSideband, scrubEmbeddedPayloads } from "./embedded-payload-scrub-port.ts"

/** Data a dump needs: the meta record and the model-facing messages. */
export interface DumpSessionData {
  meta: MetaRecord | null
  messages: readonly Message[]
}

type LoadedSession = DumpSessionData

/**
 * The sideband slice of a dump: the data-URI scrub and the display of the
 * sideband refs in user text. `display` is optional: a slice with no
 * `display` keeps the user text as is.
 */
export type DumpSideband = ScrubSideband & Partial<Pick<SidebandApi, "display">>

/** Dump options. */
export interface DumpOptions {
  /**
   * The dumped sid. The display handlers read the files of this session
   * (for example a paste). Absent: a handler uses the attrs only.
   */
  sid?: string
}

/** The display segments of a user text, or null when no node has a display. */
function displaySegments(text: string, sb: DumpSideband, opts: DumpOptions) {
  if (sb.display === undefined || text.length === 0) return null
  const r = sb.display(
    text,
    opts.sid === undefined ? { mode: "full" } : { mode: "full", sid: opts.sid },
  )
  return r.changed ? r.segments : null
}

/** User text with each sideband ref as its display (markdown). No display: the text as is. */
function userTextMarkdown(text: string, sb: DumpSideband, opts: DumpOptions): string {
  const segs = displaySegments(text, sb, opts)
  return segs === null ? text : displayMarkdown(segs)
}

/** User text with each sideband ref as a `display` element (XML content). */
function userTextXml(text: string, sb: DumpSideband, opts: DumpOptions): string {
  const segs = displaySegments(text, sb, opts)
  return segs === null ? escapeXml(text) : displayXml(segs, escapeXml)
}

/**
 * True for user text that a person wrote: a text block with no harness
 * `sideband` mark (a compaction or a hook note keeps its raw form). A
 * `null` mark is no mark: the same rule as the SessionHistory dump and the
 * paste send hook.
 */
function isUserText(block: ContentBlock): block is TextBlock {
  return block.type === "text" && (block.sideband === undefined || block.sideband === null)
}

/**
 * Redact oversized `data:*;base64,...` URIs in tool_result text for human
 * dumps. The sideband codec renders the stubs.
 */
function scrubDumpText(s: string, sb: ScrubSideband): string {
  const r = scrubEmbeddedPayloads(s, sb)
  return r.changed ? r.text : s
}

/**
 * Format a session as a human-readable Markdown string.
 *
 * @param session - The meta record and the messages.
 * @param sb - The sideband slice for the data-URI scrub and the display of sideband refs (`loadSidebandOnly()`).
 * @param opts - The dumped sid (for the display handlers).
 */
export function formatSessionAsMarkdown(
  session: LoadedSession,
  sb: DumpSideband,
  opts: DumpOptions = {},
): string {
  let out = ""

  if (session.meta) {
    out += `# Session: ${session.meta.sid}\n`
    out += `**Model**: ${session.meta.model}\n`
    out += `**Date**: ${session.meta.createdAt}\n`
    out += `**CWD**: \`${session.meta.cwd}\`\n\n`
  }

  for (const msg of session.messages) {
    const role = msg.role === "user" ? "User" : "Assistant"
    out += `## ${role}\n\n`
    const isUser = msg.role === "user"

    if (typeof msg.content === "string") {
      out += (isUser ? userTextMarkdown(msg.content, sb, opts) : msg.content) + "\n\n"
    } else {
      for (const block of msg.content) {
        const md =
          isUser && isUserText(block)
            ? userTextMarkdown(block.text, sb, opts)
            : formatBlockAsMarkdown(block, sb)
        out += md + "\n\n"
      }
    }
  }

  return out.trim() + "\n"
}

function formatBlockAsMarkdown(block: ContentBlock, sb: ScrubSideband): string {
  switch (block.type) {
    case "text":
      return block.text
    case "thinking": {
      let bq = `> 🤔 **Thinking**\n`
      if (block.thinking) {
        bq += block.thinking
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")
      } else {
        bq += `> *(Redacted thinking, signature: ${block.signature.slice(0, 16)}...)*`
      }
      return bq
    }
    case "redacted_thinking":
      return `> 🔒 **Redacted thinking** *(encrypted, ${block.data.length} chars)*`
    case "tool_use": {
      let bq = `> 🛠️ **Tool Use**: \`${block.name}\` (id: ${block.id})\n`
      bq += `> \`\`\`json\n`
      bq += JSON.stringify(block.input, null, 2)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")
      bq += `\n> \`\`\``
      return bq
    }
    case "tool_result": {
      let bq = `> 🔙 **Tool Result**: (id: ${block.tool_use_id})`
      if (block.is_error) bq += ` **[ERROR]**`
      bq += "\n"

      let contentStr = ""
      if (typeof block.content === "string") {
        contentStr = scrubDumpText(block.content, sb)
      } else {
        contentStr = scrubDumpText(
          block.content
            .filter((b) => b.type === "text")
            .map((b) => (b as TextBlock).text)
            .join("\n"),
          sb,
        )
      }

      if (contentStr) {
        bq += `> \`\`\`\n`
        bq += contentStr
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")
        bq += `\n> \`\`\``
      } else {
        bq += `> *(Empty result)*`
      }
      return bq
    }
    case "image": {
      const s = block.source
      const detail = s.type === "base64" ? s.media_type : s.type === "url" ? s.url : s.file_id
      return `> 🖼️ **Image**: (${s.type} ${detail})`
    }
    case "document": {
      const s = block.source
      const detail =
        s.type === "file"
          ? s.file_id
          : s.type === "base64"
            ? s.media_type
            : s.type === "url"
              ? s.url
              : "text/plain"
      return `> 📄 **Document**: (${s.type} ${detail})`
    }
    default: {
      return `> *(Unknown block: ${JSON.stringify(block satisfies never)})*`
    }
  }
}

/**
 * Format a session as a structured XML string.
 *
 * @param session - The meta record and the messages.
 * @param sb - The sideband slice for the data-URI scrub and the display of sideband refs (`loadSidebandOnly()`).
 * @param opts - The dumped sid (for the display handlers).
 */
export function formatSessionAsXml(
  session: LoadedSession,
  sb: DumpSideband,
  opts: DumpOptions = {},
): string {
  let out = ""

  if (session.meta) {
    out += `<session id="${escapeXml(session.meta.sid)}" model="${escapeXml(session.meta.model)}" date="${escapeXml(session.meta.createdAt)}">\n`
  } else {
    out += `<session>\n`
  }

  for (const msg of session.messages) {
    out += `  <turn role="${escapeXml(msg.role)}">\n`
    const isUser = msg.role === "user"

    if (typeof msg.content === "string") {
      const body = isUser ? userTextXml(msg.content, sb, opts) : escapeXml(msg.content)
      out += `    <text>${body}</text>\n`
    } else {
      for (const block of msg.content) {
        const xml =
          isUser && isUserText(block)
            ? `    <text>${userTextXml(block.text, sb, opts)}</text>`
            : formatBlockAsXml(block, 4, sb)
        out += xml + "\n"
      }
    }
    out += `  </turn>\n`
  }

  out += `</session>\n`
  return out
}

function formatBlockAsXml(block: ContentBlock, indent: number, sb: ScrubSideband): string {
  const pad = " ".repeat(indent)
  switch (block.type) {
    case "text":
      return `${pad}<text>${escapeXml(block.text)}</text>`
    case "thinking": {
      if (block.thinking) {
        return `${pad}<thinking>${escapeXml(block.thinking)}</thinking>`
      }
      return `${pad}<thinking signature="${escapeXml(block.signature)}"/>`
    }
    case "redacted_thinking":
      return `${pad}<redacted_thinking bytes="${block.data.length}"/>`
    case "tool_use": {
      const inputStr =
        typeof block.input === "object" ? JSON.stringify(block.input) : String(block.input)
      return (
        `${pad}<tool_use name="${escapeXml(block.name)}" id="${escapeXml(block.id)}">\n` +
        `${pad}  <input>${escapeXml(inputStr)}</input>\n` +
        `${pad}</tool_use>`
      )
    }
    case "tool_result": {
      const isErrorAttr = block.is_error ? ` is_error="true"` : ""
      let contentStr = ""
      if (typeof block.content === "string") {
        contentStr = scrubDumpText(block.content, sb)
      } else {
        contentStr = scrubDumpText(
          block.content
            .filter((b) => b.type === "text")
            .map((b) => (b as TextBlock).text)
            .join("\n"),
          sb,
        )
      }

      return (
        `${pad}<tool_result tool_use_id="${escapeXml(block.tool_use_id)}"${isErrorAttr}>\n` +
        `${pad}  <content>${escapeXml(contentStr)}</content>\n` +
        `${pad}</tool_result>`
      )
    }
    case "image": {
      const s = block.source
      const ref = s.type === "base64" ? s.media_type : s.type === "url" ? s.url : s.file_id
      return `${pad}<image source="${escapeXml(s.type)}" ref="${escapeXml(ref)}" />`
    }
    case "document": {
      const s = block.source
      const ref =
        s.type === "file"
          ? s.file_id
          : s.type === "base64"
            ? s.media_type
            : s.type === "url"
              ? s.url
              : "text/plain"
      return `${pad}<document source="${escapeXml(s.type)}" ref="${escapeXml(ref)}" />`
    }
    default: {
      return `${pad}<unknown>${escapeXml(JSON.stringify(block satisfies never))}</unknown>`
    }
  }
}

/** XML escape. It also removes each char that XML 1.0 does not allow (`xmlSafe`). */
function escapeXml(unsafe: string): string {
  return xmlSafe(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}
