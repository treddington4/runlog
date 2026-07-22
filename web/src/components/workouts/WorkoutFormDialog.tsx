import { useEffect, useState } from "react"
import type { Workout, WorkoutInput, WorkoutType, StrengthStep, SetTargetType } from "@/lib/api"
import { WORKOUT_TYPE_LABELS, parsePaceToSec } from "@/lib/workouts"
import { paceStr } from "@/lib/format"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"

function emptyForm(workout: Workout | null) {
  return {
    scheduledDate: workout?.scheduledDate ?? "",
    workoutType: (workout?.workoutType ?? "easy") as WorkoutType,
    activityType: workout?.activityType ?? "",
    targetDistanceMi: workout?.targetDistanceMi?.toString() ?? "",
    targetPaceSecPerMi: workout?.targetPaceSecPerMi ? paceStr(workout.targetPaceSecPerMi) : "",
    targetDurationSec: workout?.targetDurationSec ? String(Math.round(workout.targetDurationSec / 60)) : "",
    notes: workout?.notes ?? "",
  }
}

// Phase 4.4 — one row in the strength-step editor: authored as "N sets of the same
// target" (matching how a real prescription reads, "3x8-12 @ 45lb") rather than
// editing every individual set — per-set *actuals* are what genuinely vary and get
// logged live via the Phase 4.5 workout-runner, not authored here.
interface StrengthStepForm {
  exercise: string
  restSeconds: string
  setCount: string
  targetType: SetTargetType
  targetReps: string
  targetHoldSec: string
  targetWeightLb: string
}

function emptyStrengthStepForm(): StrengthStepForm {
  return { exercise: "", restSeconds: "60", setCount: "3", targetType: "reps", targetReps: "10", targetHoldSec: "30", targetWeightLb: "" }
}

function strengthStepsToForms(steps: Workout["steps"]): StrengthStepForm[] {
  const strengthSteps = (steps ?? []).filter((s): s is StrengthStep => s.stepType === "strength_exercise")
  return strengthSteps.map((s) => {
    const first = s.sets[0]
    return {
      exercise: s.exercise, restSeconds: String(s.restSeconds), setCount: String(s.sets.length),
      targetType: first?.targetType ?? "reps",
      targetReps: first?.targetReps != null ? String(first.targetReps) : "10",
      targetHoldSec: first?.targetHoldSec != null ? String(first.targetHoldSec) : "30",
      targetWeightLb: first?.targetWeightLb != null ? String(first.targetWeightLb) : "",
    }
  })
}

function formsToStrengthSteps(forms: StrengthStepForm[]): StrengthStep[] {
  return forms
    .filter((f) => f.exercise.trim())
    .map((f) => {
      const setCount = Math.max(1, Number(f.setCount) || 1)
      return {
        stepType: "strength_exercise" as const,
        exercise: f.exercise.trim(),
        restSeconds: Number(f.restSeconds) || 0,
        sets: Array.from({ length: setCount }, (_, i) => ({
          index: i,
          targetType: f.targetType,
          targetReps: f.targetType === "reps" ? Number(f.targetReps) || null : null,
          targetHoldSec: f.targetType === "hold_sec" ? Number(f.targetHoldSec) || null : null,
          targetWeightLb: f.targetWeightLb ? Number(f.targetWeightLb) : null,
          actualReps: null, actualHoldSec: null, actualWeightLb: null, completedAt: null,
        })),
      }
    })
}

