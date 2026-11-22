/**
 * Atomic chips for inline sideband nodes (paste plugin v3, D2; PLAN D1).
 *
 * The editor buffer holds the codec form of a node (the wire text). The CLI
 * shows each top-level node of a registered inline to-model kind as a short
 * label, a "chip", and moves, deletes and wraps it as one unit. This module
 * finds the chips of a text with `sb.find` and gives their labels. It knows
 * no wire form and no kind name.
 *
 * - A plugin (D3, `ctx.chips`) registers a label function for its kind.
 * - A kind with no label gets the fallback label: the node body when it is
 *   short and on one line (an intercom mention gives `@bob`), else `[<kind>]`.
 * - With no codec (`!sb.ready`) there is no chip: the text is plain.
 *
 * The chip is display only. The buffer, the queue, the history and the wire
 * keep the codec form.
 *
 * @module paste/chip-registry
 */

import type {
  SidebandApi,
  SidebandAttrs,
  SidebandNode,
  SidebandReader,
} from "@minimal-agent/core/host/sideband"
import { codePointWidth, displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"

/**
 * One chip of a line. `start` and `end` are code-point offsets into the line
 * (end exclusive), the column model of the editor buffer.
 */
export interface ChipSpan {
  /** First code point of the node. */
  readonly start: number
  /** Code point after the node. */
  readonly end: number
  /** The text to show in place of the node: one line, no control characters. */
  readonly label: string
}

/** The label function of one kind. */
export interface ChipLabelSpec {
  /** The sideband kind name. */
  readonly kind: string
  /**
   * The chip text of one node. `attrs` are the typed values (`sb.attrs`),
   * `body` the node body. `known` is `undefined` in D2 (no store check). A
   * throw or an empty result gives the fallback label.
   */
  label(attrs: SidebandAttrs, body: string | undefined, known?: boolean): string
}

/**
 * The sideband reads that the chip registry uses. With `kinds` and `example`
 * the registry gets the open sigils of the codec, and a line with no sigil
 * skips `find` (a cheap pre-check for a large plain paste).
 */
export type ChipSideband = Pick<SidebandReader, "find" | "kindInfo" | "attrs"> &
  Partial<Pick<SidebandApi, "kinds" | "example">> & {
    readonly ready?: boolean
  }

/**
 * SGR of a chip label: dim cyan, the same family as the other faint editor
 * marks. The editor, the scrollback and the replay use it.
 */
export const CHIP_SGR = "\x1b[2;36m"

/** `label` in the chip style, with a full reset after it. */
export function paintChip(label: string): string {
  return `${CHIP_SGR}${label}\x1b[0m`
}

/** A body longer than this (in code points) is not a fallback label. */
export const CHIP_BODY_LABEL_MAX = 32

/** The widest label in terminal cells. A wider label is cut with `…`. */
export const CHIP_LABEL_MAX = 40

/** The open sigils of each sideband (`null`: no pre-check is possible). */
const sigilCache = new WeakMap<object, readonly string[] | null>()

/**
 * The first code unit of the wire form of each chip kind, from the codec
 * (`sb.example`). Each node starts with one of them. `null` when the codec
 * does not tell.
 */
function openSigils(sb: ChipSideband): readonly string[] | null {
  const hit = sigilCache.get(sb)
  if (hit !== undefined) return hit
  let sigils: string[] | null = null
  if (typeof sb.kinds === "function" && typeof sb.example === "function") {
    try {
      const set = new Set<string>()
      for (const k of sb.kinds({ placement: "inline", direction: "to-model" })) {
        const first = sb.example(k.kind).charAt(0)
        if (first === "") throw new Error("no example")
        set.add(first)
      }
      sigils = [...set]
    } catch {
      sigils = null
    }
  }
  sigilCache.set(sb, sigils)
  return sigils
}

/**
 * The chip registry of one CLI process. Each label is generic: the registry
 * has no kind of its own.
 */
export class ChipRegistry {
  private readonly specs = new Map<string, ChipLabelSpec>()
  private readonly listeners = new Set<() => void>()

  /**
   * Register the label of one kind. A second register for the same kind
   * replaces the first. Returns the unregister function, which removes this
   * spec only.
   */
  register(spec: ChipLabelSpec): () => void {
    this.specs.set(spec.kind, spec)
    this.changed()
    return () => {
      if (this.specs.get(spec.kind) !== spec) return
      this.specs.delete(spec.kind)
      this.changed()
    }
  }

  /**
   * Call `fn` after each register or unregister, so a view can compute its
   * chips again. Returns the unsubscribe function.
   */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /**
   * The chips of one line, in text order. Only the top-level nodes of a kind
   * whose `kindInfo` is inline and to-model. No codec gives `[]`.
   */
  spansOf(line: string, sb: ChipSideband | null | undefined): ChipSpan[] {
    const nodes = this.chipNodes(line, sb)
    if (nodes.length === 0) return []
    const spans: ChipSpan[] = []
    const map = codePointMapper(line)
    for (const node of nodes) {
      spans.push({
        start: map(node.span.start),
        end: map(node.span.end),
        label: this.labelOf(node, sb as ChipSideband),
      })
    }
    return spans
  }

  /**
   * `text` with each chip node replaced by its label. Display only: never
   * send or store the result. `paint` (optional) wraps each label, for
   * example in a chip color.
   */
  renderText(
    text: string,
    sb: ChipSideband | null | undefined,
    paint?: (label: string) => string,
  ): string {
    const nodes = this.chipNodes(text, sb)
    if (nodes.length === 0) return text
    let out = ""
    let at = 0
    for (const node of nodes) {
      const label = this.labelOf(node, sb as ChipSideband)
      out += text.slice(at, node.span.start) + (paint ? paint(label) : label)
      at = node.span.end
    }
    return out + text.slice(at)
  }

  /** The label of `node`: the registered one, else the fallback. */
  private labelOf(node: SidebandNode, sb: ChipSideband): string {
    const spec = this.specs.get(node.kind)
    if (spec) {
      try {
        const label = cleanLabel(spec.label(sb.attrs(node), node.body, undefined))
        if (label.length > 0) return label
      } catch {
        // A label function must not break the editor: use the fallback.
      }
    }
    return fallbackChipLabel(node)
  }

  /** The top-level chip nodes of `text`, in text order. */
  private chipNodes(text: string, sb: ChipSideband | null | undefined): SidebandNode[] {
    if (!sb || sb.ready === false || text.length === 0) return []
    const sigils = openSigils(sb)
    if (sigils !== null && !sigils.some((s) => text.includes(s))) return []
    let nodes: SidebandNode[]
    try {
      nodes = sb.find(text)
    } catch {
      return []
    }
    return nodes.filter((n) => {
      if (!(n.span.end > n.span.start)) return false
      const info = sb.kindInfo(n.kind)
      return info?.placement === "inline" && info.direction === "to-model"
    })
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch {
        // A listener error must not stop the other listeners.
      }
    }
  }
}

