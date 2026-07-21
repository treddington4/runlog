import { useEffect, useState } from "react"
import { api, type Goal } from "@/lib/api"

// Ports the legacy app.js renderRaceCountdown() logic (nearest active race-type
// goal, by targetDate) — but reads daysUntil from stats.goal_progress() (already
// computed server-side, see app/stats.py's Goal progress payload) instead of
// recomputing the date math client-side.
function nearestActiveRace(goals: Goal[]): Goal | null {
  const races = goals
    .filter((g) => g.goalType === "race" && g.status === "active" && g.targetDate)
    .filter((g) => (g.progress.daysUntil ?? -1) >= 0)
    .sort((a, b) => (a.targetDate as string).localeCompare(b.targetDate as string))
  return races[0] ?? null
}

export function RaceCountdown() {
  const [race, setRace] = useState<Goal | null>(null)

  useEffect(() => {
    api
      .goals()
      .then((goals) => setRace(nearestActiveRace(goals)))
      .catch(() => setRace(null))
  }, [])

  if (!race) return null
  const days = race.progress.daysUntil as number
  return (
    <span className="text-muted-foreground font-mono text-xs tabular-nums">
      {days > 0 ? `${days} days to ${race.name}` : "Race day!"}
    </span>
  )
}
