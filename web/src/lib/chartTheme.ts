// Unified Chart.js theme for every chart in the app (Insights, and later Chat's
// inline charts — see PLAN.md 0.6/0.8). The legacy app.js had no shared theme
// module: it mutated the process-wide `Chart.defaults` once inside
// renderInsightsTab() and hand-repeated the grid-line hex literal at every
// individual chart's scale config, which meant Chat's charts silently inherited
// whatever Insights last set (or Chart.js's own default, if Chat rendered
// first). Calling applyChartTheme() once at app startup (see main.tsx) fixes
// that ordering fragility instead of reproducing it.
import { Chart as ChartJS } from "chart.js/auto"

export const CHART_COLORS = {
  gold: "#FFC857",
  cyan: "rgb(76,201,240)",
  orange: "rgb(255,107,53)",
  green: "#5FD68A",
  deepSleep: "#2C3E91",
  muted: "#8B93A1",
  grid: "#242B35",
} as const

let applied = false

export function applyChartTheme() {
  if (applied) return
  ChartJS.defaults.color = CHART_COLORS.muted
  ChartJS.defaults.borderColor = CHART_COLORS.grid
  applied = true
}
