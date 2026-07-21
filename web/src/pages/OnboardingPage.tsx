import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useStravaStatus, useGarminStatus, useSettingsMutations } from "@/hooks/useSettings"
import { useGoals, useGoalMutations } from "@/hooks/useGoals"
import { GoalFormDialog } from "@/components/goals/GoalFormDialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

// Two real steps. A third step ("confirm training config", feeding Phase 4.2's
// UserTrainingConfig) is deliberately not built — that table/settings don't exist
// yet (Phase 4 hasn't started), so there's nothing real to confirm. Revisit once
// that phase ships rather than building a step that configures nothing.
type Step = "connect" | "goal"

export function OnboardingPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>("connect")

  const { data: stravaStatus } = useStravaStatus()
  const { data: garminStatus } = useGarminStatus()
  const { saveGarminConnection } = useSettingsMutations()
  const { data: goals } = useGoals()
  const { createGoal } = useGoalMutations()

  const [garminUsername, setGarminUsername] = useState("")
  const [garminPassword, setGarminPassword] = useState("")
  const [goalDialogOpen, setGoalDialogOpen] = useState(false)

  return (
    <div className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-6 px-4 py-8">
      <div>
        <h1 className="font-mono text-xl font-bold tracking-tight">
          HAL<span className="text-primary">E</span>
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">Let's get your account set up.</p>
      </div>

      {step === "connect" && (
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold">Step 1 of 2 — Connect a data source</h2>

          <div className="border-border rounded-lg border p-4">
            <div className="text-sm font-medium">Strava</div>
            <div className="text-muted-foreground mt-1 text-xs">
              {stravaStatus?.connected ? "Connected" : "Official OAuth, recommended as your primary source."}
            </div>
            {!stravaStatus?.connected && (
              <Button size="sm" className="mt-2" asChild>
                <a href="/auth/strava/login">Connect Strava</a>
              </Button>
            )}
          </div>

          <div className="border-border rounded-lg border p-4">
            <div className="text-sm font-medium">
              Garmin <span className="text-hale-faint font-normal">(optional, unofficial)</span>
            </div>
            {garminStatus?.configured ? (
              <div className="text-muted-foreground mt-1 text-xs">Configured</div>
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <Label>Garmin email</Label>
                  <Input value={garminUsername} onChange={(e) => setGarminUsername(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>Garmin password</Label>
                  <Input
                    type="password"
                    value={garminPassword}
                    onChange={(e) => setGarminPassword(e.target.value)}
                  />
                </div>
                <Button
                  size="sm"
                  disabled={!garminUsername || !garminPassword || saveGarminConnection.isPending}
                  onClick={() =>
                    saveGarminConnection.mutate({ username: garminUsername.trim(), password: garminPassword })
                  }
                >
                  {saveGarminConnection.isPending ? "Saving…" : "Save connection"}
                </Button>
              </div>
            )}
          </div>

          <Button onClick={() => setStep("goal")}>Continue</Button>
        </div>
      )}

      {step === "goal" && (
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold">Step 2 of 2 — Set a goal</h2>
          <p className="text-muted-foreground text-sm">
            Add a race, a consistency target, or a distance goal — or skip this for now.
          </p>
          {goals && goals.length > 0 ? (
            <div className="text-hale-good text-sm">
              {goals.length} goal{goals.length === 1 ? "" : "s"} set.
            </div>
          ) : (
            <Button variant="outline" onClick={() => setGoalDialogOpen(true)}>
              + Add a goal
            </Button>
          )}
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => navigate("/")}>
              Skip
            </Button>
            <Button className="flex-1" onClick={() => navigate("/")}>
              Done
            </Button>
          </div>
        </div>
      )}

      <GoalFormDialog
        open={goalDialogOpen}
        onOpenChange={setGoalDialogOpen}
        goal={null}
        onSave={(body) => createGoal.mutate(body)}
      />
    </div>
  )
}