export function WorkoutFormDialog({
  open,
  onOpenChange,
  workout,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workout: Workout | null
  onSave: (body: WorkoutInput) => void
}) {
  const [form, setForm] = useState(() => emptyForm(workout))
  const [strengthSteps, setStrengthSteps] = useState<StrengthStepForm[]>(() => strengthStepsToForms(workout?.steps ?? null))

  // Reset the form whenever the dialog opens for a (possibly different) workout —
  // not on every `workout` change, since that would also fire while it's closed.
  useEffect(() => {
    if (open) {
      setForm(emptyForm(workout))
      setStrengthSteps(strengthStepsToForms(workout?.steps ?? null))
    }
  }, [open, workout])

  const isEdit = !!workout
  const isStrength = form.workoutType === "strength"

  function updateStep(i: number, patch: Partial<StrengthStepForm>) {
    setStrengthSteps(strengthSteps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  }

  function save() {
    if (!form.scheduledDate) return
    const durationMin = Number(form.targetDurationSec)
    onSave({
      scheduledDate: form.scheduledDate,
      workoutType: form.workoutType,
      activityType: form.activityType || null,
      targetDistanceMi: Number(form.targetDistanceMi) || null,
      targetPaceSecPerMi: parsePaceToSec(form.targetPaceSecPerMi),
      targetDurationSec: durationMin ? durationMin * 60 : null,
      notes: form.notes,
      steps: isStrength ? formsToStrengthSteps(strengthSteps) : undefined,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Workout" : "New Workout"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Date</Label>
            <Input
              type="date"
              value={form.scheduledDate}
              onChange={(e) => setForm({ ...form, scheduledDate: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Type</Label>
            <Select
              value={form.workoutType}
              onValueChange={(v) => setForm({ ...form, workoutType: v as WorkoutType })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(WORKOUT_TYPE_LABELS).map(([v, label]) => (
                  <SelectItem key={v} value={v}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Activity</Label>
            <Input
              placeholder="Run — leave blank for rest/cross-train days that aren't a real run/ride"
              value={form.activityType}
              onChange={(e) => setForm({ ...form, activityType: e.target.value })}
            />
          </div>
          {isStrength ? (
            <div className="flex flex-col gap-2">
              <Label>Exercises</Label>
              {strengthSteps.map((s, i) => (
                <div key={i} className="border-border flex flex-col gap-2 rounded-md border p-2.5">
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder="Exercise (e.g. Goblet Squat)"
                      value={s.exercise}
                      onChange={(e) => updateStep(i, { exercise: e.target.value })}
                    />
                    <Button
                      variant="link" size="sm" className="text-hale-hot h-auto shrink-0 p-0"
                      onClick={() => setStrengthSteps(strengthSteps.filter((_, idx) => idx !== i))}
                    >
                      Remove
                    </Button>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs">Sets</Label>
                      <Input type="number" value={s.setCount} onChange={(e) => updateStep(i, { setCount: e.target.value })} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs">Type</Label>
                      <Select value={s.targetType} onValueChange={(v) => updateStep(i, { targetType: v as SetTargetType })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="reps">Reps</SelectItem>
                          <SelectItem value="hold_sec">Hold</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {s.targetType === "reps" ? (
                      <div className="flex flex-col gap-1">
                        <Label className="text-xs">Reps</Label>
                        <Input type="number" value={s.targetReps} onChange={(e) => updateStep(i, { targetReps: e.target.value })} />
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <Label className="text-xs">Hold (s)</Label>
                        <Input type="number" value={s.targetHoldSec} onChange={(e) => updateStep(i, { targetHoldSec: e.target.value })} />
                      </div>
                    )}
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs">Weight (lb)</Label>
                      <Input
                        type="number" placeholder="bodyweight" value={s.targetWeightLb}
                        onChange={(e) => updateStep(i, { targetWeightLb: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Rest between sets (s)</Label>
                    <Input
                      type="number" className="w-24" value={s.restSeconds}
                      onChange={(e) => updateStep(i, { restSeconds: e.target.value })}
                    />
                  </div>
                </div>
              ))}
              <Button
                variant="outline" size="sm"
                onClick={() => setStrengthSteps([...strengthSteps, emptyStrengthStepForm()])}
              >
                + Add exercise
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label>Target distance (mi)</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={form.targetDistanceMi}
                  onChange={(e) => setForm({ ...form, targetDistanceMi: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Target pace (min:sec/mi)</Label>
                <Input
                  placeholder="8:00"
                  value={form.targetPaceSecPerMi}
                  onChange={(e) => setForm({ ...form, targetPaceSecPerMi: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Target duration (min)</Label>
                <Input
                  type="number"
                  step="1"
                  value={form.targetDurationSec}
                  onChange={(e) => setForm({ ...form, targetDurationSec: e.target.value })}
                />
              </div>
            </>
          )}
          <div className="flex flex-col gap-1.5">
            <Label>Notes</Label>
            <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <Button onClick={save}>{isEdit ? "Save" : "Create Workout"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
