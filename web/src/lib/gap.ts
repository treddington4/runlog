// Grade-Adjusted Pace (Minetti cost-of-running model) — deliberately duplicated
// client-side so per-split GAP can redraw without a round trip. This is the one
// documented exception to "compute once at sync time" (see CLAUDE.md's
// Architecture section): app/util.py has the authoritative server-side
// implementation; this must be kept in sync by hand if the formula ever changes.
export function minettiCost(i: number): number {
  const i2 = i * i
  const i3 = i2 * i
  const i4 = i3 * i
  const i5 = i4 * i
  return 155.4 * i5 - 30.4 * i4 - 43.3 * i3 + 46.3 * i2 + 19.5 * i + 3.6
}

export function gapSecPerMi(
  pace: number | null | undefined,
  elevFt: number | null | undefined,
  distMi: number | null | undefined,
): number | null {
  if (!pace || elevFt == null || !distMi) return null
  const grade = Math.max(-0.3, Math.min(0.3, elevFt / 5280 / distMi))
  return pace / (minettiCost(grade) / minettiCost(0))
}
