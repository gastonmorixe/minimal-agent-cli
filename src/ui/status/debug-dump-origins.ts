/**
 * Origin lookup for the `--debug --verbose` request dump.
 *
 * Joins the typed dump rows with the data the plugin loader and core keep:
 * which core slot, plugin section, or plugin fragment wrote a system block
 * line, which plugin owns a tool, and which tool a `tool_result` answers.
 *
 * Every getter of {@link DumpOriginSource} except `loadedPackages` is
 * optional and read with a `typeof` check, so a loader without the getters
 * still type-checks. A getter that throws counts as "no data". Missing data
 * gives an `unrecorded` ref, never a throw.
 *
 * @module ui/status/debug-dump-origins
 */

import { NO_SIDEBAND, type SidebandApi, type SidebandNode } from "@minimal-agent/core/host/sideband"
import { BUILTIN_TOOL_NAMES } from "@minimal-agent/core/host/tool-catalog"
import type { DumpBlockRef } from "../../logging/request-dump-model.ts"

/** A core system prompt slot (mirror of core `SystemSlotId`). */
export type SystemSlotId =
  | "identity"
  | "instructions"
  | "toolOutputConventions"
  | "afterInstructions"
  | "sessionContext"
  | "providerPreamble"

/** A core slot span in one system block text (UTF-16 offsets, end exclusive). */
export interface SystemSlotSpan {
  readonly slot: SystemSlotId
  readonly start: number
  readonly end: number
  readonly overridden: boolean
  /** Provider id that added the block. Set only for slot `providerPreamble`. */
  readonly providerId?: string
}

/** One afterInstructions fragment span, offsets in the loader's afterInstructions text. */
export interface PromptFragmentSpan {
  readonly pluginId: string
  readonly fragmentId: string
  readonly start: number
  readonly end: number
}

/** One `<ma::sys::ROLE name="X">` section of the sessionContext block. */
export interface SessionContextSection {
  readonly role: string
  readonly name: string
  readonly pluginId: string
  readonly packageDir: string
}

/** Plugin prompt provenance (mirror of the core loader type). */
export interface PromptProvenance {
  readonly afterInstructions: readonly PromptFragmentSpan[]
  readonly sessionContext: readonly SessionContextSection[]
}

/** The plugin that owns a tool. */
export interface ToolOwner {
  readonly pluginId: string
  readonly packageDir: string
}

/** Where origin data comes from. Structural, so a `PluginLoader` fits. */
export interface DumpOriginSource {
  loadedPackages(): ReadonlyArray<{ readonly id: string; readonly packageDir: string }>
  toolOwners?(): ReadonlyMap<string, ToolOwner>
  getPromptProvenance?(): PromptProvenance | undefined
  describeSystemBlock?(text: string): readonly SystemSlotSpan[] | undefined
  /** The loader's afterInstructions text, used to anchor fragment spans. */
  afterInstructionsText?(): string | null | undefined
  /** The loader's sideband API: it finds the system section tags and the attachments. */
  sideband?(): DumpSideband
}

/**
 * The sideband slice that the dump uses: read the tags (`find`), list the
 * kinds, get the end part of a kind (`render`), and name a kind for a label.
 */
export type DumpSideband = Pick<SidebandApi, "find" | "name" | "render" | "kinds">

/**
 * The sideband API of `src`, or `NO_SIDEBAND` when it has none (then no
 * section tag and no attachment is found).
 */
export function dumpSideband(src: DumpOriginSource | undefined): DumpSideband {
  const sb =
    src !== undefined && typeof src.sideband === "function"
      ? safe(() => src.sideband?.())
      : undefined
  return sb ?? NO_SIDEBAND
}

