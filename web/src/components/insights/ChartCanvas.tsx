import { useEffect, useRef } from "react"
import Chart from "chart.js/auto"
import type { ChartConfiguration } from "chart.js"

// One Chart.js instance per mounted canvas, created/destroyed via effect
// cleanup rather than the legacy global `charts` array + manual destroyCharts()
// — React's unmount timing means per-canvas cleanup is the safer equivalent
// (see PLAN.md 0.6 notes). Callers must useMemo `config` so unrelated re-renders
// don't tear down and rebuild the chart on every render.
export function ChartCanvas({ config, height = 200 }: { config: ChartConfiguration; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!ref.current) return
    const chart = new Chart(ref.current, config)
    return () => chart.destroy()
  }, [config])

  return (
    <div className="mt-2">
      <canvas ref={ref} height={height} />
    </div>
  )
}
