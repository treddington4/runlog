import { useMemo } from "react"
import type { ChartConfiguration } from "chart.js"
import type { ChartSpec } from "@/lib/api"
import { CHART_COLORS } from "@/lib/chartTheme"
import { ChartCanvas } from "@/components/insights/ChartCanvas"

// Own component (rather than building the config inline in ChatBubble) so its
// useMemo dependency is just this one `spec` object — as long as the parent
// doesn't reconstruct `spec` on every render (it comes from React Query cache
// data, so it won't), typing in the chat input bar never tears down and
// rebuilds an unrelated chart's Chart.js instance.
export function ChatChart({ spec }: { spec: ChartSpec }) {
  const config = useMemo<ChartConfiguration>(
    () => ({
      type: spec.chartType === "bar" ? "bar" : "line",
      data: {
        labels: spec.labels,
        datasets: spec.datasets.map((d) => ({
          label: d.label,
          data: d.data,
          borderColor: CHART_COLORS.cyan,
          backgroundColor: CHART_COLORS.cyan,
        })),
      },
      options: { responsive: true, maintainAspectRatio: false },
    }),
    [spec],
  )

  return (
    <div className="bg-card border-border mt-2 rounded-xl border p-3">
      <div className="text-xs font-bold">{spec.title}</div>
      <ChartCanvas config={config} height={180} />
    </div>
  )
}