/** One origin reference line. */
export type OriginRef =
  | { readonly kind: "core-slot"; readonly slot: SystemSlotId; readonly overridden: boolean }
  | {
      readonly kind: "plugin-section"
      readonly tag: string
      readonly pluginId?: string
      readonly packageDir?: string
    }
  | {
      readonly kind: "plugin-fragment"
      readonly pluginId: string
      readonly fragmentId: string
      readonly packageDir?: string
    }
  | { readonly kind: "host-append" }
  | { readonly kind: "core-tool" }
  | { readonly kind: "plugin-tool"; readonly pluginId: string; readonly packageDir: string }
  | { readonly kind: "unrecorded" }
  | { readonly kind: "msg-text" }
  | {
      readonly kind: "msg-attachment"
      /** The sideband kind. */
      readonly name: string
      /** The prompt-text name of the kind (`sb.name`), shown as the tag label. */
      readonly tag: string
    }
  | { readonly kind: "msg-tool-use"; readonly toolName?: string; readonly toolUseId?: string }
  | {
      readonly kind: "msg-tool-result"
      readonly toolName: string | undefined
      readonly toolUseId: string | undefined
      readonly isError: boolean
    }
  | { readonly kind: "msg-other"; readonly blockType: string }

/** A reference placed before a 1-based source line. */
export interface PlacedRef {
  readonly atLine: number
  readonly ref: OriginRef
}

/** Call a getter, and give undefined when it throws. */
function safe<T>(get: () => T): T | undefined {
  try {
    return get()
  } catch {
    return undefined
  }
}

const provenanceOf = (src: DumpOriginSource | undefined): PromptProvenance | undefined =>
  src !== undefined && typeof src.getPromptProvenance === "function"
    ? safe(() => src.getPromptProvenance?.())
    : undefined

/** Map a UTF-16 offset to its 1-based line, from line start offsets. */
function lineAt(starts: readonly number[], offset: number): number {
  let line = 1
  for (let i = 1; i < starts.length && starts[i] <= offset; i++) line = i + 1
  return line
}

/** The end part of each kind, by sideband object (`null`: the kind has none). */
const CLOSE_PARTS = new WeakMap<object, Map<string, string | null>>()

/** The end part that the codec writes for `kind`, or `null`. Never throws. */
function closePartOf(sb: DumpSideband, kind: string): string | null {
  let byKind = CLOSE_PARTS.get(sb)
  if (byKind === undefined) {
    byKind = new Map()
    CLOSE_PARTS.set(sb, byKind)
  }
  const known = byKind.get(kind)
  if (known !== undefined) return known
  let part: string | null = null
  try {
    const text = sb.render(kind, { body: "x" })
    const close = sb.find(text, { kinds: [kind] })[0]?.close
    if (close !== undefined) part = text.slice(close.start, close.end)
  } catch {
    part = null
  }
  byKind.set(kind, part)
  return part
}

/**
 * The node of one of `kinds` that starts at offset 0 of `line`. A dump
 * line can hold only the start part of a node (its end is on a later line,
 * or after the shown-line cap), so the end part of the kind is added after
 * the line before the codec reads it. The node offsets refer to `line`.
 */
function nodeAtLineStart(
  line: string,
  sb: DumpSideband,
  kinds: readonly string[],
): SidebandNode | undefined {
  if (line.length === 0) return undefined
  for (const kind of kinds) {
    const close = closePartOf(sb, kind)
    const text = close === null ? line : `${line}\n${close}`
    const n = sb.find(text, { kinds: [kind] })[0]
    if (n !== undefined && n.span.start === 0) return n
  }
  return undefined
}

/**
 * The system section open tags of `lines` that fill one whole line: a
 * paired node of a system kind with only a `name` attribute. Each gives
 * its 0-based line, its role (the kind) and its decoded name. The codec
 * reads the tag and decodes the name.
 */
function sectionOpenLines(
  lines: readonly string[],
  sb: DumpSideband,
): { line: number; role: string; name: string }[] {
  const kinds = sb.kinds({ placement: "system" }).map((k) => k.kind)
  const out: { line: number; role: string; name: string }[] = []
  if (kinds.length === 0) return out
  lines.forEach((line, i) => {
    const n = nodeAtLineStart(line, sb, kinds)
    if (n === undefined || n.selfClosing || n.open?.end !== line.length) return
    const keys = Object.keys(n.attrs)
    if (keys.length !== 1 || n.attrs.name === undefined) return
    out.push({ line: i, role: n.kind, name: n.attrs.name })
  })
  return out
}

