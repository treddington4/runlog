import * as React from "react"
import type { Workout, WorkoutStep, EnduranceStep, StrengthStep } from "@/lib/api"
import { WORKOUT_TYPE_LABELS, WORKOUT_STATUS_COLORS } from "@/lib/workouts"
import { paceStr } from "@/lib/format"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

const STEP_TYPE_LABELS: Record<string, string> = {
  warmup: "Warm-up", active: "Active", rest: "Rest", cooldown: "Cool-down", repeat: "Repeat",
}

function enduranceTargetLabel(step: EnduranceStep): string | null {
  switch (step.targetType) {
    case "hr_zone":
      return step.targetZone ? `Zone ${step.targetZone}` : null
    case "hr_custom":
      return step.targetLow && step.targetHigh ? `${step.targetLow}-${step.targetHigh} bpm` : null
    case "power":
      return step.targetLow && step.targetHigh ? `${step.targetLow}-${step.targetHigh}W` : null
    case "pace":
      return step.targetLow && step.targetHigh ? `${step.targetLow}-${step.targetHigh} sec/km` : null
    case "cadence":
      return step.targetLow && step.targetHigh ? `${step.targetLow}-${step.targetHigh} spm` : null
    default:
      return null
  }
}

// Phase 4.2 — structured endurance steps (stepType present). `repeat` renders its
// children nested one level deep, matching the backend's "1 level only" rule.
function EnduranceStepLine({ step }: { step: EnduranceStep }) {
  if (step.stepType === "repeat") {
    return (
      <li>
        {step.repeatCount}× repeat:
        <ol className="list-disc space-y-1 py-1 pl-5">
          {(step.children ?? []).map((c, i) => (
            <WorkoutStepLine key={i} step={c} />
          ))}
        </ol>
      </li>
    )
  }
  const amount = []
  if (step.durationSec) amount.push(`${step.durationSec}s`)
  if (step.distanceM) amount.push(`${(step.distanceM / 1000).toFixed(2)}km`)
  const target = enduranceTargetLabel(step)
  return (
    <li>
      {STEP_TYPE_LABELS[step.stepType] ?? step.stepType}
      {amount.length ? ` — ${amount.join(", ")}` : ""}
      {target ? ` @ ${target}` : ""}
    </li>
  )
}

// Phase 4.4 — strength exercise: one set-count summary line, plus a per-set
// breakdown (target, and actuals once logged via the workout runner) collapsed
// behind <details> so a 5-exercise session's card doesn't get overwhelming.
function StrengthStepLine({ step }: { step: StrengthStep }) {
  const setSummaries = step.sets.map((s) => {
    const target = s.targetType === "hold_sec" ? `${s.targetHoldSec}s hold` : `${s.targetReps} reps`
    const weight = s.targetWeightLb ? ` @ ${s.targetWeightLb}lb` : ""
    const actual = s.actualReps != null || s.actualHoldSec != null || s.actualWeightLb != null
      ? ` — did: ${s.actualHoldSec != null ? `${s.actualHoldSec}s` : `${s.actualReps} reps`}${s.actualWeightLb ? ` @ ${s.actualWeightLb}lb` : ""}`
      : ""
    return `Set ${s.index + 1}: ${target}${weight}${actual}`
  })
  return (
    <li>
      <details>
        <summary className="cursor-pointer">
          {step.exercise} — {step.sets.length} set{step.sets.length === 1 ? "" : "s"}, {step.restSeconds}s rest
        </summary>
        <ul className="text-muted-foreground mt-1 space-y-0.5 pl-2 text-xs">
          {setSummaries.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </details>
    </li>
  )
}

// Ports workoutStepLineHTML() — how-to guidance collapses behind <details> by
// default so a 20+ step routine stays scannable.
function WorkoutStepLine({ step }: { step: WorkoutStep }) {
  if (step.stepType === "strength_exercise") return <StrengthStepLine step={step} />
  if (step.stepType) return <EnduranceStepLine step={step} />

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