/**
 * The label of a node with no registered label: the body when it is short
 * and on one line, else `[<kind>]`.
 */
export function fallbackChipLabel(node: Pick<SidebandNode, "kind" | "body">): string {
  const body = node.body?.trim() ?? ""
  if (body.length > 0 && !/[\r\n]/u.test(body) && Array.from(body).length <= CHIP_BODY_LABEL_MAX) {
    const label = cleanLabel(body)
    if (label.length > 0) return label
  }
  return `[${cleanLabel(node.kind) || "?"}]`
}

/**
 * One line that the user sees in full: a tab or a line end gives a space, and
 * the control, format (bidi, zero-width, soft hyphen) and line or paragraph
 * separator characters go. At most {@link CHIP_LABEL_MAX} cells. A label with
 * no visible cell gives `""` (the caller then uses the fallback).
 */
function cleanLabel(label: string): string {
  if (typeof label !== "string") return ""
  const flat = label
    .replace(/[\t\r\n]/gu, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes are what this removes.
    .replace(/[\x00-\x1f\x7f-\x9f]/gu, "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .trim()
  if (flat.length === 0 || displayWidth(flat) === 0) return ""
  if (displayWidth(flat) <= CHIP_LABEL_MAX) return flat
  let out = ""
  let width = 0
  for (const ch of flat) {
    const w = codePointWidth(ch.codePointAt(0) ?? 0)
    if (width + w > CHIP_LABEL_MAX - 1) break
    out += ch
    width += w
  }
  return `${out.trimEnd()}…`
}

/**
 * A function from a UTF-16 offset of `text` (the unit of a sideband span) to
 * its code-point offset. Calls must use offsets that do not go down.
 */
function codePointMapper(text: string): (utf16: number) => number {
  let unit = 0
  let cp = 0
  return (target) => {
    while (unit < target && unit < text.length) {
      const code = text.codePointAt(unit) ?? 0
      unit += code > 0xffff ? 2 : 1
      cp += 1
    }
    return cp
  }
}
