import { QueryClientProvider } from "@tanstack/react-query"
import { BrowserRouter, Routes, Route } from "react-router-dom"
import { Target, LineChart, Map, MessageCircle, Settings } from "lucide-react"
import { queryClient } from "@/lib/queryClient"
import { Shell } from "@/components/layout/Shell"
import { PlaceholderPage } from "@/pages/PlaceholderPage"
import { HomePage } from "@/pages/HomePage"
import { WorkoutsPage } from "@/pages/WorkoutsPage"
import { ActivitiesPage } from "@/pages/ActivitiesPage"

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/goals" element={<PlaceholderPage icon={Target} title="Goals" phase="Phase 0.9" />} />
            <Route path="/activities" element={<ActivitiesPage />} />
            <Route
              path="/insights"
              element={<PlaceholderPage icon={LineChart} title="Insights" phase="Phase 0.6" />}
            />
            <Route path="/map" element={<PlaceholderPage icon={Map} title="Map" phase="Phase 0.7" />} />
            <Route
              path="/chat"
              element={<PlaceholderPage icon={MessageCircle} title="Chat" phase="Phase 0.8" />}
            />
            <Route path="/workouts" element={<WorkoutsPage />} />
            <Route
              path="/settings"
              element={<PlaceholderPage icon={Settings} title="Settings" phase="Phase 0.9" />}
            />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
