import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams, Link } from "react-router-dom"
import type { StrengthStep, WorkoutStep } from "@/lib/api"
import { useWorkouts, useWorkoutMutations } from "@/hooks/useWorkouts"
import { useCountdown } from "@/hooks/useCountdown"
import { playBeep } from "@/lib/beep"
import { DashBar } from "@/components/home/DashBar"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

const GET_READY_SEC = 5

interface RunnerSet {
  stepIndex: number
  setIndex: number
  exercise: string
  restSeconds: number
  targetType: "reps" | "hold_sec"
  targetReps: number | null
  targetHoldSec: number | null
  targetWeightLb: number | null
}

interface LoggedActual {
  actualReps?: number | null
  actualHoldSec?: number | null
  actualWeightLb?: number | null
}

// "getReady"/"hold" only apply to hold-based sets; "log" is a rep-based set waiting
// on manual weight/reps entry; "rest" runs between every set except the very last.
type SubPhase = "init" | "getReady" | "hold" | "log" | "rest" | "finished"

export function WorkoutRunnerPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data: workouts } = useWorkouts()
  const { updateWorkout } = useWorkoutMutations()
  const countdown = useCountdown()

  const workout = workouts?.find((w) => w.id === id) ?? null

  // Only strength_exercise steps drive the runner — endurance steps (warmup/active/
  // rest/cooldown) are GPS-tracked externally via Strava/Garmin, not a manual timer.
  const runnerSets = useMemo<RunnerSet[]>(() => {
    const out: RunnerSet[] = []
    workout?.steps?.forEach((step, stepIndex) => {
      if (step.stepType !== "strength_exercise") return
      const s = step as StrengthStep
      s.sets.forEach((set, setIndex) => {
        out.push({
          stepIndex,
          setIndex,
          exercise: s.exercise,
          restSeconds: s.restSeconds,
          targetType: set.targetType,
          targetReps: set.targetReps,
          targetHoldSec: set.targetHoldSec,
          targetWeightLb: set.targetWeightLb,
        })
      })
    })
    return out
  }, [workout])

  const [position, setPosition] = useState(0)
  const [subPhase, setSubPhase] = useState<SubPhase>("init")
  const [actuals, setActuals] = useState<Record<string, LoggedActual>>({})
  const [repsInput, setRepsInput] = useState("")
  const [weightInput, setWeightInput] = useState("")

  function recordActual(set: RunnerSet, actual: LoggedActual) {
    setActuals((prev) => ({ ...prev, [`${set.stepIndex}-${set.setIndex}`]: actual }))
  }

  function goToSet(idx: number) {
    const set = runnerSets[idx]
    if (!set) {
      setSubPhase("finished")
      return
    }
    setPosition(idx)
    if (set.targetType === "hold_sec") {
      setSubPhase("getReady")
      countdown.start(GET_READY_SEC, () => {
        playBeep()
        setSubPhase("hold")
        countdown.start(set.targetHoldSec ?? 0, () => {
          playBeep()
          recordActual(set, { actualHoldSec: set.targetHoldSec })
          afterSetLogged(idx, set)
        })
      })
    } else {
      setRepsInput(set.targetReps != null ? String(set.targetReps) : "")
      setWeightInput(set.targetWeightLb != null ? String(set.targetWeightLb) : "")
      setSubPhase("log")
    }
  }

  function afterSetLogged(idx: number, set: RunnerSet) {
    if (idx >= runnerSets.length - 1) {
      setSubPhase("finished")
      return
    }
    setSubPhase("rest")
    countdown.start(set.restSeconds, () => {
      playBeep()
      goToSet(idx + 1)
    })
  }

  function handleLogSet() {
    const set = runnerSets[position]
    recordActual(set, {
      actualReps: repsInput ? Number(repsInput) : null,
      actualWeightLb: weightInput ? Number(weightInput) : null,
    })
    afterSetLogged(position, set)
  }

  // Kicks off the very first set once the workout (and its steps) have loaded —
  // doesn't attempt to resume mid-workout on a page reload (a known v1 limitation,
  // same "explicitly bounded, not a guess at unstated requirements" spirit as the
  // generator's own v1 exercise template).
  useEffect(() => {
    if (subPhase === "init" && runnerSets.length > 0) {
      goToSet(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runnerSets.length, subPhase])

  function buildFinishedSteps(): WorkoutStep[] {
    if (!workout?.steps) return []
    return workout.steps.map((step, stepIndex) => {
      if (step.stepType !== "strength_exercise") return step
      return {
        ...step,
        sets: step.sets.map((s, setIndex) => {
          const a = actuals[`${stepIndex}-${setIndex}`]
          if (!a) return s
          return {
            ...s,
            actualReps: a.actualReps ?? s.actualReps,
            actualHoldSec: a.actualHoldSec ?? s.actualHoldSec,
            actualWeightLb: a.actualWeightLb ?? s.actualWeightLb,
            completedAt: new Date().toISOString(),
          }
        }),
      }
    })
  }

  function handleFinish() {
    if (!workout) return
    updateWorkout.mutate(
      { id: workout.id, body: { steps: buildFinishedSteps(), status: "completed" } },
      { onSuccess: () => navigate("/workouts", { replace: true }) },
    )
  }

  if (workouts === undefined) {
    return (
      <div className="mx-auto max-w-md px-4 py-8">
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!workout || runnerSets.length === 0) {
    return (
      <div className="mx-auto flex min-h-svh max-w-md flex-col items-center justify-center gap-4 px-4 py-8 text-center">
        <p className="text-muted-foreground text-sm">
          {workout ? "This workout has no strength exercises to run." : "Workout not found."}
        </p>
        <Link to="/workouts" className="text-primary text-sm underline">
          Back to Workouts
        </Link>
      </div>
    )
  }

  const set = runnerSets[position]
  const totalSets = runnerSets.length

  return (
    <div className="mx-auto flex min-h-svh max-w-md flex-col gap-6 px-4 py-8">
      <div className="flex items-baseline justify-between">
        <h1 className="font-mono text-lg font-bold tracking-tight">
          HAL<span className="text-primary">E</span>
        </h1>
        <Link to="/workouts" className="text-muted-foreground text-xs underline">
          Exit
        </Link>
      </div>

      {subPhase === "finished" ? (
        <Card className="items-center gap-4 text-center">
          <p className="text-lg font-semibold">Workout complete</p>
          <p className="text-muted-foreground text-sm">
            {totalSets} set{totalSets === 1 ? "" : "s"} logged across{" "}
            {new Set(runnerSets.map((s) => s.stepIndex)).size} exercise
            {new Set(runnerSets.map((s) => s.stepIndex)).size === 1 ? "" : "s"}.
          </p>
          <Button onClick={handleFinish} disabled={updateWorkout.isPending}>
            {updateWorkout.isPending ? "Saving…" : "Finish Workout"}
          </Button>
        </Card>
      ) : (
        <>
          <p className="text-muted-foreground text-center text-xs">
            Set {position + 1} of {totalSets}
          </p>

          <Card className="items-center gap-3 py-8 text-center">
            <p className="text-xl font-semibold">{set.exercise}</p>

            {subPhase === "getReady" && (
              <>
                <p className="text-muted-foreground text-sm">Get ready…</p>
                <p className="font-mono text-6xl font-bold tabular-nums">{countdown.remaining}</p>
                <DashBar pct={((GET_READY_SEC - countdown.remaining) / GET_READY_SEC) * 100} color="var(--hale-hot)" />
              </>
            )}

            {subPhase === "hold" && (
              <>
                <p className="text-muted-foreground text-sm">Hold</p>
                <p className="font-mono text-6xl font-bold tabular-nums">{countdown.remaining}</p>
                <DashBar
                  pct={((set.targetHoldSec ?? 1) - countdown.remaining) / (set.targetHoldSec || 1) * 100}
                  color="var(--hale-good)"
                />
                <Button variant="link" size="sm" onClick={countdown.skip}>
                  Skip
                </Button>
              </>
            )}

            {subPhase === "log" && (
              <>
                <p className="text-muted-foreground text-sm">Target: {set.targetReps} reps{set.targetWeightLb ? ` @ ${set.targetWeightLb}lb` : ""}</p>
                <div className="flex w-full gap-3">
                  <div className="flex-1 text-left">
                    <label className="text-muted-foreground text-xs">Reps</label>
                    <Input
                      type="number"
                      value={repsInput}
                      onChange={(e) => setRepsInput(e.target.value)}
                      inputMode="numeric"
                    />
                  </div>
                  <div className="flex-1 text-left">
                    <label className="text-muted-foreground text-xs">Weight (lb)</label>
                    <Input
                      type="number"
                      value={weightInput}
                      onChange={(e) => setWeightInput(e.target.value)}
                      inputMode="decimal"
                    />
                  </div>
                </div>
                <Button className="w-full" onClick={handleLogSet}>
                  Log Set
                </Button>
              </>
            )}

            {subPhase === "rest" && (
              <>
                <p className="text-muted-foreground text-sm">Rest</p>
                <p className="font-mono text-6xl font-bold tabular-nums">{countdown.remaining}</p>
                <DashBar
                  pct={((set.restSeconds - countdown.remaining) / (set.restSeconds || 1)) * 100}
                  color="var(--hale-faint)"
                />
                <Button variant="link" size="sm" onClick={countdown.skip}>
                  Skip Rest
                </Button>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
