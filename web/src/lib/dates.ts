// Filter-bar date math, ported from app.js — kept as plain Date arithmetic (not
// a date library) to match the legacy app's exact range boundaries.

export type FilterMode = "rolling7" | "week" | "month" | "sixMonths" | "year" | "ytd" | "custom" | "all"

export function todayMidnight(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

// Monday-anchored
export function startOfWeek(d: Date): Date {
  const dow = (d.getDay() + 6) % 7
  return addDays(d, -dow)
}

export function fmtRangeLabel(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }
  return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`
}

export function toDateInputValue(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export function currentFilterRange(
  mode: FilterMode,
  anchor: Date,
  customStart: Date,
  customEnd: Date,
): { start: Date; end: Date } {
  if (mode === "week") {
    const start = startOfWeek(anchor)
    return { start, end: addDays(start, 6) }
  }
  if (mode === "month") return { start: addDays(anchor, -29), end: anchor }
  if (mode === "sixMonths") return { start: addDays(anchor, -181), end: anchor }
  if (mode === "year") return { start: addDays(anchor, -364), end: anchor }
  if (mode === "ytd") return { start: new Date(anchor.getFullYear(), 0, 1), end: anchor }
  if (mode === "custom") return { start: customStart, end: customEnd }
  return { start: addDays(anchor, -6), end: anchor } // rolling7
}
