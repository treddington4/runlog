// Typed client over the existing FastAPI backend. Endpoint paths and response
// shapes are unchanged by the Phase 0 rewrite (see PLAN.md 0.1) — this file
// grows tab-by-tab as each port needs more endpoints, it does not attempt to
// cover the whole API up front.

export interface HeaderStats {
  totalActivityCount: number
  runCountAllTime: number
  avgPaceSecPerMiAllTime: number | null
  weekMileageRun: number
}

export interface DashboardSummary {
  weeklyMileage: unknown
  trainingLoad: unknown
  consistencyStreak: unknown
  daysSinceLongestRun: number | null
  daysSinceLastRun: number | null
  paceTrend: unknown
  personalRecords: unknown
  monthlyMileage: unknown
  headerStats: HeaderStats
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
}
