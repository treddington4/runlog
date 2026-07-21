import type * as React from "react"
import { cn } from "@/lib/utils"
import { Card } from "@/components/ui/card"

// Ports the legacy .chart-card/.stat-card pattern — a small metric tile with a
// label, a big value (optionally colored), an optional progress bar, an optional
// breakdown line, and optional click-through navigation. Used for both the Home
// stat strip and the dashboard/goals/wellness card grids.
export function ChartCard({
  label,
  value,
  valueColor,
  breakdown,
  bar,
  onClick,
  className,
}: {
  label: string
  value: React.ReactNode
  valueColor?: string
  breakdown?: React.ReactNode
  bar?: React.ReactNode
  onClick?: () => void
  className?: string
}) {
  return (
    <Card
      onClick={onClick}
      className={cn(
        "gap-1",
        onClick && "hover:border-muted-foreground/40 cursor-pointer transition-colors",
        className,
      )}
    >
      <div className="text-muted-foreground text-xs font-medium tracking-wider uppercase">{label}</div>
      <div className="font-mono text-xl font-bold tabular-nums" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </div>
      {bar}
      {breakdown != null && <div className="text-muted-foreground text-xs">{breakdown}</div>}
    </Card>
  )
}

export function CardGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2 min-[900px]:grid-cols-3", className)}>{children}</div>
  )
}
