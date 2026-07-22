import type { ReactNode } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom"
import { queryClient } from "@/lib/queryClient"
import { getDemoSession } from "@/lib/demoAuth"
import { useDemoStatus } from "@/hooks/useDemoAuth"
import { Shell } from "@/components/layout/Shell"
import { HomePage } from "@/pages/HomePage"
import { WorkoutsPage } from "@/pages/WorkoutsPage"
import { ActivitiesPage } from "@/pages/ActivitiesPage"
import { InsightsPage } from "@/pages/InsightsPage"
import { MapPage } from "@/pages/MapPage"
import { ChatPage } from "@/pages/ChatPage"
import { GoalsPage } from "@/pages/GoalsPage"
import { SettingsPage } from "@/pages/SettingsPage"
import { OnboardingPage } from "@/pages/OnboardingPage"
import { DemoLoginPage } from "@/pages/DemoLoginPage"
import { WorkoutRunnerPage } from "@/pages/WorkoutRunnerPage"

// Gates the entire route tree above Shell/page level (not a useEffect-based redirect
// inside Shell, the way useOnboardingGate works) — that matters: gating one level up
// means a gated page's own data hooks never mount, and so never fire an unauthenticated
// request, before this has had a chance to redirect. On the real NAS deployment (demo
// login never enabled), this is a pure pass-through with no behavior change.
function DemoGate({ children }: { children: ReactNode }) {
  const { data: status, isPending } = useDemoStatus()
  const location = useLocation()

  // Explicit tradeoff: render nothing while the (cheap, unauthenticated) status check
  // is in flight, on every deployment, rather than defaulting to "disabled" — the
  // latter would silently let children (and their data hooks) mount for one round
  // trip even when demo mode turns out to be enabled, reintroducing the exact
  // premature-request race this gate exists to prevent.
  if (isPending) return null
  if (!status?.enabled) return <>{children}</>
  if (getDemoSession() || location.pathname === "/demo-login") return <>{children}</>
  return <Navigate to="/demo-login" replace />
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <DemoGate>
          <Routes>
            <Route path="/demo-login" element={<DemoLoginPage />} />
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route path="/workouts/:id/run" element={<WorkoutRunnerPage />} />
            <Route element={<Shell />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/goals" element={<GoalsPage />} />
              <Route path="/activities" element={<ActivitiesPage />} />
              <Route path="/insights" element={<InsightsPage />} />
              <Route path="/map" element={<MapPage />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/workouts" element={<WorkoutsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Routes>
        </DemoGate>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
