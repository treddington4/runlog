import type { ReactNode } from "react"
import { Card } from "@/components/ui/card"

// Title/sub/canvas wrapper mirroring the legacy chartCardHTML() layout
// (.chart-card/.chart-title/.chart-sub/.chart-body), plus an empty state for
// when there isn't enough data yet to plot.
export function ChartPanel({
  title,
  sub,
  empty,
  action,
  children,
}: {
  title: string
  sub?: string
  empty?: string | null
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <Card className="gap-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-bold">{title}</div>
          {sub && <div className="text-muted-foreground text-xs">{sub}</div>}
        </div>
        {action}
      </div>
      {empty ? (
        <div className="text-hale-faint flex h-24 items-center justify-center text-xs">{empty}</div>
      ) : (
        children
      )}
    </Card>
  )
}