/** Refs from the loader's afterInstructions fragment spans. */
function fragmentRefs(
  text: string,
  starts: readonly number[],
  src: DumpOriginSource,
  prov: PromptProvenance | undefined,
): PlacedRef[] {
  const frags = prov?.afterInstructions ?? []
  const after =
    typeof src.afterInstructionsText === "function"
      ? safe(() => src.afterInstructionsText?.())
      : undefined
  if (frags.length === 0 || typeof after !== "string" || after === "") return []
  const base = text.indexOf(after)
  if (base < 0) return []
  const dirs = new Map((safe(() => src.loadedPackages()) ?? []).map((p) => [p.id, p.packageDir]))
  const out: PlacedRef[] = frags.map((f) => {
    const packageDir = dirs.get(f.pluginId)
    return {
      atLine: lineAt(starts, base + f.start),
      ref: {
        kind: "plugin-fragment",
        pluginId: f.pluginId,
        fragmentId: f.fragmentId,
        ...(packageDir === undefined ? {} : { packageDir }),
      },
    }
  })
  const end = base + after.length
  const rest = text.slice(end).search(/\S/)
  if (rest >= 0) out.push({ atLine: lineAt(starts, end + rest), ref: { kind: "host-append" } })
  return out
}

/**
 * The ref of a block that a provider hook added (core slot `providerPreamble`).
 *
 * Reuses the `plugin-section` kind, so the verbose printer shows
 * `<provider> · provider preamble[ overridden] · <package dir>`. The package
 * dir is found when a loaded package id equals the provider id.
 */
function providerPreambleRef(s: SystemSlotSpan, src: DumpOriginSource | undefined): OriginRef {
  const tag = s.overridden ? "provider preamble overridden" : "provider preamble"
  if (s.providerId === undefined) return { kind: "plugin-section", tag }
  const id = s.providerId
  const pkg =
    src === undefined ? undefined : safe(() => src.loadedPackages())?.find((p) => p.id === id)
  return {
    kind: "plugin-section",
    tag,
    pluginId: id,
    ...(pkg === undefined ? {} : { packageDir: pkg.packageDir }),
  }
}

/**
 * The reference lines of one system block, each placed before its line.
 *
 * Sources: core slot spans, `<ma::sys::ROLE name="X">` open-tag lines matched
 * to the loader's sessionContext sections, and afterInstructions fragment
 * spans anchored with `indexOf` of the loader text. When no slot or fragment
 * ref starts at line 1, an `unrecorded` ref heads the block.
 *
 * @param text - The full system block text.
 * @param src - Origin data, or undefined.
 * @returns Refs sorted by line (stable).
 */
export function systemRefs(
  text: string,
  src: DumpOriginSource | undefined,
  sb: DumpSideband = dumpSideband(src),
): PlacedRef[] {
  const lines = text.split("\n")
  const starts: number[] = []
  let off = 0
  for (const l of lines) {
    starts.push(off)
    off += l.length + 1
  }
  const refs: PlacedRef[] = []

  const spans =
    src !== undefined && typeof src.describeSystemBlock === "function"
      ? safe(() => src.describeSystemBlock?.(text))
      : undefined
  let providerHead = false
  for (const s of spans ?? []) {
    const atLine = lineAt(starts, s.start)
    if (s.slot === "providerPreamble") {
      // Label text lives here, not in core (core records data only).
      providerHead ||= atLine === 1
      refs.push({ atLine, ref: providerPreambleRef(s, src) })
      continue
    }
    refs.push({ atLine, ref: { kind: "core-slot", slot: s.slot, overridden: s.overridden } })
  }

  const prov = provenanceOf(src)
  if (src !== undefined) refs.push(...fragmentRefs(text, starts, src, prov))

  for (const sec of sectionOpenLines(lines, sb)) {
    const hit = prov?.sessionContext.find((s) => s.role === sec.role && s.name === sec.name)
    refs.push({
      atLine: sec.line + 1,
      ref: {
        kind: "plugin-section",
        tag: lines[sec.line] as string,
        ...(hit === undefined ? {} : { pluginId: hit.pluginId, packageDir: hit.packageDir }),
      },
    })
  }

  const headed =
    providerHead ||
    refs.some(
      (r) => r.atLine === 1 && (r.ref.kind === "core-slot" || r.ref.kind === "plugin-fragment"),
    )
  if (!headed) refs.unshift({ atLine: 1, ref: { kind: "unrecorded" } })
  // `sort` is stable (ECMAScript 2019), so refs on one line keep push order.
  return refs.sort((a, b) => a.atLine - b.atLine)
}

