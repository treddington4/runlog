// Typed client over the existing FastAPI backend. Endpoint paths and response
// shapes are unchanged by the Phase 0 rewrite (see PLAN.md 0.1) — this file
// grows tab-by-tab as each port needs more endpoints, it does not attempt to
// cover the whole API up front.

import type { Run } from "./runs"

export interface HeaderStats {
  totalActivityCount: number
  runCountAllTime: number
  avgPaceSecPerMiAllTime: number | null
  weekMileageRun: number
}

export interface WeekMileage {
  weekStart: string
  totalMiles: number
  runCount: number
}

export interface MonthMileage {
  month: string
  totalMiles: number
  runCount: number
}

export interface TrainingLoad {
  last28DaysMiles: number
  prior28DaysMiles: number
  pctChange: number | null
  direction: "up" | "down" | "steady"
}

export interface ConsistencyStreak {
  streakWeeks: number
  minMiles: number
  minRuns: number | null
}

export interface DaysSinceRun {
  days: number
  date: string
  distanceMi?: number
  runId: string
  name?: string
}

export interface PersonalRecord {
  runId: string
  date: string
  name: string
  value: number
}

export interface PersonalRecords {
  longestRun: PersonalRecord | null
  fastestPace: PersonalRecord | null
  mostElevation: PersonalRecord | null
  longestDuration: PersonalRecord | null
}

export interface PaceTrendPoint {
  date: string
  paceSecPerMi: number
}

export interface DashboardSummary {
  weeklyMileage: WeekMileage[]
  trainingLoad: TrainingLoad
  consistencyStreak: ConsistencyStreak
  daysSinceLongestRun: DaysSinceRun | null
  daysSinceLastRun: DaysSinceRun | null
  paceTrend: PaceTrendPoint[]
  personalRecords: PersonalRecords
  monthlyMileage: MonthMileage[]
  headerStats: HeaderStats
}

export interface WellnessDay {
  date: string
  restingHrBpm: number | null
  vo2max: number | null
  sleepScore: number | null
  sleepSeconds: number | null
  deepSleepSeconds: number | null
  lightSleepSeconds: number | null
  remSleepSeconds: number | null
  awakeSleepSeconds: number | null
}

export type GoalType = "race" | "consistency" | "distance_target"
export type GoalStatus = "active" | "completed" | "abandoned"

export interface LinkedRun {
  runId: string
  name: string
  date: string
  distanceMi: number | null
  movingTimeSec: number | null
  avgPaceSecPerMi: number | null
}

export interface GoalProgress {
  goalType: GoalType
  // race
  daysUntil?: number | null
  recent28DayMiles?: number
  recent28DayRunCount?: number
  linkedRun?: LinkedRun
  // consistency
  streakWeeks?: number
  currentWeekMiles?: number
  currentWeekRunCount?: number
  // distance_target
  completedMi?: number
  pctComplete?: number | null
  daysRemaining?: number | null
}

export interface Goal {
  id: string
  goalType: GoalType
  name: string
  status: GoalStatus
  activityTypes: string[]
  targetValue: number | null
  targetUnit: string | null
  targetDate: string | null
  startDate: string | null
  notes: string
  priority: number
  createdAt: string
  completedAt: string | null
  progress: GoalProgress
}

class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  })
  if (!res.ok) {
    throw new ApiError(res.status, `${init?.method ?? "GET"} ${path} failed: ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  dashboardSummary: () => request<DashboardSummary>("/api/dashboard/summary"),
  goals: () => request<Goal[]>("/api/goals"),
  runs: () => request<Run[]>("/api/runs"),
  wellness: (days = 30) => request<WellnessDay[]>(`/api/wellness?days=${days}`),
}
