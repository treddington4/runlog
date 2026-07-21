import { QueryClientProvider } from "@tanstack/react-query"
import { BrowserRouter, Routes, Route } from "react-router-dom"
import { queryClient } from "@/lib/queryClient"
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

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/onboarding" element={<OnboardingPage />} />
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
      </BrowserRouter>
    </QueryClientProvider>
  )
}
