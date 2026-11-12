/**
 * Checksums and the tarball reader for `minimal-agent update`.
 *
 * A release tarball is a flat ustar archive, gzipped (`scripts/release/lib.ts`
 * `writeTarGz`): `LICENSE`, `README.md`, `minimal-agent`. The updater needs
 * one member, so this is a minimal reader: gunzip with `Bun.gunzipSync`,
 * then walk the 512-byte headers. It understands ustar, the `prefix` field,
 * and GNU/pax long names, enough for what GNU tar and bsdtar write. No
 * `tar` binary, no temp dir, nothing written but the one file.
 *
 * Pure apart from `Bun.gunzipSync` and `Bun.CryptoHasher`.
 *
 * @module update/archive
 */

/** Hex sha256 of bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(bytes)
  return hasher.digest("hex")
}

/**
 * Parse a `SHA256SUMS` file (`<hex>  <name>` or `<hex> *<name>` lines).
 *
 * @returns name to lowercase hex
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/u)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/u.exec(line.trim())
    if (m?.[1] && m[2]) out.set(m[2].trim(), m[1].toLowerCase())
  }
  return out
}

/** A tar format problem. */
export class ArchiveError extends Error {}

const BLOCK = 512

function cstr(buf: Uint8Array, start: number, len: number): string {
  let end = start
  while (end < start + len && buf[end] !== 0) end++
  return new TextDecoder().decode(buf.subarray(start, end))
}

function octal(buf: Uint8Array, start: number, len: number): number {
  const text = cstr(buf, start, len).trim()
  if (text === "") return 0
  const n = Number.parseInt(text, 8)
  if (!Number.isFinite(n) || n < 0) throw new ArchiveError(`bad tar size field "${text}"`)
  return n
}

/** Read the `path` record of a pax header body, if any. */
function paxPath(body: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(body)
  for (const rec of text.split("\n")) {
    const m = /^\d+ path=(.*)$/u.exec(rec)
    if (m?.[1] !== undefined) return m[1]
  }
  return undefined
}

/** One regular file of a tar archive. */
export interface TarEntry {
  /** The path, with any leading `./` removed. */
  readonly name: string
  /** Mode bits from the header. */
  readonly mode: number
  readonly data: Uint8Array
}

/**
 * Every regular file of an uncompressed tar archive, in order.
 *
 * @throws ArchiveError on a truncated or malformed archive
 */
export function readTar(tar: Uint8Array): TarEntry[] {
  const out: TarEntry[] = []
  let off = 0
  let longName: string | undefined
  while (off + BLOCK <= tar.length) {
    const header = tar.subarray(off, off + BLOCK)
    if (header.every((b) => b === 0)) break
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156] ?? 0)
    const dataStart = off + BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new ArchiveError("truncated tar archive")
    const data = tar.subarray(dataStart, dataEnd)
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK
    if (type === "L") {
      longName = cstr(data, 0, data.length)
      continue
    }
    if (type === "x") {
      longName = paxPath(data) ?? longName
      continue
    }
    if (type === "g") continue
    const isUstar = cstr(header, 257, 6).startsWith("ustar")
    const prefix = isUstar ? cstr(header, 345, 155) : ""
    const base = cstr(header, 0, 100)
    const name = (longName ?? (prefix ? `${prefix}/${base}` : base)).replace(/^\.\//u, "")
    longName = undefined
    if (type === "0" || type === "\0" || type === "7") {
      out.push({ name, mode: octal(header, 100, 8), data })
    }
  }
  return out
}

/**
 * The bytes of one file in a gzipped tar. Matches the exact path or the
 * basename (a tarball with one top-level dir also works).
 *
 * @throws ArchiveError when gunzip fails or the member is missing
 */
export function extractFromTarGz(tgz: Uint8Array, member: string): Uint8Array {
  let tar: Uint8Array
  try {
    tar = Bun.gunzipSync(tgz as Uint8Array<ArrayBuffer>)
  } catch (e) {
    throw new ArchiveError(`not a gzip file: ${e instanceof Error ? e.message : String(e)}`)
  }
  const entries = readTar(tar)
  const hit =
    entries.find((e) => e.name === member) ??
    entries.find((e) => e.name.split("/").pop() === member)
  if (hit === undefined) {
    const names = entries.map((e) => e.name).join(", ") || "(none)"
    throw new ArchiveError(`the tarball has no ${member} (it holds: ${names})`)
  }
  return hit.data
}
