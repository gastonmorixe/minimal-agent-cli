/**
 * Compact number formatters for one-shot CLI tables: token counts, byte
 * sizes and USD cost. The outputs are not padded: the table renderer
 * aligns the columns by display width.
 *
 * @module ui/format/numbers
 */

/** Placeholder for a value that is missing, negative or not finite. */
export const MISSING_VALUE = "—"

/**
 * Step through `units` from the smallest: format `n` in the unit, and go to
 * the next unit when the rounded text reaches `base`. So a value just below
 * a unit boundary reads `1k` / `1.0 kB`, never `1000` / `1024 B`.
 */
function scaled(
  n: number,
  base: number,
  units: readonly { suffix: string; digits: number }[],
  trimZero: boolean,
): string {
  let value = n
  for (let i = 0; i < units.length; i++) {
    const unit = units[i] as { suffix: string; digits: number }
    const text = value.toFixed(unit.digits)
    if (Number(text) < base || i === units.length - 1) {
      return `${trimZero ? text.replace(/\.0+$/u, "") : text}${unit.suffix}`
    }
    value /= base
  }
  return MISSING_VALUE
}

const TOKEN_UNITS = [
  { suffix: "", digits: 0 },
  { suffix: "k", digits: 1 },
  { suffix: "M", digits: 1 },
  { suffix: "B", digits: 1 },
] as const

const BYTE_UNITS = [
  { suffix: " B", digits: 0 },
  { suffix: " kB", digits: 1 },
  { suffix: " MB", digits: 1 },
  { suffix: " GB", digits: 2 },
] as const

/**
 * Compact token count: `0`, `847`, `12.3k`, `1.2M`, `3.4B`. A trailing `.0`
 * is dropped, so round thousands read `12k`, not `12.0k`.
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return MISSING_VALUE
  return scaled(n, 1000, TOKEN_UNITS, true)
}

/** Compact byte size: `312 B`, `487.4 kB`, `2.3 MB`, `1.25 GB`. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return MISSING_VALUE
  return scaled(n, 1024, BYTE_UNITS, false)
}

/**
 * USD cost with two decimals: `$0.00`, `$0.02`, `$6.12`, `$1,234.50`.
 * A cost above zero and below one cent reads `<$0.01`.
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return MISSING_VALUE
  // `-0` passes the check above, and `toLocaleString` prints it as `-0.00`.
  if (usd === 0) return "$0.00"
  if (usd > 0 && usd < 0.005) return "<$0.01"
  const text = usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `$${text}`
}
