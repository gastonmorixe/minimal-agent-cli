/**
 * Time formatters for one-shot CLI tables: duration, relative age, local
 * clock time and day labels. Each one takes an injectable `now` and IANA
 * `timeZone`, so tests do not depend on the host clock or zone.
 *
 * @module ui/format/time
 */

import { MISSING_VALUE } from "./numbers.ts"

/**
 * Clock and zone options. Both default to the host values. A `now` that is
 * not finite gives `—`; a `timeZone` that `Intl` rejects uses the host zone.
 */
export interface TimeFormatOptions {
  /** Current time in epoch milliseconds. Default: `Date.now()`. */
  now?: number
  /** IANA zone, for example `"America/New_York"`. Default: host zone. */
  timeZone?: string
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const pad2 = (n: number): string => String(n).padStart(2, "0")

/** Largest epoch ms that `Date` and `Intl` accept (ECMA-262 time value). */
const MAX_TIME_MS = 8.64e15

/** True for a time that `Intl.DateTimeFormat` can format without a throw. */
const isTimeMs = (ms: number): boolean => Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME_MS

/** The `now` option, or the host clock. `undefined` when it is not a time. */
function resolveNow(options: TimeFormatOptions): number | undefined {
  const now = options.now ?? Date.now()
  return isTimeMs(now) ? now : undefined
}

const zoneCache = new Map<string, boolean>()

/**
 * The `timeZone` option when `Intl` accepts it, else `undefined` (the host
 * zone). A bad zone name must not throw from a table cell formatter.
 */
function resolveZone(options: TimeFormatOptions): string | undefined {
  const zone = options.timeZone
  if (zone === undefined) return undefined
  let ok = zoneCache.get(zone)
  if (ok === undefined) {
    try {
      ok = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone !== ""
    } catch {
      ok = false
    }
    zoneCache.set(zone, ok)
  }
  return ok ? zone : undefined
}

/**
 * Compact duration from milliseconds: `48s`, `3m40s`, `4m`, `21m`,
 * `2h05m`, `3d04h`. Below ten minutes the seconds stay; above, they drop.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return MISSING_VALUE
  const totalSeconds = Math.floor(ms / SECOND)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 10) {
    const s = totalSeconds % 60
    return s === 0 ? `${totalMinutes}m` : `${totalMinutes}m${pad2(s)}s`
  }
  if (totalMinutes < 60) return `${totalMinutes}m`
  const totalHours = Math.floor(totalMinutes / 60)
  if (totalHours < 24) return `${totalHours}h${pad2(totalMinutes % 60)}m`
  return `${Math.floor(totalHours / 24)}d${pad2(totalHours % 24)}h`
}

/**
 * Relative age of `atMs` against `now`: `now`, `40s ago`, `5m ago`,
 * `3h ago`, `2d ago`, `5w ago`, `1y ago`. A time in the future reads `now`.
 */
export function formatRelativeAge(atMs: number, options: TimeFormatOptions = {}): string {
  const now = resolveNow(options)
  if (!Number.isFinite(atMs) || now === undefined) return MISSING_VALUE
  const age = now - atMs
  if (age < 5 * SECOND) return "now"
  if (age < MINUTE) return `${Math.floor(age / SECOND)}s ago`
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m ago`
  if (age < DAY) return `${Math.floor(age / HOUR)}h ago`
  if (age < 14 * DAY) return `${Math.floor(age / DAY)}d ago`
  if (age < 365 * DAY) return `${Math.floor(age / (7 * DAY))}w ago`
  return `${Math.floor(age / (365 * DAY))}y ago`
}

/** Local 24-hour clock time `HH:MM` of `atMs` in the given zone. */
export function formatLocalTime(atMs: number, options: TimeFormatOptions = {}): string {
  if (!isTimeMs(atMs)) return MISSING_VALUE
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: resolveZone(options),
  }).formatToParts(atMs)
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00"
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00"
  return `${hour}:${minute}`
}

interface CalendarDay {
  year: number
  /** Days since the epoch for the calendar date, for differences. */
  ordinal: number
  label: string
}

function calendarDay(atMs: number, timeZone: string | undefined): CalendarDay {
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone,
  }).formatToParts(atMs)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ""
  const numeric = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(atMs)
  const num = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(numeric.find((p) => p.type === type)?.value ?? "0")
  const year = num("year")
  return {
    year,
    ordinal: Math.round(Date.UTC(year, num("month") - 1, num("day")) / DAY),
    label: `${get("weekday")} ${get("month")} ${get("day")}`,
  }
}

/**
 * Day label for a group heading: `today`, `yesterday`, or `Wed Nov 18`.
 * A day in another year than `now` gets the year: `Tue Dec 30 2025`.
 */
export function formatDayLabel(atMs: number, options: TimeFormatOptions = {}): string {
  const now = resolveNow(options)
  if (!isTimeMs(atMs) || now === undefined) return MISSING_VALUE
  const zone = resolveZone(options)
  const day = calendarDay(atMs, zone)
  const today = calendarDay(now, zone)
  const diff = today.ordinal - day.ordinal
  if (diff === 0) return "today"
  if (diff === 1) return "yesterday"
  return day.year === today.year ? day.label : `${day.label} ${day.year}`
}
