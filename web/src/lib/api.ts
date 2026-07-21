// Typed client over the existing FastAPI backend. Endpoint paths and response
// shapes are unchanged by the Phase 0 rewrite (see PLAN.md 0.1) — this file
// grows tab-by-tab as each port needs more endpoints, it does not attempt to
// cover the whole API up front.

export type { Run } from "./runs"
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

export interface DailyStepsPoint {
  date: string
  steps: number | null
}

export interface GeocodeResult {
  label: string
  cached: boolean
}

export interface ToolCall {
  tool: string
  input: Record<string, unknown>
}

export interface ChartSpec {
  chartType: "line" | "bar"
  title: string
  labels: string[]
  datasets: { label: string; data: number[] }[]
}

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
  toolCalls: ToolCall[] | null
  charts: ChartSpec[] | null
  createdAt?: string
}

export interface ChatStatus {
  configured: boolean
}

export type CoachPersonality = "encouraging" | "normal" | "spicy" | "insulting"

// Deliberately never throws — mirrors the legacy send() closure's distinction
// between an HTTP error (server responded, has a `detail` message) and a
// network/fetch failure (no response at all), which get different display text.
export type ChatSendResult =
  | { ok: true; reply: string; toolCalls: ToolCall[]; charts: ChartSpec[] }
  | { ok: false; kind: "http" | "network"; message: string }

export interface SleepStageSegment {
  stage: string
  start: string
  end: string
}

export interface SleepStagesResponse {
  availableDates: string[]
  date: string | null
  segments: SleepStageSegment[]
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

export type WorkoutType = "easy" | "tempo" | "interval" | "long" | "rest" | "strength" | "cross_train"
export type WorkoutStatus = "planned" | "completed" | "skipped" | "modified"

export interface WorkoutStep {
  exercise: string
  side: string | null
  durationSec: number | null
  reps: number | null
  notes: string | null
  howTo: string | null
}

export interface Workout {
  id: string
  scheduledDate: string
  workoutType: WorkoutType
  activityType: string
  targetDistanceMi: number | null
  targetPaceSecPerMi: number | null
  targetDurationSec: number | null
  notes: string | null
  steps: WorkoutStep[] | null
  status: WorkoutStatus
  linkedRunId: string | null
  critiqueText: string | null
  createdAt: string
  source: string
}

export interface WorkoutInput {
  scheduledDate: string
  workoutType: WorkoutType
  activityType: string | null
  targetDistanceMi: number | null
  targetPaceSecPerMi: number | null
  targetDurationSec: number | null
  notes: string
}

export interface RecoveryTool {
  id: string
  name: string
  category: string
  minLevel: number
  maxLevel: number
  minDurationMin: number
  maxDurationMin: number
  durationIncrementMin: number
  supportsZoneBoost: boolean
  notes: string | null
}

export type RecoverySessionStatus = "planned" | "completed" | "skipped"

export interface RecoverySession {
  id: string
  toolId: string
  scheduledDate: string
  level: number
  durationMin: number
  zoneBoost: boolean
  rationale: string | null
  status: RecoverySessionStatus
  createdAt: string
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

export interface Config {
  syncIntervalHours: number
  syncActivityLimit: number
  restingHrBpm: number | null
}

export interface RunsQuery {
  start?: string
  end?: string
  all?: boolean
}

export interface RunUpdate {
  type?: string
  tempF?: number | null
  weatherCondition?: string | null
  rpe?: number | null
  isTreadmill?: boolean
  notes?: string
}

export const api = {
  dashboardSummary: () => request<DashboardSummary>("/api/dashboard/summary"),
  config: () => request<Config>("/api/config"),
  goals: () => request<Goal[]>("/api/goals"),
  runs: (query: RunsQuery = {}) => {
    const params = new URLSearchParams()
    if (query.all) params.set("all", "true")
    if (query.start) params.set("start", query.start)
    if (query.end) params.set("end", query.end)
    const qs = params.toString()
    return request<Run[]>(`/api/runs${qs ? `?${qs}` : ""}`)
  },
  wellness: (days = 30) => request<WellnessDay[]>(`/api/wellness?days=${days}`),
  steps: (days = 30) => request<DailyStepsPoint[]>(`/api/steps?days=${days}`),
  geocode: (lat: number, lon: number) => request<GeocodeResult>(`/api/geocode?lat=${lat}&lon=${lon}`),

  chatStatus: () => request<ChatStatus>("/api/chat/status"),
  coachPersonality: () => request<{ personality: CoachPersonality }>("/api/coach/personality"),
  chatHistory: () => request<ChatMessage[]>("/api/chat/history"),
  resetChat: () => request<{ status: string }>("/api/chat/reset", { method: "POST" }),
  sendChatMessage: async (message: string): Promise<ChatSendResult> => {
    try {
      const res = await fetch("/api/chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) return { ok: false, kind: "http", message: data.detail || "something went wrong" }
      return { ok: true, reply: data.reply, toolCalls: data.toolCalls ?? [], charts: data.charts ?? [] }
    } catch {
      return { ok: false, kind: "network", message: "Network error — try again." }
    }
  },
  sleepStages: (date?: string) =>
    request<SleepStagesResponse>(`/api/wellness/sleep-stages${date ? `?date=${date}` : ""}`),
  updateRun: (id: string, body: RunUpdate) =>
    request<Run>(`/api/runs/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  workouts: () => request<Workout[]>("/api/workouts"),
  createWorkout: (body: WorkoutInput) =>
    request<Workout>("/api/workouts", { method: "POST", body: JSON.stringify(body) }),
  updateWorkout: (id: string, body: Partial<WorkoutInput & { status: WorkoutStatus }>) =>
    request<Workout>(`/api/workouts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteWorkout: (id: string) => request<{ deleted: true }>(`/api/workouts/${id}`, { method: "DELETE" }),

  recoveryTools: () => request<RecoveryTool[]>("/api/recovery-tools"),
  recoverySessions: () => request<RecoverySession[]>("/api/recovery-sessions"),
  updateRecoverySessionStatus: (id: string, status: RecoverySessionStatus) =>
    request<RecoverySession>(`/api/recovery-sessions/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  deleteRecoverySession: (id: string) =>
    request<{ deleted: true }>(`/api/recovery-sessions/${id}`, { method: "DELETE" }),
}
