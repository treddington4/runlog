// Small inline progress bar used by several Home dashboard cards (consistency
// streak vs. weekly average, this-month-vs-last, goal completion %). Ports the
// legacy .dash-bar/.dash-bar-fill pair as a component.
export function DashBar({ pct, color }: { pct: number | null | undefined; color: string }) {
  const clamped = Math.max(0, Math.min(100, pct || 0))
  return (
    <div className="bg-background mt-2 h-1.5 overflow-hidden rounded-full">
      <div className="h-full rounded-full" style={{ width: `${clamped}%`, background: color }} />
    </div>
  )
}
