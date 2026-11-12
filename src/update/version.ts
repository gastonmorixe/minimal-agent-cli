/**
 * Release labels and their order, for `minimal-agent update`.
 *
 * A release label is `<x.y.z>` (stable, tag `v<x.y.z>`) or
 * `<x.y.z>-nightly.<YYYYMMDDTHHMMSSZ>` (nightly, tag `v<label>`), the scheme
 * of `.github/workflows/release.yml`. The package.json version does not
 * move on a nightly, so the nightlies cut after stable `0.1.0` are labeled
 * `0.1.0-nightly.<stamp>`. Plain semver puts them BELOW `0.1.0`, which is
 * wrong for an updater. So the order is:
 *
 * 1. `x.y.z` by number.
 * 2. Same `x.y.z`, both build times known: the later build is newer, and
 *    two times within {@link SAME_BUILD_TOLERANCE_MS} are the same build.
 *    A nightly's time is its stamp. A stable's time is its publish time, or
 *    the running binary's `builtAt`.
 * 3. A time is missing: equal labels are the same, else semver precedence
 *    (a stable beats a pre-release, nightly stamps sort by time).
 *
 * The running binary knows only its package.json `x.y.z` and `builtAt`, not
 * its release label, so `update` first matches the commit SHAs of the
 * release's `build-info.json` (see `update/plan.ts`) and uses this order
 * only when they differ.
 *
 * Pure. No I/O.
 *
 * @module update/version
 */

/** A parsed release label. */
export interface ReleaseLabel {
  /** The label as given, without a leading `v`. */
  readonly label: string
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** Pre-release identifiers (`["nightly", "20261112T200000Z"]`), empty for stable. */
  readonly pre: readonly string[]
  /** `nightly` when the pre-release is `nightly.<stamp>`, else `stable` (or `other`). */
  readonly channel: "stable" | "nightly" | "other"
  /** The nightly stamp as a Date, or undefined. */
  readonly stamp?: Date
}

const LABEL_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u
const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u

/** Parse a nightly stamp `YYYYMMDDTHHMMSSZ` to a Date, or undefined. */
export function parseStamp(stamp: string): Date | undefined {
  const m = STAMP_RE.exec(stamp)
  if (m === null) return undefined
  const [, y, mo, d, h, mi, s] = m
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/**
 * Parse a release label or tag (`v0.1.0`, `0.1.0-nightly.20261112T200000Z`).
 * Build metadata (`+abc.release`) is accepted and dropped.
 *
 * @returns the parsed label, or undefined when `text` is not a release label
 */
export function parseLabel(text: string): ReleaseLabel | undefined {
  const m = LABEL_RE.exec(text.trim())
  if (m === null) return undefined
  const pre = m[4] === undefined ? [] : m[4].split(".")
  const label = text.trim().replace(/^v/u, "").replace(/\+.*$/u, "")
  const isNightly = pre.length === 2 && pre[0] === "nightly"
  const stamp = isNightly ? parseStamp(pre[1] ?? "") : undefined
  return {
    label,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre,
    channel: pre.length === 0 ? "stable" : isNightly && stamp ? "nightly" : "other",
    ...(stamp ? { stamp } : {}),
  }
}

/** The git tag of a label: `v<label>`. */
export function tagOf(label: string): string {
  return label.startsWith("v") ? label : `v${label}`
}

/** Semver precedence of two pre-release identifier lists (empty = release, highest). */
function comparePre(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/u.test(x)
    const yn = /^\d+$/u.test(y)
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1
    if (xn) return -1
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** Compare the `x.y.z` parts only. */
export function compareCore(a: ReleaseLabel, b: ReleaseLabel): number {
  return Math.sign(a.major - b.major || a.minor - b.minor || a.patch - b.patch)
}

/** Strict semver precedence (no build time): -1, 0, or 1. */
export function compareSemver(a: ReleaseLabel, b: ReleaseLabel): number {
  return compareCore(a, b) || comparePre(a.pre, b.pre)
}

/** One side of an update comparison: a label and, when known, its build time. */
export interface VersionPoint {
  readonly label: ReleaseLabel
  /**
   * When the build was made: the nightly stamp, a stable release's publish
   * time, or the running binary's `builtAt`. Undefined when unknown.
   */
  readonly time?: Date
}

/**
 * Build times closer than this count as the same build. A nightly's stamp
 * and its `SOURCE_DATE_EPOCH` come from two `date` calls in one workflow
 * step, so they can differ by a second or two. Nightlies are a day apart.
 */
export const SAME_BUILD_TOLERANCE_MS = 120_000

/** The build time of a point: the nightly stamp wins, else `time`. */
function timeOf(p: VersionPoint): Date | undefined {
  return p.label.stamp ?? p.time
}

/**
 * Order two versions for an update decision (see the module doc).
 *
 * @returns 1 when `a` is newer than `b`, -1 when older, 0 when the same
 */
export function compareVersions(a: VersionPoint, b: VersionPoint): number {
  const core = compareCore(a.label, b.label)
  if (core !== 0) return core
  const ta = timeOf(a)
  const tb = timeOf(b)
  if (ta !== undefined && tb !== undefined) {
    const diff = ta.getTime() - tb.getTime()
    if (Math.abs(diff) <= SAME_BUILD_TOLERANCE_MS) return 0
    return diff > 0 ? 1 : -1
  }
  if (a.label.label === b.label.label) return 0
  return compareSemver(a.label, b.label)
}

/** `x.y.z` of a label: the version a binary of that release prints. */
export function coreVersion(label: ReleaseLabel): string {
  return `${label.major}.${label.minor}.${label.patch}`
}
