// Metric-mode heatmap logic for the Map tab, ported 1:1 from app.js's
// GRADIENTS/METRIC_CONFIG/heatColor/buildMetricSegments. Segments are bucketed
// into a fixed number of color bins (rather than colored per-pixel) so a run
// history's worth of GPS points renders as a handful of Leaflet polylines
// instead of one per segment.
import { haversineKm, computeGapThresholdKm } from "@/lib/route"
import { paceStr } from "@/lib/format"
import type { MapItem } from "@/lib/mapClusters"

export const HEAT_BUCKETS = 16

type GradientStop = [number, [number, number, number]]

// blue (slow) -> cyan -> green -> yellow -> red (fast) — classic "speed" cool-to-hot
const PACE_GRADIENT: GradientStop[] = [
  [0.0, [40, 80, 230]],
  [0.35, [0, 210, 210]],
  [0.55, [60, 200, 80]],
  [0.75, [235, 210, 40]],
  [1.0, [230, 60, 40]],
]

// green -> yellow -> orange -> red, matching standard HR training-zone colors (Z1-Z5)
const HR_GRADIENT: GradientStop[] = [
  [0.0, [50, 180, 90]],
  [0.35, [190, 210, 50]],
  [0.65, [235, 160, 30]],
  [1.0, [225, 40, 40]],
]

// deep purple -> magenta -> orange, kept distinct from pace/HR's blue and green starts
const CADENCE_GRADIENT: GradientStop[] = [
  [0.0, [90, 60, 190]],
  [0.45, [190, 50, 160]],
  [0.75, [230, 90, 70]],
  [1.0, [245, 160, 40]],
]

// diverging: blue (downhill) -> neutral beige (flat) -> red/brown (uphill)
const ELEVATION_GRADIENT: GradientStop[] = [
  [0.0, [40, 110, 200]],
  [0.35, [130, 185, 210]],
  [0.5, [225, 220, 200]],
  [0.65, [220, 150, 90]],
  [1.0, [190, 60, 40]],
]

function fmtPct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`
}

export type MetricMode = "density" | "pace" | "hr" | "cadence" | "elevation"

export interface MetricConfig {
  key: "paceSecPerMi" | "hr" | "cadence" | "gradePct"
  label: string
  fmt: (v: number) => string
  gradient: GradientStop[]
  invert?: boolean
  diverging?: boolean
  clipPercentile?: number
  clipMin?: boolean
  clipMax?: boolean
  legend: (min: number, max: number, cfg: MetricConfig) => string
}

export const METRIC_CONFIG: Record<Exclude<MetricMode, "density">, MetricConfig> = {
  // clipMin/clipMax: whether to percentile-clip that end of the range, vs. use the raw
  // extreme. Pace's slow end is prone to near-stopped/GPS-noise outliers (a stoplight
  // pause can read as 80+ min/mi) that would otherwise stretch the whole scale — but the
  // fast end is real effort (sprints), so clamping it into the same bucket as ordinary
  // tempo pace would erase genuinely distinct short, fast splits.
  pace: {
    key: "paceSecPerMi",
    label: "Pace",
    invert: true,
    fmt: (v) => `${paceStr(v)}/mi`,
    clipMin: false,
    clipMax: true,
    gradient: PACE_GRADIENT,
    legend: (min, max, cfg) => `blue ${cfg.fmt(max)} → red ${cfg.fmt(min)}`,
  },
  hr: {
    key: "hr",
    label: "Heart Rate",
    fmt: (v) => `${Math.round(v)} bpm`,
    clipMin: true,
    clipMax: true,
    gradient: HR_GRADIENT,
    legend: (min, max, cfg) => `blue ${cfg.fmt(min)} → red ${cfg.fmt(max)}`,
  },
  cadence: {
    key: "cadence",
    label: "Cadence",
    fmt: (v) => `${Math.round(v)} spm`,
    clipMin: true,
    clipMax: true,
    gradient: CADENCE_GRADIENT,
    legend: (min, max, cfg) => `blue ${cfg.fmt(min)} → red ${cfg.fmt(max)}`,
  },
  elevation: {
    // Grade can go either direction, so this uses a range symmetric around 0
    // rather than min/max clipping — flat ground should always land in the
    // middle of the gradient, not wherever this view's data happens to center.
    key: "gradePct",
    label: "Grade",
    diverging: true,
    clipPercentile: 0.95,
    fmt: fmtPct,
    gradient: ELEVATION_GRADIENT,
    legend: (min, max, cfg) => `blue ${cfg.fmt(min)} (downhill) → red ${cfg.fmt(max)} (uphill)`,
  },
}

export function heatColor(t: number, stops: GradientStop[]): string {
  t = Math.max(0, Math.min(1, t))
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i]
    const [t1, c1] = stops[i + 1]
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0 || 1)
      const c = c0.map((v, idx) => Math.round(v + (c1[idx] - v) * f))
      return `rgb(${c[0]},${c[1]},${c[2]})`
    }
  }
  const last = stops[stops.length - 1][1]
  return `rgb(${last.join(",")})`
}

export interface MetricSegments {
  buckets: [number, number][][][]
  min: number
  max: number
  runCount: number
}

export function buildMetricSegments(items: MapItem[], cfg: MetricConfig, isValid?: (v: number) => boolean): MetricSegments {
  const segments: { line: [number, number][]; value: number }[] = []
  const runsWithMetric = new Set<string>()

  items.forEach(({ run }) => {
    const pts = run.routeMetrics || []
    if (pts.length < 2) return
    // Same pause/teleport-gap guard as density-mode route drawing — a paused-then-
    // resumed-elsewhere run shouldn't connect its pre- and post-pause points either.
    const gapThreshold = computeGapThresholdKm(pts.map((p) => [p.lat, p.lon]))
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      const av = a[cfg.key]
      const bv = b[cfg.key]
      if (av == null || bv == null) continue
      if (isValid && (!isValid(av) || !isValid(bv))) continue
      if (haversineKm([a.lat, a.lon], [b.lat, b.lon]) > gapThreshold) continue
      segments.push({
        line: [
          [a.lat, a.lon],
          [b.lat, b.lon],
        ],
        value: (av + bv) / 2,
      })
      runsWithMetric.add(run.id)
    }
  })

  if (!segments.length) return { buckets: [], min: 0, max: 0, runCount: 0 }

  const sorted = segments.map((s) => s.value).sort((a, b) => a - b)
  const percentile = (p: number) => {
    const idx = (sorted.length - 1) * p
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
  }

  let min: number
  let max: number
  if (cfg.diverging) {
    const p = cfg.clipPercentile ?? 0.95
    const maxAbs = Math.max(Math.abs(percentile(1 - p)), Math.abs(percentile(p))) || 1
    min = -maxAbs
    max = maxAbs
  } else {
    min = cfg.clipMin ? percentile(0.05) : sorted[0]
    max = cfg.clipMax ? percentile(0.95) : sorted[sorted.length - 1]
  }
  const range = max - min || 1

  const buckets: [number, number][][][] = Array.from({ length: HEAT_BUCKETS }, () => [])
  segments.forEach(({ line, value }) => {
    let t = Math.max(0, Math.min(1, (value - min) / range))
    if (cfg.invert) t = 1 - t
    buckets[Math.min(HEAT_BUCKETS - 1, Math.floor(t * HEAT_BUCKETS))].push(line)
  })

  return { buckets, min, max, runCount: runsWithMetric.size }
}
