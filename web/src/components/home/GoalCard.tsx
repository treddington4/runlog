import * as React from "react"
import { useNavigate } from "react-router-dom"
import type { Goal } from "@/lib/api"
import { paceStr, timeStr, fmtGoalDate } from "@/lib/format"
import { ChartCard } from "./ChartCard"
import { DashBar } from "./DashBar"
import { Button } from "@/components/ui/button"

// Ports the legacy goalCardBody() dispatch (app.js) — one card body per goal type,
// each surfacing whatever progress.py's goal_progress() computed server-side.
function goalCardBody(g: Goal): { value: React.ReactNode; breakdown: React.ReactNode; bar?: React.ReactNode } {
  const p = g.progress
  if (g.goalType === "race") {
    const days = p.daysUntil
    const linked = p.linkedRun
    let statusLine: React.ReactNode
    if (days == null) statusLine = "--"
    else if (days > 0) statusLine = `${days}d`
    else if (days === 0) statusLine = "Race day!"
    else if (linked) statusLine = `${linked.distanceMi} mi`
    else statusLine = "Race day passed"

    const breakdown = linked
      ? `Finished in ${timeStr(linked.movingTimeSec)}${linked.avgPaceSecPerMi ? " · " + paceStr(linked.avgPaceSecPerMi) + "/mi" : ""} on ${fmtGoalDate(linked.date)}`
      : `${fmtGoalDate(g.targetDate)} · ${p.recent28DayMiles ?? 0} mi (${g.activityTypes.join("+")}) last 28 days`

    return { value: statusLine, breakdown }
  }
  if (g.goalType === "consistency") {
    const targetLabel = g.targetUnit === "runs_per_week" ? `${g.targetValue}x/week` : `${g.targetValue} mi/week`
    return {
      value: `${p.streakWeeks ?? 0} wk streak`,
      breakdown: `Target ${targetLabel} · this week: ${p.currentWeekRunCount ?? 0} runs, ${p.currentWeekMiles ?? 0} mi`,
    }
  }
  // distance_target
  const pct = p.pctComplete
  return {
    value: `${p.completedMi ?? 0} / ${g.targetValue} mi`,
    bar: pct != null ? <DashBar pct={pct} color={pct >= 100 ? "var(--hale-good)" : "var(--hale-gold)"} /> : undefined,
    breakdown: `${pct != null ? pct + "% complete" : ""}${g.targetDate ? " · by " + fmtGoalDate(g.targetDate) : ""}`,
  }
}

// The Goals tab passes onEdit/onComplete/onAbandon/onDelete to render the
// legacy renderGoalCards()'s action row (Edit/Mark complete/Abandon/Delete) —
// Home's usage omits all of these and just gets a plain card.
export function GoalCard({
  goal,
  linkToGoalsTab,
  onEdit,
  onComplete,
  onAbandon,
  onDelete,
}: {
  goal: Goal
  linkToGoalsTab?: boolean
  onEdit?: () => void
  onComplete?: () => void
  onAbandon?: () => void
  onDelete?: () => void
}) {
  const navigate = useNavigate()
  const { value, breakdown, bar } = goalCardBody(goal)
  const hasActions = onEdit || onComplete || onAbandon || onDelete
  return (
    <ChartCard
      label={goal.name}
      value={value}
      breakdown={breakdown}
      bar={bar}
      onClick={linkToGoalsTab ? () => navigate("/goals") : undefined}
      actions={
        hasActions ? (
          <div className="mt-1 flex flex-wrap gap-3">
            {onEdit && (
              <Button variant="link" size="sm" className="h-auto p-0" onClick={onEdit}>
                Edit
              </Button>
            )}
            {goal.status === "active" && onComplete && (
              <Button variant="link" size="sm" className="h-auto p-0" onClick={onComplete}>
                Mark complete
              </Button>
            )}
            {goal.status === "active" && onAbandon && (
              <Button variant="link" size="sm" className="h-auto p-0" onClick={onAbandon}>
                Abandon
              </Button>
            )}
            {onDelete && (
              <Button variant="link" size="sm" className="text-hale-hot h-auto p-0" onClick={onDelete}>
                Delete
              </Button>
            )}
          </div>
        ) : undefined
      }
    />
  )
}
