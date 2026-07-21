import { useEffect, useState } from "react"
import type { Workout, WorkoutInput, WorkoutType } from "@/lib/api"
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

  // Reset the form whenever the dialog opens for a (possibly different) workout —
  // not on every `workout` change, since that would also fire while it's closed.
  useEffect(() => {
    if (open) setForm(emptyForm(workout))
  }, [open, workout])

  const isEdit = !!workout

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
