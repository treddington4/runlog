// Route-gap splitting, ported from app.js — a paused-then-resumed-elsewhere run
// leaves a real geographic gap in the point sequence; connecting it draws a
// straight "teleport" line across the map that isn't a real path.

// Exported for the Map tab's metric-mode segment builder (lib/mapHeat.ts), which
// needs the gap threshold directly rather than the pre-split segments this
// module builds for the density-mode/mini-map polylines.
export function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371
  const dLat = ((b[0] - a[0]) * Math.PI) / 180
  const dLon = ((b[1] - a[1]) * Math.PI) / 180
  const la1 = (a[0] * Math.PI) / 180
  const la2 = (b[0] * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Threshold adapts to each route's own typical point spacing (coarser decimation
// on long runs naturally has wider gaps) rather than a single fixed distance,
// floored so short/dense routes don't flag normal spacing.
export function computeGapThresholdKm(points: [number, number][]): number {
  if (points.length < 2) return Infinity
  const dists: number[] = []
  for (let i = 0; i < points.length - 1; i++) dists.push(haversineKm(points[i], points[i + 1]))
  const sorted = [...dists].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] || 0
  return Math.max(0.32, median * 6)
}

export function splitRouteAtGaps(route: [number, number][]): [number, number][][] {
  if (route.length < 2) return [route]
  const threshold = computeGapThresholdKm(route)
  const segments: [number, number][][] = []
  let current: [number, number][] = [route[0]]
  for (let i = 0; i < route.length - 1; i++) {
    if (haversineKm(route[i], route[i + 1]) > threshold) {
      segments.push(current)
      current = []
    }
    current.push(route[i + 1])
  }
  segments.push(current)
  return segments.filter((s) => s.length > 1)
}
