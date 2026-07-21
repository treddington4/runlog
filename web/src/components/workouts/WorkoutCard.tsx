import * as React from "react"
import type { Workout, WorkoutStep } from "@/lib/api"
import { WORKOUT_TYPE_LABELS, WORKOUT_STATUS_COLORS } from "@/lib/workouts"
import { paceStr } from "@/lib/format"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

// Ports workoutStepLineHTML() — how-to guidance collapses behind <details> by
// default so a 20+ step routine stays scannable.
function WorkoutStepLine({ step }: { step: WorkoutStep }) {
  const amount = []
  if (step.durationSec) amount.push(`${step.durationSec}s`)
  if (step.reps) amount.push(`${step.reps} reps`)
  const line = (
    <>
      {step.exercise}
      {step.side ? ` (${step.side})` : ""}
      {amount.length ? ` — ${amount.join(", ")}` : ""}
      {step.notes ? ` · ${step.notes}` : ""}
    </>
  )
  if (step.howTo) {
    return (
      <li>
        <details>
          <summary className="cursor-pointer">{line}</summary>
          <div className="bg-background text-muted-foreground mt-1 rounded-md p-2 leading-relaxed">
            {step.howTo}
          </div>
        </details>
      </li>
    )
  }
  return <li>{line}</li>
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}

export function WorkoutCard({
  workout,
  onEdit,
  onDelete,
}: {
  workout: Workout
  onEdit: () => void
  onDelete: () => void
}) {
  const targetParts = []
  if (workout.targetDistanceMi) targetParts.push(`${workout.targetDistanceMi} mi`)
  if (workout.targetPaceSecPerMi) targetParts.push(`${paceStr(workout.targetPaceSecPerMi)}/mi`)
  if (workout.targetDurationSec) targetParts.push(`${Math.round(workout.targetDurationSec / 60)} min`)

  return (
    <Card className="gap-2">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">
          {workout.scheduledDate} · {WORKOUT_TYPE_LABELS[workout.workoutType] || workout.workoutType} (
          {workout.activityType})
          {workout.source === "garmin" && (
            <span className="border-border bg-secondary text-muted-foreground ml-2 rounded border px-1.5 py-0.5 text-[10px]">
              Garmin Suggested
            </span>
          )}
        </span>
        <span style={{ color: WORKOUT_STATUS_COLORS[workout.status] }}>{workout.status}</span>
      </div>
      {targetParts.length > 0 && <Row label="Target" value={targetParts.join(" · ")} />}
      {workout.notes && <Row label="Notes" value={<span className="font-normal whitespace-pre-line">{workout.notes}</span>} />}
      {workout.steps && workout.steps.length > 0 && (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {workout.steps.map((s, i) => (
            <WorkoutStepLine key={i} step={s} />
          ))}
        </ol>
      )}
      {workout.critiqueText && <Row label="Critique" value={<span className="font-normal">{workout.critiqueText}</span>} />}
      <div className="mt-1 flex gap-3">
        <Button variant="link" size="sm" className="h-auto p-0" onClick={onEdit}>
          Edit
        </Button>
        <Button variant="link" size="sm" className="text-hale-hot h-auto p-0" onClick={onDelete}>
          Delete
        </Button>
      </div>
    </Card>
  )
}