/** Core built-in tool names. */
const CORE_TOOLS: ReadonlySet<string> = new Set(BUILTIN_TOOL_NAMES)

/**
 * The owner of one tool: the plugin from the loader's owner map, else core
 * when it is a built-in, else `unrecorded`.
 *
 * @param name - The tool name as sent on the wire.
 * @param src - Origin data, or undefined.
 */
export function toolRef(name: string, src: DumpOriginSource | undefined): OriginRef {
  const owners =
    src !== undefined && typeof src.toolOwners === "function"
      ? safe(() => src.toolOwners?.())
      : undefined
  const owner = owners?.get(name)
  if (owner !== undefined) {
    return { kind: "plugin-tool", pluginId: owner.pluginId, packageDir: owner.packageDir }
  }
  return CORE_TOOLS.has(name) ? { kind: "core-tool" } : { kind: "unrecorded" }
}

/**
 * The reference of one message content block.
 *
 * A text block is an attachment when its first line starts with a node of
 * a harness kind for the turn or a tool result (direction `to-model`, not
 * `system`) in its current wire name. Its `name` is the kind.
 *
 * @param b - The block row data.
 * @param toolNames - `tool_use` id to tool name, from blocks seen earlier in the same dump.
 * @param firstLine - The first source line of the block, if any.
 * @param sb - The sideband reader. Default: `NO_SIDEBAND` (no attachment found).
 */
export function blockRef(
  b: DumpBlockRef,
  toolNames: ReadonlyMap<string, string>,
  firstLine?: string,
  sb: DumpSideband = NO_SIDEBAND,
): OriginRef {
  if (b.blockType === "text") {
    const n = firstLine === undefined ? undefined : attachmentAt(firstLine, sb)
    return n === undefined
      ? { kind: "msg-text" }
      : { kind: "msg-attachment", name: n.kind, tag: sb.name(n.kind) }
  }
  if (b.blockType === "tool_use") {
    return {
      kind: "msg-tool-use",
      ...(b.toolName === undefined ? {} : { toolName: b.toolName }),
      ...(b.toolUseId === undefined ? {} : { toolUseId: b.toolUseId }),
    }
  }
  if (b.blockType === "tool_result") {
    return {
      kind: "msg-tool-result",
      toolName: b.toolUseId === undefined ? undefined : toolNames.get(b.toolUseId),
      toolUseId: b.toolUseId,
      isError: b.isError === true,
    }
  }
  return { kind: "msg-other", blockType: b.blockType }
}

/** The attachment kinds of `sb`: to-model kinds that are not system sections. */
function attachmentKinds(sb: DumpSideband): string[] {
  return sb
    .kinds({ direction: "to-model" })
    .filter((k) => k.placement !== "system")
    .map((k) => k.kind)
}

/** The attachment node at the start of `line`, in its current wire name, or undefined. */
function attachmentAt(line: string, sb: DumpSideband): SidebandNode | undefined {
  const kinds = attachmentKinds(sb)
  if (kinds.length === 0) return undefined
  const n = nodeAtLineStart(line, sb, kinds)
  // An old wire name (a bare or older form) is not shown as an attachment.
  return n !== undefined && n.legacyQname === sb.name(n.kind) ? n : undefined
}
