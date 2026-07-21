import type { WorkoutType } from "./api"

export const WORKOUT_TYPE_LABELS: Record<WorkoutType, string> = {
  easy: "Easy",
  tempo: "Tempo",
  interval: "Interval",
  long: "Long",
  rest: "Rest",
  strength: "Strength",
  cross_train: "Cross-train",
}

export const WORKOUT_STATUS_COLORS: Record<string, string> = {
  completed: "var(--hale-good)",
  skipped: "var(--hale-hot)",
  modified: "var(--hale-faint)",
  planned: "var(--hale-faint)",
}

export function parsePaceToSec(str: string): number | null {
  if (!str) return null
  const parts = str.trim().split(":")
  if (parts.length !== 2) return null
  const m = Number(parts[0])
  const s = Number(parts[1])
  if (!isFinite(m) || !isFinite(s)) return null
  return m * 60 + s
}
